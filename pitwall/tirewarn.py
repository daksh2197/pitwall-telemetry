"""Soft-tire warning from the four wheel speeds, with no pressure sensor.

A tire that loses pressure squashes a little, its rolling radius shrinks, and it has to spin
faster to keep up with the car. This replicates the method in US 4,876,528 (SP Tyres UK,
"Method of detecting a deflated tyre on a vehicle", expired 2008-05-13, status read on its
Google Patents page 2026-10-17):

- Compare the sums of the diagonal pairs (front-left + rear-right against front-right +
  rear-left). One soft tire upsets that balance; a corner, which speeds up both outside
  wheels, mostly does not.
- Compare each wheel with the average of all four. The patent flags a wheel more than 0.1%
  off.
- Warn only when both say so, and stop looking while the car is cornering or accelerating
  hard, because then the wheels disagree for honest reasons.

The diagonal window, the g limits and the hold time below are this repo's settings, not
numbers from the patent. Standard OBD-II does not give per-wheel speeds; a real car needs a
CAN source (ABS module). `drive` makes a made-up run to test against.
"""

from __future__ import annotations

import math
import random
from collections.abc import Sequence
from dataclasses import dataclass

WHEELS = ("FL", "FR", "RL", "RR")
RATE_HZ = 50
WHEEL_OFF = 0.001  # the patent's 0.1%
DIAG_MIN, DIAG_MAX = 0.0005, 0.006  # diagonal imbalance that looks like one soft tire
AY_LIMIT_G = 0.15
AX_LIMIT_G = 0.15
HOLD_S = 2.0  # both tests must agree this long before a warning


@dataclass(frozen=True)
class Sample:
    t: float
    w: tuple[float, float, float, float]  # wheel speeds, rad/s, in WHEELS order
    ax_g: float
    ay_g: float


@dataclass(frozen=True)
class Scenario:
    speed_ms: float = 30.0
    radius_m: float = 0.31
    track_m: float = 1.6
    soft: str | None = "FL"  # which tire goes soft, or None
    soft_at_s: float = 20.0
    radius_loss: float = 0.004  # fraction of rolling radius lost when soft
    corner_radius_m: float = 120.0
    corners: tuple[tuple[float, float], ...] = ((8.0, 14.0), (30.0, 36.0))  # (start, end) s
    duration_s: float = 45.0
    noise: float = 0.0002  # per-sample speed noise as a fraction
    seed: int = 5


def drive(sc: Scenario) -> list[Sample]:
    rng = random.Random(sc.seed)
    out: list[Sample] = []
    n = round(sc.duration_s * RATE_HZ)
    for k in range(n):
        t = k / RATE_HZ
        cornering = any(a <= t < b for a, b in sc.corners)
        # Left-hand corners: the right side runs the longer path.
        lean = sc.track_m / (2 * sc.corner_radius_m) if cornering else 0.0
        ay = sc.speed_ms**2 / sc.corner_radius_m / 9.81 if cornering else 0.0
        side = (-lean, +lean, -lean, +lean)
        w = []
        for name, s in zip(WHEELS, side, strict=True):
            r = sc.radius_m
            if sc.soft == name and t >= sc.soft_at_s:
                r *= 1 - sc.radius_loss
            w.append(sc.speed_ms * (1 + s) / r * (1 + rng.gauss(0, sc.noise)))
        out.append(Sample(t, (w[0], w[1], w[2], w[3]), 0.0, ay))
    return out


@dataclass(frozen=True)
class Check:
    diagonal: float  # (FL + RR - FR - RL) / mean of the two sums
    offsets: tuple[float, float, float, float]  # each wheel against the four-wheel mean
    suspect: str | None  # the wheel both tests point at, if any
    suspended: bool


def check(s: Sample, suspend: bool = True) -> Check:
    fl, fr, rl, rr = s.w
    d1, d2 = fl + rr, fr + rl
    diagonal = (d1 - d2) / ((d1 + d2) / 2)
    mean = sum(s.w) / 4
    offsets = tuple(w / mean - 1 for w in s.w)
    suspended = suspend and (abs(s.ay_g) > AY_LIMIT_G or abs(s.ax_g) > AX_LIMIT_G)
    suspect: str | None = None
    if not suspended and DIAG_MIN <= abs(diagonal) <= DIAG_MAX:
        worst = max(range(4), key=lambda i: offsets[i])
        # A soft tire spins fast, and it has to sit on the diagonal that reads high.
        on_high_diagonal = (worst in (0, 3)) == (diagonal > 0)
        if offsets[worst] > WHEEL_OFF and on_high_diagonal:
            suspect = WHEELS[worst]
    return Check(diagonal, (offsets[0], offsets[1], offsets[2], offsets[3]), suspect, suspended)


@dataclass(frozen=True)
class Warning:
    t: float
    wheel: str


def monitor(samples: Sequence[Sample], suspend: bool = True) -> list[Warning]:
    """Warnings raised over a run, one per wheel per episode.

    Each wheel keeps a score: up one for every sample that points at it, down one for every
    sample that doesn't. A warning fires when the score reaches HOLD_S worth of samples, and
    the wheel can only warn again after its score has fallen back to zero. One noisy sample
    neither raises nor clears anything.
    """
    need = math.ceil(HOLD_S * RATE_HZ)
    score = dict.fromkeys(WHEELS, 0)
    raised = dict.fromkeys(WHEELS, False)
    warnings: list[Warning] = []
    for s in samples:
        c = check(s, suspend)
        if c.suspended:
            continue  # cornering neither proves nor clears a soft tire
        for wheel in WHEELS:
            if wheel == c.suspect:
                score[wheel] = min(score[wheel] + 1, need)
            else:
                score[wheel] = max(score[wheel] - 1, 0)
            if score[wheel] >= need and not raised[wheel]:
                warnings.append(Warning(s.t, wheel))
                raised[wheel] = True
            elif score[wheel] == 0:
                raised[wheel] = False
    return warnings


def report() -> str:
    rows = [
        ("healthy, corners", Scenario(soft=None), True),
        ("FL soft in a corner", Scenario(soft="FL", soft_at_s=9.0), True),
        ("FL soft at 20 s", Scenario(soft="FL"), True),
        ("RR soft at 20 s", Scenario(soft="RR"), True),
        ("FR soft, 0.2% loss", Scenario(soft="FR", radius_loss=0.002), True),
    ]
    lines = [
        "45 s at 108 km/h, two 120 m corners, 0.02% speed noise",
        "",
        f"{'run':<22} {'warnings':<30}",
    ]
    for name, sc, suspend in rows:
        ws = monitor(drive(sc), suspend)
        text = ", ".join(f"{w.wheel} at {w.t:.1f} s" for w in ws) or "none"
        lines.append(f"{name:<22} {text:<30}")
    return "\n".join(lines)
