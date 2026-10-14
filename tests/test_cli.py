from __future__ import annotations

import argparse
from pathlib import Path

import pytest

from pitwall import bench
from pitwall.__main__ import main, parse_outage

ROOT = Path(__file__).resolve().parent.parent


def test_outage_text_is_parsed_and_bad_text_is_refused() -> None:
    assert parse_outage("12:17") == (12.0, 17.0)
    assert parse_outage("0.5:1.5") == (0.5, 1.5)
    for bad in ("", "12", "17:12", "a:b", "12:12", "-1:3", "1:2:3"):
        with pytest.raises(argparse.ArgumentTypeError):
            parse_outage(bad)


def test_run_prints_the_numbers(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["run", "--duration", "3", "--outage", "1:2"]) == 0
    out = capsys.readouterr().out
    assert "latency p95" in out and "back to live" in out and "lost             0" in out


def test_settings_that_cannot_run_give_a_message_not_a_traceback(
    capsys: pytest.CaptureFixture[str],
) -> None:
    for args in (["--loss", "100"], ["--duration", "0"], ["--buffer", "0"], ["--delay", "-1"]):
        assert main(["run", *args]) == 2, args
        assert capsys.readouterr().err.startswith("pitwall: ")


def test_loss_must_be_a_percent() -> None:
    with pytest.raises(SystemExit):
        main(["run", "--duration", "1", "--loss", "150"])


def test_results_doc_matches_a_fresh_run() -> None:
    """docs/RESULTS.md is generated. If code changes the numbers, regenerate it."""
    results = [bench.run_row(row) for row in bench.ROWS]
    doc = (ROOT / "docs" / "RESULTS.md").read_text(encoding="utf-8")
    assert bench.table(results) in doc


def test_every_command_in_the_table_runs() -> None:
    for row in bench.ROWS:
        words = row.command.split()
        assert words[:4] == ["uv", "run", "python", "-m"] and words[4] == "pitwall"
        parser_args = words[5:]
        # Same settings as the row's config, once parsed by the real command line.
        import pitwall.__main__ as cli

        parser = argparse.ArgumentParser()
        cli.add_run_options(parser)
        ns = parser.parse_args(parser_args[1:])
        assert cli.config_from(ns) == row.config
