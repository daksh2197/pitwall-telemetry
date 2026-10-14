from __future__ import annotations

import pytest
from hypothesis import given
from hypothesis import strategies as st

from pitwall.metrics import Record, percentile, summarize


def test_percentile_is_nearest_rank_worked_by_hand() -> None:
    values = [15, 20, 35, 40, 50]  # the textbook example
    assert percentile(values, 30) == 20  # ceil(0.30 * 5) = 2nd value
    assert percentile(values, 40) == 20  # ceil(0.40 * 5) = 2nd value
    assert percentile(values, 50) == 35  # ceil(0.50 * 5) = 3rd value
    assert percentile(values, 100) == 50
    assert percentile([7], 95) == 7


def test_percentile_does_not_care_about_input_order() -> None:
    assert percentile([50, 15, 40, 20, 35], 50) == 35


def test_percentile_refuses_nonsense() -> None:
    with pytest.raises(ValueError):
        percentile([], 50)
    with pytest.raises(ValueError):
        percentile([1], 0)
    with pytest.raises(ValueError):
        percentile([1], 101)


@given(st.lists(st.floats(0, 1e6), min_size=1, max_size=200), st.floats(0.1, 100))
def test_a_percentile_is_always_one_of_the_measured_values(values: list[float], p: float) -> None:
    assert percentile(values, p) in values


@given(st.lists(st.floats(0, 1e6), min_size=2, max_size=200))
def test_p50_is_never_above_p95_and_p95_never_above_the_max(values: list[float]) -> None:
    assert percentile(values, 50) <= percentile(values, 95) <= max(values)


def rec(seq: int, ts_ms: int, rx_ms: int, attempt: int = 1) -> Record:
    return Record(seq, ts_ms * 1000, rx_ms * 1000, attempt)


def test_summary_of_a_hand_made_run_with_an_outage() -> None:
    # Frames made every 100 ms. The link is down from 500 to 1000 ms; frames made in that
    # stretch arrive between 1000 and 1080 ms; the first fresh frame (made at 1000) lands at 1150.
    records = [rec(i, i * 100, i * 100 + 50) for i in range(5)]  # 0..400: 50 ms latency
    records += [rec(5 + i, 500 + i * 100, 1000 + i * 20, attempt=2) for i in range(5)]  # backfill
    records += [rec(10, 1000, 1150), rec(11, 1100, 1160), rec(12, 1200, 1250)]
    m = summarize(records, outage_end_us=1_000_000)
    assert m.frames == 13
    assert m.max_ms == 500  # the frame made at 500 ms, delivered at 1000
    assert (
        m.backfilled == 4
    )  # latencies 500, 420, 340 and 260 ms; the fifth (180 ms) is within the limit
    assert m.longest_gap_ms == 550  # nothing delivered between 450 ms and 1000 ms
    assert m.backfill_done_ms == 80  # the last pre-outage frame landed at 1080
    assert (
        m.back_to_live_ms == 150
    )  # the first frame made after the end that was on time: seq 10 at 1150


def test_a_clean_run_has_no_recovery_numbers() -> None:
    m = summarize([rec(i, i * 10, i * 10 + 45) for i in range(100)])
    assert m.backfill_done_ms is None and m.back_to_live_ms is None
    assert m.p50_ms == m.p95_ms == m.max_ms == 45
    assert m.longest_gap_ms == 10


def test_back_to_live_is_none_when_nothing_made_after_the_outage_arrived_on_time() -> None:
    records = [rec(0, 0, 50), rec(1, 1000, 2000)]
    assert summarize(records, outage_end_us=1_000_000).back_to_live_ms is None


def test_summarize_refuses_an_empty_run() -> None:
    with pytest.raises(ValueError):
        summarize([])
