# Notes for an engineer reading this

## The new idea

Most telemetry demos show a clean stream. This one starts from the radio that fails. A simulated car sends real CAN frames (a DBC file, decoded with cantools) over a lossy link with a bounded buffer, and the pit wall page shows what the engineer would actually see: values going stale, a gap, then the backlog arriving late and being marked as backfill. Every claim is a number you can reproduce with one command.

## Where things live

| Folder | What is in it |
| --- | --- |
| `dbc/pitwall.dbc` | Three CAN messages: ENGINE (256), CHASSIS (257), DRIVETRAIN (258) |
| `car/` | The lap model and the frame generator (`profile.py`, `sim.py`) |
| `link/` | Packets, lossy channel, sender, receiver, session loop |
| `pitwall/` | Decoder, metrics, pipeline, WebSocket server, replay recorder, bench, CLI |
| `web/` | The dashboard: TypeScript, Vite, no framework. `src/core` is pure logic with tests |
| `tests/` | 96 Python tests. The web tests are 84 Vitest tests in `web/src` |
| `scripts/` | Browser walkthrough (57 checks), subpath server, media generation |

The replay the site plays (`web/public/replay.json`) is recorded from the same pipeline the live server uses. A test fails if the committed file stops matching what the pipeline produces.

## When it breaks

- **Long outages lose frames.** The buffer holds 2,048 frames. A 5 s outage fits. Run `uv run python -m pitwall run --outage 5:30` and you get 3,502 frames lost, all counted.
- **High loss costs latency.** At 40% loss nothing is lost, but p95 latency is about a second, because in-order delivery waits for resends.
- **Clocks are shared.** Latency numbers mean something only because car and pit wall use one simulated clock.
- **Classical CAN only.** 8-byte frames. No CAN FD, no multiplexed signals.

## Your turn

Each of these was run against this repo.

1. **Size the buffer.** Run the 5 s outage with `--buffer 100`, `1000` and `2048`. Lost frames go 1,049, 122, 0, and back-to-live goes 310 ms, 2,237 ms, 2,516 ms. What would you pick for a car that has a 30 s dead zone on one corner?
2. **Break the radio.** Run `uv run python -m pitwall run --loss 40`. Zero frames lost, about 6,060 resends. Why is p95 latency near a second and what in `link/sender.py` would you change first (hint: `_resend_gap`)?
3. **Find the lost-frame rule.** In `link/receiver.py`, find where a frame becomes "lost". Why is it tied to `floor` and not to a timer?
4. **Add a signal.** Add one signal to `dbc/pitwall.dbc`, produce it in `car/sim.py`, and run `uv run pytest`. Which test tells you what else must change?
5. **Read the parser.** `web/src/core/messages.ts` treats every WebSocket message as untrusted. Time values above 1e9 ms are refused because a value like 1e300 once froze the tick loop in the chart. Find the test for it in `messages.test.ts`, then write one more hostile message and check it is dropped.

## Questions to be ready for

- Why not just use TCP or UDP with timestamps? (TCP blocks everything behind one lost segment and has no notion of a bounded buffer or giving up on stale data. Raw UDP loses frames silently.)
- Why drop the oldest frame, not the newest? (A live screen wants the present. History is gone either way, and it is counted.)
- How do you know the replay is real? (A test regenerates it and compares.)
- What would change on a real car? (Clock sync, CRC, wraparound, CAN FD, a real radio's behavior instead of a random model.)

## Words used here

- **CAN frame:** a short message on the car's internal bus, up to 8 bytes in classical CAN.
- **DBC:** a text file that says which bits of a frame mean which signal, and how to scale them.
- **Ack:** a reply saying what has arrived.
- **Backfill:** frames that arrive late, after an outage, to fill a gap.
- **Head-of-line blocking:** one missing item holds up everything behind it.
