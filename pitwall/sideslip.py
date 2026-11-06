"""Sideslip from GPS velocity and a yaw-rate gyro.

Sideslip is the angle between where the car points and where it is actually going. A race
car on the limit runs a few degrees of it, and nothing on the car measures it directly.

This replicates the method in US 6,681,180 (Stanford, "Determination and control of vehicle
sideslip using GPS", expired 2022-01-29, status read on its Google Patents page 2026-10-17):

- GPS gives the velocity of the antenna, so it knows where the car is going.
- A yaw gyro, integrated, gives where the car points.
- Sideslip at the antenna is the angle between the two. Moving it to the centre of gravity
  uses the yaw rate and where the antenna sits on the car.
- GPS answers late. The heading has to be taken at the moment the GPS measured, not the
  moment its answer arrived, or the latency turns straight into sideslip error.

Flat track, x and y in metres, angles counter-clockwise from the x axis, body x forward and
body y to the left. There is no real car here: `drive` makes a truth run to test against.
"""

from __future__ import annotations

import bisect
import math
import random
from dataclasses import dataclass

GYRO_HZ = 100
GPS_HZ = 10


@dataclass(frozen=True)
class Setup:
    speed_ms: float = 30.0
    radius_m: float = 80.0
    beta_deg: float = -4.0  # steady-state sideslip at the CG in the corner
    straight_s: float = 4.0  # time on the straight before turn-in
    turn_in_s: float = 1.0  # how long turn-in takes
    corner_s: float = 6.0
    antenna_x_m: float = 1.2  # antenna ahead of the CG
    antenna_y_m: float = 0.0
    gps_latency_s: float = 0.05
    gps_noise_ms: float = 0.03  # velocity noise per axis
    gyro_bias_dps: float = 0.5
    gyro_noise_dps: float = 0.05
    seed: int = 3


@dataclass(frozen=True)
class Truth:
    t: float
    heading: float  # radians
    yaw_rate: float  # radians per second
    beta_cg: float  # radians


@dataclass(frozen=True)
class GpsFix:
    t_arrived: float
    t_measured: float  # what the receiver stamps; arrival minus latency
    vx: float
    vy: float


@dataclass(frozen=True)
class Run:
    setup: Setup
    truth: list[Truth]  # at the gyro rate
    gyro: list[tuple[float, float]]  # (t, measured yaw rate)
    gps: list[GpsFix]


def _smooth(u: float) -> float:
    u = min(max(u, 0.0), 1.0)
    return u * u * (3 - 2 * u)


def _rotate(x: float, y: float, angle: float) -> tuple[float, float]:
    c, s = math.cos(angle), math.sin(angle)
    return c * x - s * y, s * x + c * y


def antenna_velocity_body(
    vx_cg: float, vy_cg: float, yaw_rate: float, ax: float, ay: float
) -> tuple[float, float]:
    """Velocity of a point at (ax, ay) on the car, from the CG velocity: v + w x r."""
    return vx_cg - yaw_rate * ay, vy_cg + yaw_rate * ax


def drive(setup: Setup) -> Run:
    """A straight, a turn-in, then a steady corner at constant speed and sideslip."""
    rng = random.Random(setup.seed)
    dt = 1 / GYRO_HZ
    total = setup.straight_s + setup.turn_in_s + setup.corner_s
    r_corner = setup.speed_ms / setup.radius_m
    beta_corner = math.radians(setup.beta_deg)
    truth: list[Truth] = []
    gyro: list[tuple[float, float]] = []
    heading = 0.0
    bias = math.radians(setup.gyro_bias_dps)
    n = round(total * GYRO_HZ)
    for k in range(n + 1):
        t = k * dt
        u = _smooth((t - setup.straight_s) / setup.turn_in_s)
        r = r_corner * u
        truth.append(Truth(t, heading, r, beta_corner * u))
        gyro.append((t, r + bias + rng.gauss(0, math.radians(setup.gyro_noise_dps))))
        heading += r * dt
    gps: list[GpsFix] = []
    step = GYRO_HZ // GPS_HZ
    for k in range(0, n + 1, step):
        s = truth[k]
        vx_b = setup.speed_ms * math.cos(s.beta_cg)
        vy_b = setup.speed_ms * math.sin(s.beta_cg)
        ax_b, ay_b = antenna_velocity_body(
            vx_b, vy_b, s.yaw_rate, setup.antenna_x_m, setup.antenna_y_m
        )
        vx, vy = _rotate(ax_b, ay_b, s.heading)
        gps.append(
            GpsFix(
                t_arrived=s.t + setup.gps_latency_s,
                t_measured=s.t,
                vx=vx + rng.gauss(0, setup.gps_noise_ms),
                vy=vy + rng.gauss(0, setup.gps_noise_ms),
            )
        )
    return Run(setup, truth, gyro, gps)


