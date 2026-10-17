"""A made-up lap, driven by a simple model.

No real circuit, no real car, no real driver. A seed picks six corners and how hard the
driver takes each one. From that the module works out, millisecond by millisecond, what the
sensors would read: speed, throttle, brake, steering, gear, revs and coolant temperature.

The method is the classic one for a lap-time sketch:

1. Put a speed cap on every metre of track (top speed on the straights, the apex speed in a corner).
2. Sweep forward so the car never accelerates faster than it can.
3. Sweep backward so it is never going faster than it can still brake from.
4. Drive the lap through time: the car is exactly on the cap, which now respects both limits.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, replace

TOP_SPEED_MS = 290 / 3.6  # the cap on straights, in metres per second
ACCEL_MS2 = 6.0  # most the car can accelerate, metres per second squared
BRAKE_MS2 = 20.0  # brake pressure reads 100 percent at this deceleration (about 2 g)
BRAKING_USED_MS2 = 16.0  # the driver plans to brake at 80 percent of that, not the limit
STEP_M = 1.0  # track resolution
RPM_IDLE = 3500.0
RPM_LIMIT = 11500.0
# Speed in km/h at the rev limit in each gear, first to seventh.
GEAR_TOP_KPH = (75.0, 110.0, 150.0, 190.0, 230.0, 265.0, 300.0)
STATE_DT_MS = 1  # the lap is worked out at 1 ms steps


@dataclass(frozen=True)
class Corner:
    start_m: float
    end_m: float
    apex_kph: float
    direction: int  # +1 right, -1 left


@dataclass(frozen=True)
class State:
    """What the sensors read at one instant."""

    speed_kph: float
    throttle_pct: float
    brake_pct: float
    steering_deg: float
    gear: int
    rpm: float
    coolant_c: int


def gear_for(speed_kph: float, previous: int) -> int:
    """Pick a gear for this speed, with a gap between up-shift and down-shift points.

    Without the gap the car would flick between two gears at one speed.
    """
    gear = min(max(previous, 1), len(GEAR_TOP_KPH))
    while gear < len(GEAR_TOP_KPH) and speed_kph > 0.97 * GEAR_TOP_KPH[gear - 1]:
        gear += 1
    while gear > 1 and speed_kph < 0.80 * GEAR_TOP_KPH[gear - 2]:
        gear -= 1
    return gear


def rpm_for(speed_kph: float, gear: int) -> float:
    """Revs in a gear: idle at standstill, the limit at that gear's top speed."""
    top = GEAR_TOP_KPH[gear - 1]
    return RPM_IDLE + (RPM_LIMIT - RPM_IDLE) * min(speed_kph / top, 1.0)


