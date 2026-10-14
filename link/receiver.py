"""The pit wall's end of the link: put frames back in order, once each, and say what arrived.

The promise to whoever reads the output of `Receiver.on_packet`:

* Frames come out in sequence order. Never out of order.
* Each frame comes out at most once. A second copy is counted and thrown away.
* A frame that never comes out is counted as lost, and only when the car has said it can
  no longer send it (its `floor` moved past it). The receiver never guesses.

The price of that promise is that one missing frame holds back everything after it until it
arrives or is declared lost. That is head-of-line blocking, and it shows up in the latency numbers.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from link import packet

REORDER_HOLD_US = 10_000  # a frame must have been here this long before an ack mentions it


@dataclass(frozen=True)
class Delivered:
    seq: int
    ts_us: int  # when the car generated it
    rx_us: int  # when the pit wall handed it on
    can_id: int
    data: bytes
    attempt: int  # which transmission of the frame got through first (1 means no resend was needed)

    @property
    def latency_us(self) -> int:
        return self.rx_us - self.ts_us


@dataclass
class ReceiverStats:
    delivered: int = 0
    lost: int = 0
    duplicates: int = 0  # extra copies of a frame already delivered or held
    late: int = 0  # copies that arrived after the frame was already given up on
    out_of_window: int = 0  # too far ahead to hold; the car will send it again
    malformed: int = 0  # bytes that were not a packet at all
    peak_held: int = 0  # most frames held back waiting for a gap to fill
    acks_sent: int = 0


@dataclass
class _Held:
    data: packet.Data
    rx_us: int


@dataclass
class Receiver:
    ack_interval_us: int = 20_000
    ack_interval_gap_us: int = 10_000  # faster acks while a gap is open
    idle_ack_us: int = 100_000
    stats: ReceiverStats = field(default_factory=ReceiverStats)
    lost_seqs: list[int] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.next_expected = 0
        self.sender_next_seq = 0  # the car's latest "next number", from packet headers
        self.last_rx_us = 0
        self._floor = 0
        self._held: dict[int, _Held] = {}
        self._lost: set[int] = set()
        self._ack_due = False
        self._last_ack_us = 0

    # ----- bytes in, frames out -----

    def on_packet(self, now_us: int, raw: bytes) -> list[Delivered]:
        try:
            pkt = packet.decode(raw)
        except packet.PacketError:
            self.stats.malformed += 1
            return []
        self.last_rx_us = now_us
        if isinstance(pkt, packet.Ack):
            return []  # acks flow the other way; one arriving here is junk
        self._floor = max(self._floor, pkt.floor)
        self.sender_next_seq = max(self.sender_next_seq, pkt.next_seq)
        self._ack_due = True
        if isinstance(pkt, packet.Data):
            self._accept(now_us, pkt)
        return self._advance(now_us)

    def _accept(self, now_us: int, pkt: packet.Data) -> None:
        seq = pkt.seq
        if seq in self._lost:
            self.stats.late += 1
        elif seq < self.next_expected or seq in self._held:
            self.stats.duplicates += 1
        elif seq >= self.next_expected + packet.WINDOW:
            self.stats.out_of_window += 1
        else:
            self._held[seq] = _Held(pkt, now_us)
            self.stats.peak_held = max(self.stats.peak_held, len(self._held))

    def _advance(self, now_us: int) -> list[Delivered]:
        out: list[Delivered] = []
        while True:
            held = self._held.pop(self.next_expected, None)
            if held is not None:
                d = held.data
                out.append(Delivered(d.seq, d.ts_us, now_us, d.can_id, d.data, d.attempt))
                self.stats.delivered += 1
            elif self.next_expected < self._floor:
                # The car says this one is gone for good, and we do not have it.
                self._lost.add(self.next_expected)
                self.lost_seqs.append(self.next_expected)
                self.stats.lost += 1
            else:
                break
            self.next_expected += 1
        return out

    # ----- acks out -----

    def poll(self, now_us: int) -> list[bytes]:
        gap_open = bool(self._held)
        interval = self.ack_interval_gap_us if gap_open else self.ack_interval_us
        due = (self._ack_due and now_us - self._last_ack_us >= interval) or (
            now_us - self._last_ack_us >= self.idle_ack_us
        )
        if not due:
            return []
        self._ack_due = False
        self._last_ack_us = now_us
        self.stats.acks_sent += 1
        seen = frozenset(
            seq for seq, h in self._held.items() if now_us - h.rx_us >= REORDER_HOLD_US
        )
        return [packet.encode_ack(packet.Ack(self.next_expected, seen))]

    @property
    def held(self) -> int:
        return len(self._held)

    @property
    def behind(self) -> int:
        """How many frames the car has made that the pit wall has not yet resolved."""
        return max(0, self.sender_next_seq - self.next_expected)