@dataclass(frozen=True)
class Estimate:
    t: float  # the time the estimate is for
    beta_antenna: float
    beta_cg: float


class SideslipEstimator:
    """Gyro heading, set and de-biased on the straight, against GPS course.

    `compensate_latency=False` takes the heading when the fix arrives instead of when it was
    measured; `to_cg=False` reports the antenna's sideslip as if it were the CG's. Both are
    there to show what each step is worth.
    """

    def __init__(
        self,
        run: Run,
        align_s: float = 3.0,
        compensate_latency: bool = True,
        to_cg: bool = True,
    ) -> None:
        self.run = run
        self.compensate_latency = compensate_latency
        self.to_cg = to_cg
        # On the straight the car goes where it points, so GPS course is heading and the
        # gyro's average reading is its bias.
        straight_gyro = [w for t, w in run.gyro if t <= align_s]
        straight_gps = [f for f in run.gps if f.t_arrived <= align_s]
        if len(straight_gyro) < 10 or len(straight_gps) < 3:
            raise ValueError("need a few seconds of straight running to line up")
        self.bias = sum(straight_gyro) / len(straight_gyro)
        start = math.atan2(sum(f.vy for f in straight_gps), sum(f.vx for f in straight_gps))
        # Integrate the de-biased gyro from the start of the run.
        self._t: list[float] = []
        self._heading: list[float] = []
        self._rate: list[float] = []
        heading = start
        dt = 1 / GYRO_HZ
        for t, w in run.gyro:
            self._t.append(t)
            self._heading.append(heading)
            self._rate.append(w - self.bias)
            heading += (w - self.bias) * dt

    def _at(self, t: float, values: list[float]) -> float:
        i = min(max(bisect.bisect_left(self._t, t), 1), len(self._t) - 1)
        t0, t1 = self._t[i - 1], self._t[i]
        u = min(max((t - t0) / (t1 - t0), 0.0), 1.0)
        return values[i - 1] + (values[i] - values[i - 1]) * u

    def estimate(self, fix: GpsFix) -> Estimate:
        t = fix.t_measured if self.compensate_latency else fix.t_arrived
        heading = self._at(t, self._heading)
        rate = self._at(t, self._rate)
        vx_b, vy_b = _rotate(fix.vx, fix.vy, -heading)
        beta_ant = math.atan2(vy_b, vx_b)
        if self.to_cg:
            s = self.run.setup
            vx_b, vy_b = vx_b + rate * s.antenna_y_m, vy_b - rate * s.antenna_x_m
        return Estimate(fix.t_measured, beta_ant, math.atan2(vy_b, vx_b))

    def all(self) -> list[Estimate]:
        return [self.estimate(f) for f in self.run.gps]


def errors_deg(run: Run, estimates: list[Estimate], start_s: float, end_s: float) -> list[float]:
    """Estimate minus truth at the CG, in degrees, for fixes measured in [start_s, end_s]."""
    truth = {round(s.t * GYRO_HZ): s for s in run.truth}
    out: list[float] = []
    for e in estimates:
        if start_s <= e.t <= end_s:
            out.append(math.degrees(e.beta_cg - truth[round(e.t * GYRO_HZ)].beta_cg))
    return out


def rms(values: list[float]) -> float:
    return math.sqrt(sum(v * v for v in values) / len(values)) if values else 0.0


def report(setup: Setup) -> str:
    run = drive(setup)
    turn_in = (setup.straight_s, setup.straight_s + setup.turn_in_s)
    corner = (turn_in[1] + 0.5, turn_in[1] + setup.corner_s)
    rows = [
        ("full method", SideslipEstimator(run)),
        ("no latency fix", SideslipEstimator(run, compensate_latency=False)),
        ("antenna, not CG", SideslipEstimator(run, to_cg=False)),
    ]
    lines = [
        f"corner: {setup.speed_ms * 3.6:.0f} km/h, {setup.radius_m:.0f} m radius, "
        f"true sideslip {setup.beta_deg:+.1f} deg at the CG",
        f"GPS {GPS_HZ} Hz, {setup.gps_latency_s * 1000:.0f} ms late; "
        f"gyro {GYRO_HZ} Hz, {setup.gyro_bias_dps:+.2f} deg/s bias",
        "",
        f"{'method':<16} {'turn-in RMS':>12} {'corner RMS':>11}  (degrees of error)",
    ]
    for name, est in rows:
        e = est.all()
        lines.append(
            f"{name:<16} {rms(errors_deg(run, e, *turn_in)):>12.2f}"
            f" {rms(errors_deg(run, e, *corner)):>11.2f}"
        )
    return "\n".join(lines)