class Lap:
    """One lap, worked out in advance from a seed. Looping past the end starts the next lap.

    `pace` scales every apex speed, so 0.97 is the same track driven a little slower through
    the corners. The track itself (where the corners are, how long they are) only depends on
    the seed, which is what lets two laps be compared metre by metre.
    """

    def __init__(self, seed: int, pace: float = 1.0) -> None:
        if not 0.5 <= pace <= 1.2:
            raise ValueError(f"pace must be between 0.5 and 1.2, got {pace}")
        rng = random.Random(seed)
        self.seed = seed
        self.pace = pace
        self.corners = [replace(c, apex_kph=c.apex_kph * pace) for c in self._pick_corners(rng)]
        self.length_m = int(self.corners[-1].end_m + rng.uniform(150, 250))
        self._cap = self._speed_caps()
        self._metres: list[float] = []
        self._states = self._drive(random.Random(seed + 1))
        self.lap_ms = len(self._states)

    @staticmethod
    def _pick_corners(rng: random.Random) -> list[Corner]:
        corners: list[Corner] = []
        position = rng.uniform(300, 420)  # a run from the line to the first corner
        for _ in range(6):
            length = rng.uniform(70, 170)
            apex = rng.uniform(80, 170)
            corners.append(Corner(position, position + length, apex, rng.choice((-1, 1))))
            position += length + rng.uniform(140, 360)  # the straight after it
        return corners

    def _speed_caps(self) -> list[float]:
        n = int(self.length_m / STEP_M)
        cap = [TOP_SPEED_MS * TOP_SPEED_MS] * n  # squared, so the sweeps are simple sums
        for c in self.corners:
            apex = (c.apex_kph / 3.6) ** 2
            for i in range(int(c.start_m / STEP_M), min(n, int(c.end_m / STEP_M) + 1)):
                cap[i] = min(cap[i], apex)
        # Two passes around the loop so the end of the lap joins up with the start.
        for _ in range(2):
            for i in range(1, 2 * n):
                a, b = (i - 1) % n, i % n
                cap[b] = min(cap[b], cap[a] + 2 * ACCEL_MS2 * STEP_M)
            for i in range(2 * n - 1, 0, -1):
                a, b = i % n, (i - 1) % n
                cap[b] = min(cap[b], cap[a] + 2 * BRAKING_USED_MS2 * STEP_M)
        return [math.sqrt(v) for v in cap]

    def _speed_at(self, metres: float) -> float:
        n = len(self._cap)
        x = (metres % (n * STEP_M)) / STEP_M
        i = int(x)
        frac = x - i
        return self._cap[i % n] * (1 - frac) + self._cap[(i + 1) % n] * frac

    def _steering_at(self, metres: float) -> float:
        for c in self.corners:
            if c.start_m <= metres <= c.end_m:
                u = (metres - c.start_m) / (c.end_m - c.start_m)
                peak = 40 + 160 * (1 - c.apex_kph / 290)
                return c.direction * peak * math.sin(math.pi * u) ** 2
        return 0.0

    def _drive(self, rng: random.Random) -> list[State]:
        # Pass 1: where is the car at every millisecond?
        dt = STATE_DT_MS / 1000
        metres = 0.0
        track: list[tuple[float, float]] = []  # (metres, metres per second)
        while metres < self.length_m:
            v = self._speed_at(metres)
            track.append((metres, v))
            metres += v * dt
        self._metres = [m for m, _ in track]
        # Pass 2: turn position and speed into sensor readings.
        states: list[State] = []
        gear = 1
        look = 5  # steps either side for the acceleration estimate
        for k, (m, v) in enumerate(track):
            v_after = track[min(k + look, len(track) - 1)][1]
            v_before = track[max(k - look, 0)][1]
            span = (min(k + look, len(track) - 1) - max(k - look, 0)) * dt
            accel = (v_after - v_before) / span if span > 0 else 0.0
            kph = v * 3.6
            cruise = 100 * 0.75 * (v / TOP_SPEED_MS) ** 2
            if accel < -0.5:
                throttle = 0.0
            else:
                throttle = cruise + (100 - cruise) * max(0.0, min(accel / ACCEL_MS2, 1.0))
            brake = max(0.0, min(-accel / BRAKE_MS2, 1.0)) * 100 if accel < -0.5 else 0.0
            gear = gear_for(kph, gear)
            rpm = rpm_for(kph, gear)
            states.append(
                State(
                    speed_kph=max(0.0, kph + rng.gauss(0, 0.1)),
                    throttle_pct=max(0.0, min(100.0, throttle + rng.gauss(0, 0.3))),
                    brake_pct=max(0.0, min(100.0, brake + (rng.gauss(0, 0.3) if brake else 0.0))),
                    steering_deg=self._steering_at(m) + rng.gauss(0, 0.2),
                    gear=gear,
                    rpm=max(0.0, rpm + rng.gauss(0, 8)),
                    coolant_c=round(84 + 6 * min(k / 40000, 1.0) + rng.gauss(0, 0.3)),
                )
            )
        return states

    def state_at(self, ms: int) -> State:
        """The sensor readings `ms` milliseconds after the start. Past the end, the next lap."""
        return self._states[ms % self.lap_ms]

    def distance_at(self, ms: int) -> float:
        """Metres from the line `ms` milliseconds into this lap (0 to lap_ms - 1)."""
        return self._metres[ms]
