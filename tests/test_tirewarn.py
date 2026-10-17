from __future__ import annotations

from dataclasses import replace

import pytest

from pitwall.__main__ import main
from pitwall.tirewarn import HOLD_S, RATE_HZ, WHEELS, Sample, Scenario, check, drive, monitor

BASE = Scenario()


def test_a_healthy_car_never_warns_even_through_corners() -> None:
    assert monitor(drive(replace(BASE, soft=None))) == []


@pytest.mark.parametrize("wheel", WHEELS)
def test_each_wheel_is_named_when_it_goes_soft(wheel: str) -> None:
    ws = monitor(drive(replace(BASE, soft=wheel)))
    assert [w.wheel for w in ws] == [wheel]
    # HOLD_S of samples, counting the first soft one, so the last lands one tick early.
    first = BASE.soft_at_s + HOLD_S - 1 / RATE_HZ
    assert first <= ws[0].t <= first + 1


def test_a_soft_tire_spins_faster_and_tips_its_diagonal() -> None:
    s = drive(replace(BASE, soft="FL", noise=0, corners=()))[-1]
    c = check(s)
    assert c.offsets[0] > 0.001
    assert c.diagonal > 0
    assert c.suspect == "FL"


def test_a_corner_alone_cancels_on_the_diagonals() -> None:
    s = Sample(
        0.0, (100.0 * (1 - 0.0067), 100.0 * 1.0067, 100.0 * (1 - 0.0067), 100.0 * 1.0067), 0.0, 0.0
    )
    assert check(s).diagonal == pytest.approx(0, abs=1e-12)
    assert check(s).suspect is None


def test_hard_cornering_suspends_the_check() -> None:
    s = Sample(0.0, (101.0, 100.0, 100.0, 100.0), 0.0, 0.8)
    assert check(s).suspended
    assert check(s).suspect is None
    assert not check(s, suspend=False).suspended


def test_going_soft_mid_corner_warns_once_the_corner_ends() -> None:
    ws = monitor(drive(replace(BASE, soft="FL", soft_at_s=9.0)))
    corner_end = BASE.corners[0][1]
    assert [w.wheel for w in ws] == ["FL"]
    assert ws[0].t >= corner_end + HOLD_S - 0.05


def test_noise_flicker_does_not_repeat_the_warning() -> None:
    ws = monitor(drive(replace(BASE, soft="FR", radius_loss=0.002)))
    assert [w.wheel for w in ws] == ["FR"]


def test_too_small_a_loss_stays_quiet() -> None:
    assert monitor(drive(replace(BASE, soft="FL", radius_loss=0.0003))) == []


def test_cli_prints_the_table(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["tires"]) == 0
    assert "FL soft at 20 s" in capsys.readouterr().out
