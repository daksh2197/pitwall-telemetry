from __future__ import annotations

import pytest

from link.channel import Channel, ChannelConfig


def drain(ch: Channel, until_us: int) -> list[bytes]:
    return ch.poll(until_us)


def test_a_perfect_link_delivers_everything_after_the_delay() -> None:
    ch = Channel(ChannelConfig(loss=0, delay_us=40_000, jitter_us=0), seed=1)
    ch.send(0, b"a")
    assert ch.poll(39_999) == []
    assert ch.poll(40_000) == [b"a"]


def test_loss_rate_is_close_to_what_was_asked_for() -> None:
    ch = Channel(ChannelConfig(loss=0.2, jitter_us=0), seed=3)
    for i in range(20_000):
        ch.send(i, b"x")
    got = len(ch.poll(10**9))
    assert 0.78 < got / 20_000 < 0.82
    assert ch.stats.lost_random + got == 20_000


def test_everything_sent_during_an_outage_is_lost_and_after_it_is_not() -> None:
    ch = Channel(ChannelConfig(delay_us=1_000, jitter_us=0, outages=((10_000, 20_000),)), seed=1)
    for t in (5_000, 10_000, 15_000, 19_999, 20_000, 25_000):
        ch.send(t, str(t).encode())
    assert ch.poll(10**9) == [b"5000", b"20000", b"25000"]
    assert ch.stats.lost_outage == 3


def test_a_packet_that_would_land_inside_an_outage_is_lost_too() -> None:
    ch = Channel(ChannelConfig(delay_us=5_000, jitter_us=0, outages=((10_000, 20_000),)), seed=1)
    ch.send(8_000, b"in the air when the lights go out")
    assert ch.poll(10**9) == []


def test_jitter_can_swap_two_packets() -> None:
    ch = Channel(ChannelConfig(delay_us=1_000, jitter_us=8_000), seed=2)
    for i in range(200):
        ch.send(i * 1_000, i.to_bytes(2, "big"))
    order = [int.from_bytes(p, "big") for p in ch.poll(10**9)]
    assert sorted(order) == list(range(200))
    assert order != sorted(order)


def test_same_seed_same_luck_and_a_different_seed_differs() -> None:
    def run(seed: int) -> list[bytes]:
        ch = Channel(ChannelConfig(loss=0.3), seed=seed)
        for i in range(500):
            ch.send(i * 1_000, i.to_bytes(2, "big"))
        return ch.poll(10**9)

    assert run(5) == run(5)
    assert run(5) != run(6)


def test_changing_the_loss_does_not_reshuffle_the_delays() -> None:
    def arrival_order(loss: float) -> list[int]:
        ch = Channel(ChannelConfig(loss=loss), seed=9)
        for i in range(300):
            ch.send(i * 1_000, i.to_bytes(2, "big"))
        return [int.from_bytes(p, "big") for p in ch.poll(10**9)]

    low, high = arrival_order(0.0), arrival_order(0.2)
    kept = [x for x in low if x in set(high)]
    assert kept == high  # the survivors arrive in the same relative order


@pytest.mark.parametrize(
    "kwargs",
    [
        {"loss": -0.1},
        {"loss": 1.1},
        {"delay_us": -1},
        {"jitter_us": -1},
        {"outages": ((5, 5),)},
        {"outages": ((-1, 5),)},
    ],
)
def test_nonsense_settings_are_refused(kwargs: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        ChannelConfig(**kwargs)  # type: ignore[arg-type]
