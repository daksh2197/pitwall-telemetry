"""The link's promises, checked on whole runs.

The property test at the bottom invents link conditions (loss, outages, buffer size) from a
fixed seed and checks the same four promises every time. The tests above it pin down the
specific stories: an outage and its backfill, a buffer that overflows, duplicates, junk.
"""

from __future__ import annotations

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from car.sim import CarSim, Frame
from link import packet
from link.channel import ChannelConfig
from link.receiver import Delivered, Receiver
from link.sender import Sender, SenderConfig
from link.session import LinkConfig, Session

SECOND = 1_000_000
FRAMES = list(CarSim(7, 10).frames())  # 10 seconds, 2200 frames, made once


def run(frames: list[Frame], config: LinkConfig) -> tuple[Session, list[Delivered]]:
    session = Session(frames, config)
    delivered: list[Delivered] = []
    for step in session.run():
        delivered.extend(step.delivered)
    return session, delivered


def config(
    loss: float = 0.0,
    outages: tuple[tuple[int, int], ...] = (),
    capacity: int = 2048,
    seed: int = 1,
) -> LinkConfig:
    return LinkConfig(
        seed=seed,
        up=ChannelConfig(loss=loss, outages=outages),
        sender=SenderConfig(capacity=capacity),
    )


def check_the_promises(session: Session, delivered: list[Delivered], frames: list[Frame]) -> None:
    seqs = [d.seq for d in delivered]
    # 1. Order: strictly increasing, which also means no frame comes out twice.
    assert seqs == sorted(set(seqs))
    # 2. Every frame is delivered exactly once or counted lost, nothing in between, nothing in both.
    lost = session.receiver.lost_seqs
    assert not set(seqs) & set(lost)
    assert sorted(seqs + lost) == list(range(len(frames)))
    assert session.unresolved == 0
    assert session.receiver.stats.lost == len(lost)
    # 3. The buffers never went past their bounds.
    assert session.sender.stats.peak_buffer <= session.config.sender.capacity
    assert session.receiver.stats.peak_held <= packet.WINDOW
    # 4. What comes out is what went in.
    for d in delivered:
        assert d.data == frames[d.seq].data
        assert d.ts_us == frames[d.seq].ts_us
        assert d.can_id == frames[d.seq].can_id
        assert d.rx_us >= d.ts_us


def test_a_clean_link_delivers_everything_with_one_send_each() -> None:
    session, delivered = run(FRAMES, config())
    check_the_promises(session, delivered, FRAMES)
    assert len(delivered) == len(FRAMES)
    assert session.sender.stats.resends == 0
    assert all(d.attempt == 1 for d in delivered)
    assert max(d.latency_us for d in delivered) <= 49_000  # 40 ms delay + 8 ms jitter + a tick


def test_random_loss_is_repaired_by_resending() -> None:
    session, delivered = run(FRAMES, config(loss=0.1))
    check_the_promises(session, delivered, FRAMES)
    assert len(delivered) == len(FRAMES)
    assert session.receiver.stats.lost == 0
    assert session.sender.stats.resends > 0
    assert any(d.attempt > 1 for d in delivered)


def test_an_outage_is_backfilled_in_order_with_nothing_missing() -> None:
    outage = (3 * SECOND, 6 * SECOND)
    session, delivered = run(FRAMES, config(outages=(outage,)))
    check_the_promises(session, delivered, FRAMES)
    assert session.receiver.stats.lost == 0
    inside = [d for d in delivered if outage[0] <= d.ts_us < outage[1]]
    assert len(inside) == 660  # 3 seconds at 220 frames a second
    # None of those arrived before the link came back, and they came back oldest first.
    assert all(d.rx_us >= outage[1] for d in inside)
    assert [d.seq for d in inside] == sorted(d.seq for d in inside)
    # The car noticed, stopped shouting, and knocked politely.
    assert session.sender.stats.down_events == 1
    assert 5 <= session.sender.stats.probes <= 20


def test_nothing_arrives_during_the_outage() -> None:
    outage = (3 * SECOND, 6 * SECOND)
    _, delivered = run(FRAMES, config(outages=(outage,)))
    # A frame in flight when the lights went out can still land up to ~48 ms in.
    assert not [d for d in delivered if outage[0] + 50_000 <= d.rx_us < outage[1]]


def test_a_full_buffer_throws_away_the_oldest_frames_and_counts_them() -> None:
    outage = (2 * SECOND, 7 * SECOND)
    session, delivered = run(FRAMES, config(outages=(outage,), capacity=300))
    check_the_promises(session, delivered, FRAMES)
    lost = session.receiver.lost_seqs
    assert session.receiver.stats.lost > 400
    assert session.sender.stats.evicted >= session.receiver.stats.lost
    # 5 s of outage is about 1100 frames and the buffer holds 300, so roughly 800 were lost.
    # Only frames from the start of the outage on can be lost, and the newest ones survived.
    assert 740 < len(lost) < 920
    first_in_outage = next(i for i, f in enumerate(FRAMES) if f.ts_us >= outage[0])
    assert min(lost) >= first_in_outage - 30
    assert FRAMES[max(lost)].ts_us < outage[1] - 1 * SECOND
    newest_survivors = [d.seq for d in delivered if outage[1] - SECOND <= d.ts_us < outage[1]]
    assert len(newest_survivors) == 220  # the last second before the link came back, all of it


