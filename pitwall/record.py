"""Record one run of the pipeline to a file, for the dashboard's replay.

The file is the exact list of messages the live server would send, one JSON array. Nothing is
added, nothing is edited. `tests/test_replay.py` re-runs the pipeline and checks the committed
file still matches, so the replay cannot drift away from the code.
"""

from __future__ import annotations

import json
from pathlib import Path

from pitwall.pipeline import Pipeline, RunConfig

# The recorded run: a 40 s lap with a little background loss and one 5 s outage.
REPLAY_CONFIG = RunConfig(seed=2026, duration_s=40.0, loss=0.02, outages_s=((12.0, 17.0),))
REPLAY_PATH = Path(__file__).resolve().parent.parent / "web" / "public" / "replay.json"


def build_replay(config: RunConfig = REPLAY_CONFIG) -> list[dict[str, object]]:
    return list(Pipeline(config).messages(source="recorded replay"))


def write_replay(path: Path = REPLAY_PATH, config: RunConfig = REPLAY_CONFIG) -> int:
    messages = build_replay(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(messages, separators=(",", ":")) + "\n", encoding="utf-8")
    return len(messages)
