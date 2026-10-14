"""The committed replay file is a real recording of this pipeline, and stays one."""

from __future__ import annotations

import itertools
import json
from typing import Any

import pytest

from pitwall.pipeline import BATCH_MS
from pitwall.record import REPLAY_CONFIG, REPLAY_PATH, build_replay


@pytest.fixture(scope="module")
def committed() -> list[dict[str, Any]]:
    return json.loads(REPLAY_PATH.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def test_the_committed_replay_is_what_the_pipeline_produces_today(
    committed: list[dict[str, Any]],
) -> None:
    fresh = json.loads(json.dumps(build_replay()))
    assert len(fresh) == len(committed)
    assert committed[0] == fresh[0]
    assert committed[-1] == fresh[-1]
    for a, b in zip(committed, fresh, strict=True):
        assert a["type"] == b["type"]
        if a["type"] == "batch":
            assert a["rx_ms"] == b["rx_ms"] and a["link"] == b["link"]
            assert [(s["seq"], s["ts"], s["rx"], s["id"], s["tx"]) for s in a["samples"]] == [
                (s["seq"], s["ts"], s["rx"], s["id"], s["tx"]) for s in b["samples"]
            ]
            for sa, sb in zip(a["samples"], b["samples"], strict=True):
                assert sa["v"].keys() == sb["v"].keys()
                for name in sa["v"]:
                    # Same bytes in, so the same numbers. The tolerance is one step of the
                    # smallest scale in the DBC, in case a maths library rounds a sine differently.
                    assert sa["v"][name] == pytest.approx(sb["v"][name], abs=0.26)


def test_the_replay_holds_an_outage_and_its_backfill(committed: list[dict[str, Any]]) -> None:
    assert committed[0]["meta"]["outages_s"] == [list(o) for o in REPLAY_CONFIG.outages_s]
    samples = [s for m in committed if m["type"] == "batch" for s in m["samples"]]
    rx = sorted(s["rx"] for s in samples)
    longest_gap = max(b - a for a, b in itertools.pairwise(rx))
    assert longest_gap > 4_900  # the 5 s outage
    assert sum(1 for s in samples if s["rx"] - s["ts"] > 250) > 1_000  # the backfill
    assert sum(1 for s in samples if s["tx"] > 1) > 100  # and frames the 2 % loss made it resend
    assert committed[-1]["summary"]["unresolved"] == 0


def test_the_replay_is_labelled_as_a_recording(committed: list[dict[str, Any]]) -> None:
    assert committed[0]["meta"]["source"] == "recorded replay"
    assert committed[0]["meta"]["batch_ms"] == BATCH_MS


def test_the_replay_file_has_no_nan_or_infinity() -> None:
    text = REPLAY_PATH.read_text(encoding="utf-8")
    assert "NaN" not in text and "Infinity" not in text
