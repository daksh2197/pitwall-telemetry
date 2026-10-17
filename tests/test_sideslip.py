from __future__ import annotations

import math
from dataclasses import replace

import pytest

from pitwall.__main__ import main
from pitwall.sideslip import (
    GpsFix,
    Setup,
    SideslipEstimator,
    antenna_velocity_body,
    drive,
    errors_deg,
    rms,
)

SETUP = Setup()
TURN_IN = (SETUP.straight_s, SETUP.straight_s + SETUP.turn_in_s)
CORNER = (TURN_IN[1] + 0.5, TURN_IN[1] + SETUP.corner_s)


def corner_rms(setup: Setup, **opts: bool) -> float:
    run = drive(setup)
    return rms(errors_deg(run, SideslipEstimator(run, **opts).all(), *CORNER))


def test_a_point_on_the_nose_moves_sideways_when_the_car_yaws() -> None:
    # Pure rotation at 1 rad/s: a point 2 m ahead moves left at 2 m/s.
    assert antenna_velocity_body(0.0, 0.0, 1.0, 2.0, 0.0) == (0.0, 2.0)
    assert antenna_velocity_body(10.0, 0.0, 0.0, 2.0, 0.5) == (10.0, 0.0)


def test_no_noise_no_bias_no_offset_recovers_sideslip_exactly() -> None:
    clean = replace(
        SETUP, gps_noise_ms=0, gyro_bias_dps=0, gyro_noise_dps=0, antenna_x_m=0, gps_latency_s=0
    )
    run = drive(clean)
    errs = errors_deg(run, SideslipEstimator(run).all(), 0, 99)
    assert max(abs(e) for e in errs) < 0.02


def test_the_full_method_is_within_a_tenth_of_a_degree_in_the_corner() -> None:
    assert corner_rms(SETUP) < 0.1


def test_the_estimator_learns_the_gyro_bias_on_the_straight() -> None:
    run = drive(SETUP)
    est = SideslipEstimator(run)
    assert math.degrees(est.bias) == pytest.approx(SETUP.gyro_bias_dps, abs=0.02)


def test_ignoring_latency_costs_yaw_rate_times_latency() -> None:
    expected = math.degrees(SETUP.speed_ms / SETUP.radius_m * SETUP.gps_latency_s)
    assert corner_rms(SETUP, compensate_latency=False) == pytest.approx(expected, rel=0.1)


def test_skipping_the_move_to_the_cg_costs_the_lever_arm_angle() -> None:
    r = SETUP.speed_ms / SETUP.radius_m
    expected = math.degrees(math.atan(r * SETUP.antenna_x_m / SETUP.speed_ms))
    assert corner_rms(SETUP, to_cg=False) == pytest.approx(expected, rel=0.1)


def test_a_sideways_antenna_offset_is_handled_too() -> None:
    assert corner_rms(replace(SETUP, antenna_y_m=0.6)) < 0.1


def test_lining_up_needs_a_straight() -> None:
    run = drive(SETUP)
    with pytest.raises(ValueError, match="straight"):
        SideslipEstimator(run, align_s=0.1)


def test_estimate_uses_the_measured_time_when_compensating() -> None:
    run = drive(SETUP)
    fix = run.gps[60]
    assert isinstance(fix, GpsFix)
    assert SideslipEstimator(run).estimate(fix).t == fix.t_measured


def test_cli_prints_the_table(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["sideslip", "--latency", "100"]) == 0
    out = capsys.readouterr().out
    assert "full method" in out
    assert "100 ms late" in out