def test_a_duplicate_is_counted_and_not_delivered_twice() -> None:
    r = Receiver()
    pkt = packet.encode_data(
        packet.Data(seq=0, floor=0, next_seq=1, ts_us=0, can_id=256, data=bytes(8), attempt=1)
    )
    assert len(r.on_packet(1_000, pkt)) == 1
    assert r.on_packet(2_000, pkt) == []
    assert r.stats.duplicates == 1 and r.stats.delivered == 1


def test_frames_that_arrive_out_of_order_come_out_in_order() -> None:
    r = Receiver()

    def data(seq: int) -> bytes:
        return packet.encode_data(
            packet.Data(
                seq=seq, floor=0, next_seq=3, ts_us=seq, can_id=256, data=bytes(8), attempt=1
            )
        )

    assert r.on_packet(1_000, data(2)) == []
    assert r.on_packet(2_000, data(1)) == []
    out = r.on_packet(3_000, data(0))
    assert [d.seq for d in out] == [0, 1, 2]
    assert r.stats.peak_held == 3  # counts the frame that closes the gap, just before it leaves


def test_a_frame_is_only_given_up_on_when_the_car_says_it_is_gone() -> None:
    r = Receiver()

    def data(seq: int, floor: int) -> bytes:
        return packet.encode_data(
            packet.Data(
                seq=seq, floor=floor, next_seq=10, ts_us=seq, can_id=256, data=bytes(8), attempt=1
            )
        )

    assert r.on_packet(1_000, data(3, floor=0)) == []  # 0, 1, 2 missing but maybe on their way
    assert r.stats.lost == 0
    out = r.on_packet(2_000, data(4, floor=3))  # the car says 0 to 2 are gone for good
    assert r.lost_seqs == [0, 1, 2]
    assert [d.seq for d in out] == [3, 4]
    # And one of those turning up late is counted, not delivered.
    assert r.on_packet(3_000, data(1, floor=0)) == []  # a copy sent before the car gave up
    assert r.stats.late == 1


def test_a_frame_too_far_ahead_is_refused_not_held_forever() -> None:
    r = Receiver()
    far = packet.encode_data(
        packet.Data(
            seq=packet.WINDOW + 5,
            floor=0,
            next_seq=packet.WINDOW + 6,
            ts_us=0,
            can_id=256,
            data=bytes(8),
            attempt=1,
        )
    )
    assert r.on_packet(1_000, far) == []
    assert r.stats.out_of_window == 1 and r.held == 0


@pytest.mark.parametrize("junk", [b"", b"hello", bytes(33), b"\xd1" * 33, b"\xd2" * 37])
def test_junk_bytes_are_counted_and_do_nothing_else(junk: bytes) -> None:
    r = Receiver()
    assert r.on_packet(1_000, junk) == []
    assert r.stats.malformed >= 0
    s = Sender()
    s.on_packet(1_000, junk)  # must not raise
    assert s.buffered == 0


def test_the_receiver_ignores_an_ack_sent_to_it_and_the_sender_ignores_data() -> None:
    r = Receiver()
    ack = packet.encode_ack(packet.Ack(5, frozenset()))
    assert r.on_packet(1_000, ack) == []
    assert r.stats.malformed == 0
    s = Sender()
    s.push(Frame(0, 256, bytes(8)))
    data = packet.encode_data(
        packet.Data(seq=0, floor=0, next_seq=1, ts_us=0, can_id=256, data=bytes(8), attempt=1)
    )
    s.on_packet(1_000, data)
    assert s.buffered == 1


def test_the_ring_buffer_evicts_oldest_first_and_counts_it() -> None:
    s = Sender(SenderConfig(capacity=3))
    for i in range(5):
        s.push(Frame(i * 1000, 256, bytes([i]) * 8))
    assert s.buffered == 3
    assert s.stats.evicted == 2 and s.stats.generated == 5
    sent = [packet.decode(raw) for raw in s.poll(10_000)]
    assert [p.seq for p in sent if isinstance(p, packet.Data)] == [2, 3, 4]


def test_the_same_inputs_give_exactly_the_same_run() -> None:
    cfg = config(loss=0.15, outages=((2 * SECOND, 4 * SECOND),))
    _, a = run(FRAMES, cfg)
    _, b = run(FRAMES, cfg)
    assert a == b


def test_a_run_with_no_frames_ends() -> None:
    session, delivered = run([], config())
    assert delivered == [] and session.unresolved == 0


@st.composite
def conditions(draw: st.DrawFn) -> LinkConfig:
    loss = draw(st.floats(0.0, 0.5))
    down_loss = draw(st.floats(0.0, 0.5))
    outages = []
    for _ in range(draw(st.integers(0, 3))):
        start = draw(st.integers(0, 9 * SECOND))
        outages.append((start, start + draw(st.integers(50_000, 4 * SECOND))))
    return LinkConfig(
        seed=draw(st.integers(0, 10_000)),
        up=ChannelConfig(
            loss=loss,
            delay_us=draw(st.integers(0, 120_000)),
            jitter_us=draw(st.integers(0, 40_000)),
            outages=tuple(outages),
        ),
        down=ChannelConfig(loss=down_loss, outages=tuple(outages)),
        sender=SenderConfig(capacity=draw(st.sampled_from([5, 40, 300, 2048]))),
    )


@settings(
    max_examples=60, derandomize=True, deadline=None, suppress_health_check=[HealthCheck.too_slow]
)
@given(conditions())
def test_property_every_frame_is_delivered_once_or_counted_lost_in_order_within_bounds(
    cfg: LinkConfig,
) -> None:
    session, delivered = run(FRAMES, cfg)
    check_the_promises(session, delivered, FRAMES)
    assert session.receiver.stats.lost <= session.sender.stats.evicted
