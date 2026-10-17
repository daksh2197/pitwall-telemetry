from __future__ import annotations

import itertools

import pytest

from car.profile import Lap
from pitwall.__main__ import main
from pitwall.lapdelta import LapTrace, biggest_gaps, delta, pick_datum, trace_from_lap

SEED = 7


def straight_line(name: str, speed_ms: float, length_m: float = 1000.0) -> LapTrace:
    """A lap at constant speed: the time at any distance is distance over speed."""
    n = 101
    metres = tuple(length_m * i / (n - 1) for i in range(n))
    return LapTrace(name, metres, tuple(m / speed_ms for m in metres), (speed_ms * 3.6,) * n)


def test_delta_on_a_constant_speed_lap_is_exact() -> None:
    fast, slow = straight_line("fast", 50.0), straight_line("slow", 40.0)
    rows = delta(slow, fast, grid_m=100)
    for d, dt in rows:
        assert dt == pytest.approx(d / 40 - d / 50)
    assert rows[-1][0] == 1000.0
    assert rows[-1][1] == pytest.approx(5.0)


def test_a_lap_against_itself_has_zero_delta_everywhere() -> None:
    lap = trace_from_lap(Lap(SEED), "a")
    assert all(dt == pytest.approx(0, abs=1e-9) for _, dt in delta(lap, lap))


def test_the_datum_is_the_fastest_lap_unless_vetoed_or_forced() -> None:
    laps = [straight_line("a", 40), straight_line("b", 50), straight_line("c", 45)]
    assert pick_datum(laps).name == "b"
    assert pick_datum(laps, veto=frozenset({"b"})).name == "c"
    assert pick_datum(laps, force="a").name == "a"
    with pytest.raises(ValueError, match="no lap called"):
        pick_datum(laps, force="z")
    with pytest.raises(ValueError, match="every lap is vetoed"):
        pick_datum(laps, veto=frozenset({"a", "b", "c"}))


def test_pace_keeps_the_track_and_slows_only_the_corners() -> None:
    quick, slow = Lap(SEED), Lap(SEED, pace=0.95)
    assert [(c.start_m, c.end_m) for c in quick.corners] == [
        (c.start_m, c.end_m) for c in slow.corners
    ]
    assert quick.length_m == slow.length_m
    assert slow.lap_ms > quick.lap_ms
    with pytest.raises(ValueError, match="pace"):
        Lap(SEED, pace=0.2)


def test_a_slower_lap_loses_time_and_never_gains_any() -> None:
    quick = trace_from_lap(Lap(SEED), "quick")
    slow = trace_from_lap(Lap(SEED, pace=0.95), "slow")
    rows = delta(slow, quick)
    assert rows[-1][1] == pytest.approx(slow.lap_s - quick.lap_s, abs=0.02)
    # Time only goes out in the corners; small dips come from sensor noise in the speed.
    assert all(b >= a - 0.01 for (_, a), (_, b) in itertools.pairwise(rows))


def test_biggest_gaps_are_ranked_labelled_and_sit_in_corners() -> None:
    lap = Lap(SEED)
    quick = trace_from_lap(lap, "quick")
    slow = trace_from_lap(Lap(SEED, pace=0.95), "slow")
    gaps = biggest_gaps(slow, quick, lap.corners)
    assert len(gaps) == 5
    sizes = [abs(g.gap_kph) for g in gaps]
    assert sizes == sorted(sizes, reverse=True)
    assert all(g.gap_kph < 0 for g in gaps)  # the slow lap is slower at every one
    for g in gaps:
        n = int(g.where.split()[0][1:])
        c = lap.corners[n - 1]
        assert c.start_m - 60 <= g.metres <= c.end_m + 60
        # About 5% of the apex speed, give or take sensor noise.
        assert abs(g.gap_kph) == pytest.approx(0.05 * c.apex_kph, rel=0.2)


def test_traces_reject_bad_input() -> None:
    with pytest.raises(ValueError, match="at least two"):
        LapTrace("x", (0.0,), (0.0,), (0.0,))
    with pytest.raises(ValueError, match="must rise"):
        LapTrace("x", (0.0, 5.0, 5.0), (0.0, 1.0, 2.0), (1.0, 1.0, 1.0))
    with pytest.raises(ValueError, match="outside the lap"):
        straight_line("x", 10).time_at(2000)


def test_cli_prints_the_report(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["delta", "--seed", str(SEED), "--pace", "1", "0.95"]) == 0
    out = capsys.readouterr().out
    assert "datum   pace 1" in out
    assert "biggest speed gaps" in out
    assert main(["delta", "--pace", "1", "0.9", "--force", "nope"]) == 2
