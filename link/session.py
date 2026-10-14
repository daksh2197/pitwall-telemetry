"""Car, radio and pit wall wired together, run on a simulated clock.

The clock ticks once per millisecond and never looks at the real time, so a 60-second run
takes about a second and gives the same answer on every machine.

Each tick, in this order:
    1. the car hands over any frames it made in this millisecond
    2. the car sends what it is allowed to send
    3. the radio delivers what has arrived at the pit wall, which hands frames on
    4. the pit wall sends any acks
    5. the radio delivers acks to the car
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field

from car.sim import Frame
from link.channel import Channel, ChannelConfig, ChannelStats
from link.receiver import Delivered, Receiver, ReceiverStats
from link.sender import Sender, SenderConfig, SenderStats

TICK_US = 1_000
DEFAULT_DRAIN_US = 120_000_000  # give up waiting for stragglers after two simulated minutes


@dataclass(frozen=True)
class LinkConfig:
    seed: int = 1
    up: ChannelConfig = field(default_factory=ChannelConfig)  # car to pit wall
    down: ChannelConfig | None = None  # pit wall to car; the same as `up` when left out
    sender: SenderConfig = field(default_factory=SenderConfig)


@dataclass(frozen=True)
class Step:
    """The state of the world after one tick."""

    now_us: int
    delivered: list[Delivered]


class Session:
    def __init__(
        self, frames: Iterable[Frame], config: LinkConfig, drain_us: int = DEFAULT_DRAIN_US
    ):
        self.config = config
        self._frames = iter(frames)
        self.drain_us = drain_us
        self.sender = Sender(config.sender)
        self.receiver = Receiver()
        self.up = Channel(config.up, seed=config.seed * 2)
        self.down = Channel(config.down or config.up, seed=config.seed * 2 + 1)
        self.generated = 0
        self.last_frame_us = 0
        self.now_us = 0
        self.finished_us: int | None = None

    def run(self) -> Iterator[Step]:
        """Run to the end, yielding after every tick. Stops once every frame is resolved
        (delivered or counted lost), or after the drain time runs out."""
        pending = next(self._frames, None)
        generation_done = False
        now = 0
        while True:
            self.now_us = now
            while pending is not None and pending.ts_us <= now:
                self.sender.push(pending)
                self.generated += 1
                self.last_frame_us = pending.ts_us
                pending = next(self._frames, None)
            if pending is None:
                generation_done = True

            for raw in self.sender.poll(now):
                self.up.send(now, raw)
            delivered: list[Delivered] = []
            for raw in self.up.poll(now):
                delivered.extend(self.receiver.on_packet(now, raw))
            for raw in self.receiver.poll(now):
                self.down.send(now, raw)
            for raw in self.down.poll(now):
                self.sender.on_packet(now, raw)

            yield Step(now, delivered)

            if generation_done:
                resolved = self.receiver.stats.delivered + self.receiver.stats.lost
                if resolved >= self.generated:
                    self.finished_us = now
                    return
                if now - self.last_frame_us > self.drain_us:
                    return
            now += TICK_US

    @property
    def unresolved(self) -> int:
        """Frames neither delivered nor counted lost. Zero after a run that drained."""
        return self.generated - self.receiver.stats.delivered - self.receiver.stats.lost


@dataclass(frozen=True)
class SessionStats:
    sender: SenderStats
    receiver: ReceiverStats
    up: ChannelStats
    down: ChannelStats

    @staticmethod
    def of(s: Session) -> SessionStats:
        return SessionStats(s.sender.stats, s.receiver.stats, s.up.stats, s.down.stats)
