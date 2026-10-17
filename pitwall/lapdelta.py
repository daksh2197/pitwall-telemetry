"""Lap delta: how far ahead or behind a lap is against a reference lap, metre by metre.

This replicates the method in US 5,173,856 (Pi Research, "Vehicle data recording system",
expired 2009, status read on its Google Patents page 2026-10-17):

- The fastest lap so far becomes the datum lap.
- The engineer can veto a lap from becoming the datum, or force a slower one to be the datum
  (say the track went wet and the dry lap is no longer a fair target).
- Each new lap is compared with the datum, and the biggest speed differences are listed in
  order, labelled as corner entries and exits.

Comparing by distance, not time, is the whole trick. At 400 m into the lap both cars are at
the same place on the track, so the difference in the time they took to get there is the
delta. Comparing at the same time would compare two different places.
"""

from __future__ import annotations

import bisect
import itertools
from collections.abc import Sequence
from dataclasses import dataclass

from car.profile import Corner, Lap

SAMPLE_MS = 10  # how often a trace is sampled, the same rate as the chassis message
GRID_M = 5.0  # the delta is reported every 5 m
WINDOW_M = 60.0  # how far before a corner its entry zone starts, and after it its exit ends


@dataclass(frozen=True)
class LapTrace:
    """One lap as the logger saw it: distance from the line, elapsed time and speed."""

    name: str
    metres: tuple[float, ...]
    t_s: tuple[float, ...]
    speed_kph: tuple[float, ...]

    def __post_init__(self) -> None:
        n = len(self.metres)
        if n < 2 or len(self.t_s) != n or len(self.speed_kph) != n:
            raise ValueError(f"{self.name}: a trace needs at least two matching samples")
        if any(b <= a for a, b in itertools.pairwise(self.metres)):
            raise ValueError(f"{self.name}: distance must rise with every sample")

    @property
    def lap_s(self) -> float:
        return self.t_s[-1]

    @property
    def length_m(self) -> float:
        return self.metres[-1]

    def _interp(self, d: float, values: Sequence[float]) -> float:
        if not 0 <= d <= self.length_m:
            raise ValueError(
                f"{self.name}: {d:.1f} m is outside the lap (0 to {self.length_m:.1f})"
            )
        i = bisect.bisect_left(self.metres, d)
        if i == 0:
            return values[0]
        m0, m1 = self.metres[i - 1], self.metres[i]
        u = (d - m0) / (m1 - m0)
        return values[i - 1] + (values[i] - values[i - 1]) * u

    def time_at(self, d: float) -> float:
        return self._interp(d, self.t_s)

    def speed_at(self, d: float) -> float:
        return self._interp(d, self.speed_kph)


def trace_from_lap(lap: Lap, name: str) -> LapTrace:
    """Sample a simulated lap the way a logger would: every SAMPLE_MS, plus the finish line."""
    stamps = [*range(0, lap.lap_ms, SAMPLE_MS)]
    metres = [lap.distance_at(ms) for ms in stamps]
    t_s = [ms / 1000 for ms in stamps]
    speed = [lap.state_at(ms).speed_kph for ms in stamps]
    # Close the lap at the line so every trace covers the full length.
    if metres[-1] < lap.length_m:
        metres.append(float(lap.length_m))
        t_s.append(lap.lap_ms / 1000)
        speed.append(lap.state_at(lap.lap_ms - 1).speed_kph)
    return LapTrace(name, tuple(metres), tuple(t_s), tuple(speed))


def pick_datum(
    laps: Sequence[LapTrace], veto: frozenset[str] = frozenset(), force: str | None = None
) -> LapTrace:
    """The fastest lap not vetoed, unless the engineer forces one."""
    if force is not None:
        for lap in laps:
            if lap.name == force:
                return lap
        raise ValueError(f"no lap called {force!r} to force as the datum")
    allowed = [lap for lap in laps if lap.name not in veto]
    if not allowed:
        raise ValueError("every lap is vetoed, so there is no datum")
    return min(allowed, key=lambda lap: lap.lap_s)


def delta(current: LapTrace, datum: LapTrace, grid_m: float = GRID_M) -> list[tuple[float, float]]:
    """(metres, seconds) every grid_m along the shorter lap. Positive means behind the datum."""
    length = min(current.length_m, datum.length_m)
    out: list[tuple[float, float]] = []
    d = 0.0
    while d < length:
        out.append((d, current.time_at(d) - datum.time_at(d)))
        d += grid_m
    out.append((length, current.time_at(length) - datum.time_at(length)))
    return out


@dataclass(frozen=True)
class SpeedGap:
    where: str  # "T3 entry", "T3 exit"
    metres: float
    current_kph: float
    datum_kph: float

    @property
    def gap_kph(self) -> float:
        return self.current_kph - self.datum_kph


def _zones(corners: Sequence[Corner], length_m: float) -> list[tuple[str, float, float]]:
    zones: list[tuple[str, float, float]] = []
    for n, c in enumerate(corners, start=1):
        middle = (c.start_m + c.end_m) / 2
        zones.append((f"T{n} entry", max(0.0, c.start_m - WINDOW_M), middle))
        zones.append((f"T{n} exit", middle, min(length_m, c.end_m + WINDOW_M)))
    return zones


def biggest_gaps(
    current: LapTrace, datum: LapTrace, corners: Sequence[Corner], top: int = 5
) -> list[SpeedGap]:
    """The `top` largest speed differences, one per corner entry or exit, biggest first."""
    length = min(current.length_m, datum.length_m)
    gaps: list[SpeedGap] = []
    for label, start, end in _zones(corners, length):
        best: SpeedGap | None = None
        d = start
        while d <= end:
            g = SpeedGap(label, d, current.speed_at(d), datum.speed_at(d))
            if best is None or abs(g.gap_kph) > abs(best.gap_kph):
                best = g
            d += GRID_M / 5
        if best is not None:
            gaps.append(best)
    gaps.sort(key=lambda g: abs(g.gap_kph), reverse=True)
    return gaps[:top]


def report(current: LapTrace, datum: LapTrace, corners: Sequence[Corner]) -> str:
    rows = delta(current, datum)
    worst = max(rows, key=lambda r: r[1])
    lines = [
        f"datum   {datum.name}  {datum.lap_s:.3f} s",
        f"lap     {current.name}  {current.lap_s:.3f} s  ({current.lap_s - datum.lap_s:+.3f} s)",
        (
            f"most behind  {worst[1]:+.3f} s at {worst[0]:.0f} m"
            if worst[1] > 0
            else "ahead of the datum the whole lap"
        ),
        "",
        "biggest speed gaps against the datum",
        f"{'where':<10} {'metres':>7} {'lap km/h':>9} {'datum km/h':>11} {'gap':>7}",
    ]
    for g in biggest_gaps(current, datum, corners):
        lines.append(
            f"{g.where:<10} {g.metres:>7.0f} {g.current_kph:>9.1f} {g.datum_kph:>11.1f}"
            f" {g.gap_kph:>+7.1f}"
        )
    return "\n".join(lines)
