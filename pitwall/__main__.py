"""Command line: `uv run python -m pitwall <run|bench|record|serve|delta|sideslip|tires>`."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import sys
from pathlib import Path

from car.profile import Lap
from pitwall import bench, lapdelta, sideslip, tirewarn
from pitwall.pipeline import Pipeline, RunConfig
from pitwall.record import REPLAY_CONFIG, REPLAY_PATH, write_replay
from pitwall.server import DEFAULT_PORT, serve


def parse_outage(text: str) -> tuple[float, float]:
    try:
        start, end = (float(part) for part in text.split(":"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"outage must look like 12:17, got {text!r}") from exc
    if not 0 <= start < end:
        raise argparse.ArgumentTypeError("outage needs 0 <= start < end")
    return (start, end)


def add_run_options(p: argparse.ArgumentParser) -> None:
    p.add_argument("--seed", type=int, default=bench.SEED, help="lap seed (default %(default)s)")
    p.add_argument("--duration", type=float, default=bench.DURATION_S, help="seconds of driving")
    p.add_argument("--loss", type=float, default=0.0, help="percent of packets lost, 0 to 100")
    p.add_argument("--delay", type=int, default=40, help="one-way delay in ms")
    p.add_argument("--jitter", type=int, default=8, help="extra random delay, up to this many ms")
    p.add_argument(
        "--outage",
        type=parse_outage,
        action="append",
        default=[],
        help="start:end in seconds, e.g. 12:17. Repeat for more than one",
    )
    p.add_argument("--buffer", type=int, default=2048, help="car ring buffer size in frames")


def config_from(args: argparse.Namespace) -> RunConfig:
    if not 0 <= args.loss <= 100:
        raise SystemExit("--loss is a percent between 0 and 100")
    return RunConfig(
        seed=args.seed,
        duration_s=args.duration,
        loss=args.loss / 100,
        delay_ms=args.delay,
        jitter_ms=args.jitter,
        outages_s=tuple(args.outage),
        buffer=args.buffer,
    )


def cmd_run(args: argparse.Namespace) -> int:
    try:
        pipeline = Pipeline(config_from(args))
        m = pipeline.run_to_end()
    except ValueError as err:
        print(f"pitwall: {err}", file=sys.stderr)
        return 2
    s = pipeline.session
    assert s is not None
    print(f"frames made      {s.generated}")
    print(f"delivered        {s.receiver.stats.delivered}")
    print(f"lost             {s.receiver.stats.lost}")
    print(f"resends          {s.sender.stats.resends}")
    print(f"latency p50      {m.p50_ms:.0f} ms")
    print(f"latency p95      {m.p95_ms:.0f} ms")
    print(f"latency max      {m.max_ms:.0f} ms")
    print(f"longest silence  {m.longest_gap_ms / 1000:.2f} s")
    if m.back_to_live_ms is not None:
        print(f"backfill done    {m.backfill_done_ms or 0:.0f} ms after the link came back")
        print(f"back to live     {m.back_to_live_ms:.0f} ms after the link came back")
    return 0


def cmd_bench(args: argparse.Namespace) -> int:
    results = [bench.run_row(row) for row in bench.ROWS]
    print(bench.table(results))
    if args.write:
        Path(args.write).write_text(bench.markdown(results), encoding="utf-8")
        print(f"\nwrote {args.write}", file=sys.stderr)
    if args.json:
        Path(args.json).write_text(bench.json_dump(results) + "\n", encoding="utf-8")
        print(f"wrote {args.json}", file=sys.stderr)
    return 0


def cmd_record(args: argparse.Namespace) -> int:
    count = write_replay(Path(args.out))
    print(f"wrote {count} messages to {args.out}")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    config = REPLAY_CONFIG if args.replay_run else config_from(args)
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(serve(config, host=args.host, port=args.port, speed=args.speed))
    return 0


def cmd_delta(args: argparse.Namespace) -> int:
    try:
        laps = [
            lapdelta.trace_from_lap(Lap(args.seed, pace), f"pace {pace:g}") for pace in args.pace
        ]
        datum = lapdelta.pick_datum(laps, frozenset(args.veto), args.force)
    except ValueError as err:
        print(f"pitwall: {err}", file=sys.stderr)
        return 2
    corners = Lap(args.seed).corners
    for lap in laps:
        if lap is not datum:
            print(lapdelta.report(lap, datum, corners))
            print()
    return 0


def cmd_sideslip(args: argparse.Namespace) -> int:
    setup = sideslip.Setup(
        speed_ms=args.speed_kph / 3.6,
        radius_m=args.radius,
        beta_deg=args.beta,
        gps_latency_s=args.latency / 1000,
    )
    print(sideslip.report(setup))
    return 0


def cmd_tires(args: argparse.Namespace) -> int:
    print(tirewarn.report())
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pitwall", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run the pipeline once and print the numbers")
    add_run_options(run)
    run.set_defaults(func=cmd_run)

    b = sub.add_parser("bench", help="run every row of the results table")
    b.add_argument("--write", metavar="FILE", help="also write the table as Markdown")
    b.add_argument("--json", metavar="FILE", help="also write every number as JSON")
    b.set_defaults(func=cmd_bench)

    rec = sub.add_parser("record", help="record the dashboard's replay file")
    rec.add_argument("--out", default=str(REPLAY_PATH))
    rec.set_defaults(func=cmd_record)

    srv = sub.add_parser("serve", help="serve a live run to dashboards over a WebSocket")
    add_run_options(srv)
    srv.add_argument("--host", default="127.0.0.1")
    srv.add_argument("--port", type=int, default=DEFAULT_PORT)
    srv.add_argument(
        "--speed", type=float, default=1.0, help="1 is real time, 0 is as fast as possible"
    )
    srv.add_argument(
        "--replay-run",
        action="store_true",
        help="use the recorded replay's settings (2%% loss, outage 12:17)",
    )
    srv.set_defaults(func=cmd_serve)

    dl = sub.add_parser("delta", help="compare laps on one track against the fastest (datum) lap")
    dl.add_argument("--seed", type=int, default=bench.SEED, help="track seed (default %(default)s)")
    dl.add_argument(
        "--pace",
        type=float,
        nargs="+",
        default=[1.0, 0.95],
        help="one lap per value; 0.95 takes every corner 5%% slower (default 1.0 0.95)",
    )
    dl.add_argument("--veto", action="append", default=[], help="lap name that can't be datum")
    dl.add_argument("--force", help="lap name to use as the datum even if it is slower")
    dl.set_defaults(func=cmd_delta)

    ss = sub.add_parser("sideslip", help="estimate sideslip from GPS and a gyro on a test corner")
    ss.add_argument("--speed-kph", type=float, default=108.0, help="corner speed")
    ss.add_argument("--radius", type=float, default=80.0, help="corner radius in metres")
    ss.add_argument("--beta", type=float, default=-4.0, help="true sideslip at the CG, degrees")
    ss.add_argument("--latency", type=float, default=50.0, help="GPS latency in ms")
    ss.set_defaults(func=cmd_sideslip)

    tw = sub.add_parser("tires", help="spot a soft tire from the four wheel speeds")
    tw.set_defaults(func=cmd_tires)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
