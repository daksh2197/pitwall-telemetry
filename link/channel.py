"""A bad radio link, one direction.

It loses packets at random, delays every packet by a base time plus a random jitter, and goes
dark for whole stretches (outages). Jitter can put two packets in the wrong order, which is
the point: the protocol on top has to cope.

A packet is lost if it is sent during an outage, or would arrive during one. Everything is
decided at send time from a seeded random generator, so a run is the same every time.
"""

from __future__ import annotations

import heapq
import random
from dataclasses import dataclass, field


@dataclass(frozen=True)
class ChannelConfig:
    loss: float = 0.0  # chance each packet is lost, 0 to 1
    delay_us: int = 40_000  # time in the air, before jitter
    jitter_us: int = 8_000  # a random extra delay between 0 and this
    outages: tuple[tuple[int, int], ...] = ()  # (start, end) in microseconds, end not included

    def __post_init__(self) -> None:
        if not 0.0 <= self.loss <= 1.0:
            raise ValueError(f"loss must be between 0 and 1, got {self.loss}")
        if self.delay_us < 0 or self.jitter_us < 0:
            raise ValueError("delay and jitter cannot be negative")
        for start, end in self.outages:
            if start < 0 or end <= start:
                raise ValueError(f"outage ({start}, {end}) must have 0 <= start < end")

    def in_outage(self, t_us: int) -> bool:
        return any(start <= t_us < end for start, end in self.outages)


@dataclass
class ChannelStats:
    sent: int = 0
    lost_random: int = 0
    lost_outage: int = 0
    delivered: int = 0


@dataclass
class Channel:
    config: ChannelConfig
    seed: int
    stats: ChannelStats = field(default_factory=ChannelStats)

    def __post_init__(self) -> None:
        self._rng = random.Random(self.seed)
        self._in_flight: list[tuple[int, int, bytes]] = []  # (arrival, order sent, payload)
        self._counter = 0

    def send(self, now_us: int, payload: bytes) -> None:
        cfg = self.config
        self.stats.sent += 1
        # Always draw the same random numbers per packet, so changing one setting does not
        # reshuffle luck for every packet that follows.
        loss_roll = self._rng.random()
        jitter = self._rng.randint(0, cfg.jitter_us) if cfg.jitter_us else 0
        arrival = now_us + cfg.delay_us + jitter
        if cfg.in_outage(now_us) or cfg.in_outage(arrival):
            self.stats.lost_outage += 1
            return
        if loss_roll < cfg.loss:
            self.stats.lost_random += 1
            return
        self._counter += 1
        heapq.heappush(self._in_flight, (arrival, self._counter, payload))

    def poll(self, now_us: int) -> list[bytes]:
        """Everything that has arrived by `now_us`, earliest first."""
        out: list[bytes] = []
        while self._in_flight and self._in_flight[0][0] <= now_us:
            out.append(heapq.heappop(self._in_flight)[2])
            self.stats.delivered += 1
        return out

    def pending(self) -> int:
        return len(self._in_flight)
