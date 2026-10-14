from __future__ import annotations

import json
from typing import Any

import pytest

from car.sim import CarSim
from pitwall.decode import Decoder
from pitwall.pipeline import BATCH_MS, Pipeline, RunConfig

SHORT = RunConfig(seed=3, duration_s=6.0, loss=0.05, outages_s=((2.0, 3.5),))


@pytest.fixture(scope="module")
def messages() -> list[dict[str, Any]]:
    return list(Pipeline(SHORT).messages())


def test_the_stream_is_hello_then_batches_then_end(messages: list[dict[str, Any]]) -> None:
    kinds = [m["type"] for m in messages]
    assert kinds[0] == "hello" and kinds[-1] == "end"
    assert set(kinds[1:-1]) == {"batch"}


def test_hello_describes_the_run_and_every_signal(messages: list[dict[str, Any]]) -> None:
    meta = messages[0]["meta"]
    assert meta["seed"] == 3 and meta["loss"] == 0.05 and meta["outages_s"] == [[2.0, 3.5]]
    assert meta["batch_ms"] == BATCH_MS
    assert set(meta["signals"]) == {
        "EngineRPM",
        "Throttle",
        "Speed",
        "BrakePressure",
        "SteeringAngle",
        "Gear",
        "BrakeOn",
        "ShiftLight",
        "CoolantTemp",
    }
    assert meta["messages"] == {"256": "ENGINE", "257": "CHASSIS", "258": "DRIVETRAIN"}


def test_batches_land_on_the_50_ms_grid_and_hold_only_their_own_window(
    messages: list[dict[str, Any]],
) -> None:
    batches = [m for m in messages if m["type"] == "batch"]
    times = [b["rx_ms"] for b in batches]
    assert times[:-1] == [BATCH_MS * (i + 1) for i in range(len(times) - 1)]
    for b in batches:
        for s in b["samples"]:
            assert b["rx_ms"] - BATCH_MS <= s["rx"] < b["rx_ms"]


def test_samples_arrive_once_each_in_sequence_order(messages: list[dict[str, Any]]) -> None:
    seqs = [s["seq"] for m in messages if m["type"] == "batch" for s in m["samples"]]
    assert seqs == sorted(set(seqs))
    end = messages[-1]["summary"]
    assert len(seqs) == end["delivered"] and end["unresolved"] == 0


def test_what_the_pit_wall_decodes_is_what_the_car_sent() -> None:
    """End to end on a clean link: decode the original frames directly and compare."""
    cfg = RunConfig(seed=3, duration_s=3.0)
    frames = list(CarSim(3, 3.0).frames())
    truth = Decoder()
    samples = [s for m in Pipeline(cfg).messages() if m["type"] == "batch" for s in m["samples"]]
    assert len(samples) == len(frames)
    for sample, frame in zip(samples, frames, strict=True):
        assert sample["v"] == truth.decode(frame.can_id, frame.data)
        assert sample["ts"] * 1000 == frame.ts_us
        assert sample["id"] == frame.can_id


def test_the_outage_shows_up_as_a_silence_then_resent_samples(
    messages: list[dict[str, Any]],
) -> None:
    samples = [s for m in messages if m["type"] == "batch" for s in m["samples"]]
    during = [s for s in samples if 2050 <= s["rx"] < 3500]
    assert during == []  # nothing is delivered while the link is down
    backfilled = [s for s in samples if 2000 <= s["ts"] < 3500]
    assert len(backfilled) == 330  # 1.5 s at 220 frames a second, none lost
    assert sum(1 for s in backfilled if s["rx"] - s["ts"] > 250) > 300  # nearly all arrived late


def test_the_messages_are_valid_json_with_no_nan_or_infinity(
    messages: list[dict[str, Any]],
) -> None:
    text = json.dumps(messages, allow_nan=False)
    assert "NaN" not in text and "Infinity" not in text


def test_link_stats_never_go_backwards(messages: list[dict[str, Any]]) -> None:
    last = {"delivered": 0, "lost": 0, "duplicates": 0}
    for m in messages:
        if m["type"] != "batch":
            continue
        link = m["link"]
        for key in last:
            assert link[key] >= last[key]
            last[key] = link[key]


def test_summary_reports_metrics_for_the_outage() -> None:
    p = Pipeline(RunConfig(seed=3, duration_s=6.0, outages_s=((2.0, 3.5),)))
    metrics = p.run_to_end()
    assert metrics.back_to_live_ms is not None and 100 < metrics.back_to_live_ms < 2_000
    assert metrics.longest_gap_ms > 1_400
    assert p.summary()["lost"] == 0
