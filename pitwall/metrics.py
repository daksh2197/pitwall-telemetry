"""Latency and recovery, measured from what the receiver actually delivered.

Latency of a frame is the time it reached the pit wall minus the time the car made it. Both
clocks are the same simulated clock here. On a real car they would not be, and a real system
has to sync them first (see docs/THE-LINK.md).

Percentiles use the nearest-rank method: sort the n values, take the value at position
ceil(p/100 * n). It always returns a number that was actually measured.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Sequence
from dataclasses import asdict, dataclass

LIVE_LAG_MS = 250  # a frame later than this counts as "not live any more"


@dataclass(frozen=True)
class Record:
    """One delivered frame, reduced to what the numbers need."""

    seq: int
    ts_us: int
    rx_us: int
    attempt: int

    @property
    def latency_ms(self) -> float:
        return (self.rx_us - self.ts_us) / 1000


def percentile(values: Sequence[float], p: float) -> float:
    if not values:
        raise ValueError("no values")
    if not 0 < p <= 100:
        raise ValueError("p must be in (0, 100]")
    ordered = sorted(values)
    rank = math.ceil(p / 100 * len(ordered))
    return ordered[rank - 1]


@dataclass(frozen=True)
class Metrics:
    frames: int
    p50_ms: float
    p95_ms: float
    max_ms: float
    longest_gap_ms: float  # the longest silence between two deliveries
    backfilled: int  # frames that arrived more than LIVE_LAG_MS after the car made them
    backfill_done_ms: float | None  # outage end to the last frame made before it arriving
    back_to_live_ms: (
        float | None
    )  # outage end to the first newly made frame arriving within LIVE_LAG_MS

    def as_dict(self) -> dict[str, float | int | None]:
        return asdict(self)


def summarize(records: Sequence[Record], outage_end_us: int | None = None) -> Metrics:
    if not records:
        raise ValueError("nothing was delivered")
    latencies = [r.latency_ms for r in records]
    by_rx = sorted(r.rx_us for r in records)
    gaps = [(b - a) / 1000 for a, b in itertools.pairwise(by_rx)]
    backfill_done: float | None = None
    back_to_live: float | None = None
    if outage_end_us is not None:
        made_before = [r.rx_us for r in records if r.ts_us < outage_end_us]
        backfill_done = max(0.0, (max(made_before) - outage_end_us) / 1000) if made_before else 0.0
        # Live again: the first frame made after the link came back that arrives on time.
        live = [
            r.rx_us for r in records if r.ts_us >= outage_end_us and r.latency_ms <= LIVE_LAG_MS
        ]
        back_to_live = max(0.0, (min(live) - outage_end_us) / 1000) if live else None
    return Metrics(
        frames=len(records),
        p50_ms=percentile(latencies, 50),
        p95_ms=percentile(latencies, 95),
        max_ms=max(latencies),
        longest_gap_ms=max(gaps) if gaps else 0.0,
        backfilled=sum(1 for r in latencies if r > LIVE_LAG_MS),
        backfill_done_ms=backfill_done,
        back_to_live_ms=back_to_live,
    )
