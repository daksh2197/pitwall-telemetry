"""The whole pipeline in one place: car, link, decoder, and the messages the pit wall sends.

`Pipeline.messages()` is the single source of what the dashboard sees. The live server sends
these messages over a WebSocket as the simulated clock catches up with the real one. The
recorder writes the same messages to a file, and the dashboard replays that file. There is
no second implementation anywhere.

Message shapes (JSON):

    {"type": "hello", "v": 1, "meta": {...}}
    {"type": "batch", "rx_ms": 1250, "samples": [...], "link": {...}}      every 50 ms
    {"type": "end", "rx_ms": 40213, "summary": {...}}

    sample = {"seq": 8, "ts": 30, "rx": 74, "id": 257, "tx": 1, "v": {"Speed": 212.3, ...}}
      seq  the link's sequence number          tx  which send got through (2 or more = resent)
      ts   when the car made it (ms)           rx  when the pit wall delivered it (ms)
"""

from __future__ import annotations

from collections.abc import Generator
from dataclasses import dataclass, field
from typing import Any

from car.sim import FRAMES_PER_SECOND, CarSim
from link.channel import ChannelConfig
from link.receiver import Delivered
from link.sender import SenderConfig
from link.session import LinkConfig, Session
from pitwall.decode import Decoder
from pitwall.metrics import Metrics, Record, summarize

BATCH_MS = 50
PROTOCOL_VERSION = 1


@dataclass(frozen=True)
class RunConfig:
    seed: int = 2026
    duration_s: float = 40.0
    loss: float = 0.0
    delay_ms: int = 40
    jitter_ms: int = 8
    outages_s: tuple[tuple[float, float], ...] = ()
    buffer: int = 2048

    def link_config(self) -> LinkConfig:
        channel = ChannelConfig(
            loss=self.loss,
            delay_us=self.delay_ms * 1000,
            jitter_us=self.jitter_ms * 1000,
            outages=tuple((round(a * 1e6), round(b * 1e6)) for a, b in self.outages_s),
        )
        return LinkConfig(seed=self.seed, up=channel, sender=SenderConfig(capacity=self.buffer))

    @property
    def last_outage_end_us(self) -> int | None:
        return round(max(b for _, b in self.outages_s) * 1e6) if self.outages_s else None


@dataclass
class Pipeline:
    config: RunConfig
    decoder: Decoder = field(default_factory=Decoder)
    records: list[Record] = field(default_factory=list)
    session: Session | None = None

    def meta(self, source: str) -> dict[str, Any]:
        c = self.config
        return {
            "source": source,
            "seed": c.seed,
            "duration_s": c.duration_s,
            "loss": c.loss,
            "delay_ms": c.delay_ms,
            "jitter_ms": c.jitter_ms,
            "outages_s": [list(o) for o in c.outages_s],
            "buffer": c.buffer,
            "batch_ms": BATCH_MS,
            "frames_per_second": FRAMES_PER_SECOND,
            "messages": {str(k): v for k, v in self.decoder.message_names().items()},
            "signals": self.decoder.signal_info(),
        }

    def _sample(self, d: Delivered) -> dict[str, Any] | None:
        values = self.decoder.decode(d.can_id, d.data)
        if values is None:
            return None
        return {
            "seq": d.seq,
            "ts": d.ts_us // 1000,
            "rx": d.rx_us // 1000,
            "id": d.can_id,
            "tx": d.attempt,
            "v": values,
        }

    def _link_snapshot(self) -> dict[str, int]:
        assert self.session is not None
        r = self.session.receiver
        return {
            "delivered": r.stats.delivered,
            "lost": r.stats.lost,
            "duplicates": r.stats.duplicates,
            "late": r.stats.late,
            "malformed": r.stats.malformed,
            "held": r.held,
            "behind": r.behind,
        }

    def messages(self, source: str = "recorded replay") -> Generator[dict[str, Any], None, None]:
        c = self.config
        car = CarSim(c.seed, c.duration_s)
        self.session = Session(car.frames(), c.link_config())
        yield {"type": "hello", "v": PROTOCOL_VERSION, "meta": self.meta(source)}
        window: list[dict[str, Any]] = []
        last_ms = 0
        for step in self.session.run():
            last_ms = step.now_us // 1000
            for d in step.delivered:
                self.records.append(Record(d.seq, d.ts_us, d.rx_us, d.attempt))
                sample = self._sample(d)
                if sample is not None:
                    window.append(sample)
            if (last_ms + 1) % BATCH_MS == 0:
                yield {
                    "type": "batch",
                    "rx_ms": last_ms + 1,
                    "samples": window,
                    "link": self._link_snapshot(),
                }
                window = []
        if window:
            yield {
                "type": "batch",
                "rx_ms": last_ms + 1,
                "samples": window,
                "link": self._link_snapshot(),
            }
        yield {"type": "end", "rx_ms": last_ms + 1, "summary": self.summary()}

    def summary(self) -> dict[str, Any]:
        assert self.session is not None
        s = self.session
        out: dict[str, Any] = {
            "generated": s.generated,
            "delivered": s.receiver.stats.delivered,
            "lost": s.receiver.stats.lost,
            "unresolved": s.unresolved,
        }
        if self.records:
            out["metrics"] = summarize(self.records, self.config.last_outage_end_us).as_dict()
        return out

    def run_to_end(self) -> Metrics:
        """Run silently and return the numbers. For tests and the results table."""
        for _ in self.messages():
            pass
        return summarize(self.records, self.config.last_outage_end_us)
