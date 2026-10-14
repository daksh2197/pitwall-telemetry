from __future__ import annotations

import itertools

import pytest

from car.profile import GEAR_TOP_KPH, RPM_LIMIT, Lap, gear_for, rpm_for
from car.sim import (
    CHASSIS_ID,
    DRIVETRAIN_ID,
    ENGINE_ID,
    FRAMES_PER_SECOND,
    CarSim,
    load_database,
)
from pitwall.decode import Decoder


def test_the_same_seed_gives_the_same_frames_and_another_seed_does_not() -> None:
    a = list(CarSim(11, 3).frames())
    b = list(CarSim(11, 3).frames())
    c = list(CarSim(12, 3).frames())
    assert a == b
    assert a != c


def test_frames_come_out_in_time_order_at_the_dbc_rates() -> None:
    frames = list(CarSim(11, 2).frames())
    assert [f.ts_us for f in frames] == sorted(f.ts_us for f in frames)
    counts = {
        i: sum(1 for f in frames if f.can_id == i) for i in (ENGINE_ID, CHASSIS_ID, DRIVETRAIN_ID)
    }
    assert counts == {ENGINE_ID: 200, CHASSIS_ID: 200, DRIVETRAIN_ID: 40}
    assert len(frames) == 2 * FRAMES_PER_SECOND
    assert all(len(f.data) == 8 for f in frames)


def test_no_two_frames_share_a_timestamp() -> None:
    stamps = [f.ts_us for f in CarSim(11, 2).frames()]
    assert len(stamps) == len(set(stamps))


def test_every_frame_decodes_and_stays_inside_the_dbc_ranges() -> None:
    db = load_database()
    decoder = Decoder(db)
    for frame in CarSim(5, 20).frames():
        values = decoder.decode(frame.can_id, frame.data)
        assert values is not None
        message = db.get_message_by_frame_id(frame.can_id)
        for name, value in values.items():
            sig = message.get_signal_by_name(name)
            assert sig.minimum is not None and sig.maximum is not None
            assert sig.minimum - 1e-6 <= value <= sig.maximum + 1e-6, name
    assert decoder.stats.bad_frame == 0 and decoder.stats.unknown_id == 0


def test_decoded_signals_match_what_the_car_was_doing() -> None:
    sim = CarSim(5, 5)
    decoder = Decoder(sim.db)
    for frame in sim.frames():
        state = sim.lap.state_at(frame.ts_us // 1000)
        values = decoder.decode(frame.can_id, frame.data)
        assert values is not None
        if frame.can_id == CHASSIS_ID:
            assert values["Speed"] == pytest.approx(state.speed_kph, abs=0.01)
            assert values["SteeringAngle"] == pytest.approx(state.steering_deg, abs=0.1)
        if frame.can_id == ENGINE_ID:
            assert values["EngineRPM"] == pytest.approx(state.rpm, abs=0.25)
        if frame.can_id == DRIVETRAIN_ID:
            assert values["Gear"] == state.gear


def test_the_lap_has_straights_corners_and_a_sane_speed_range() -> None:
    lap = Lap(2026)
    speeds = [lap.state_at(ms).speed_kph for ms in range(lap.lap_ms)]
    assert 270 < max(speeds) < 295
    assert 70 < min(speeds) < 175
    assert any(lap.state_at(ms).brake_pct > 50 for ms in range(0, lap.lap_ms, 10))
    assert any(abs(lap.state_at(ms).steering_deg) > 50 for ms in range(0, lap.lap_ms, 10))
    assert 40_000 < lap.lap_ms < 80_000


def test_the_car_never_brakes_and_accelerates_at_once() -> None:
    lap = Lap(2026)
    for ms in range(0, lap.lap_ms, 5):
        s = lap.state_at(ms)
        assert not (s.brake_pct > 20 and s.throttle_pct > 20), ms


def test_the_run_wraps_into_a_second_lap() -> None:
    lap = Lap(7)
    assert lap.state_at(0) == lap.state_at(lap.lap_ms)


def test_gears_change_one_step_at_a_time_through_a_lap_and_never_flicker() -> None:
    lap = Lap(2026)
    gears = [lap.state_at(ms).gear for ms in range(lap.lap_ms)]
    assert all(1 <= g <= 7 for g in gears)
    changes = [(a, b) for a, b in itertools.pairwise(gears) if a != b]
    # A flicker would show as the same pair of gears swapping back and forth within a few ms.
    assert len(changes) < 200
    for ms in range(1, lap.lap_ms - 50):
        if gears[ms] != gears[ms - 1]:
            assert len(set(gears[ms : ms + 50])) <= 2


def test_rpm_is_idle_at_a_stop_and_the_limit_at_each_gears_top_speed() -> None:
    assert rpm_for(0, 1) == 3500
    for gear, top in enumerate(GEAR_TOP_KPH, start=1):
        assert rpm_for(top, gear) == RPM_LIMIT
        assert rpm_for(top * 2, gear) == RPM_LIMIT  # it cannot go past the limit


def test_gear_choice_has_a_gap_between_up_and_down_shift_points() -> None:
    # Second gear tops out at 110 km/h. Up-shift above 97 % of that (106.7),
    # down-shift below 80 % of it (88).
    up_at = next(v for v in range(60, 300) if gear_for(v, 2) == 3)
    down_at = next(v for v in range(300, 40, -1) if gear_for(v, 3) == 2)
    assert (up_at, down_at) == (107, 87)
    # Inside the gap the car stays in whichever gear it was already in.
    assert gear_for(100, 2) == 2 and gear_for(100, 3) == 3
