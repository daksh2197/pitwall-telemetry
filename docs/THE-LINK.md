# The link

This is the hard part of the build: getting 220 CAN frames a second from a car to a pit wall over a radio that loses packets and sometimes goes dark for seconds. The code is in `link/`. The tests are `tests/test_packet.py`, `test_channel.py` and `test_link.py`.

## What it has to do

1. Deliver every frame the car still holds, once each, in order.
2. Never let a dead radio grow memory without limit on the car.
3. Say honestly what was lost, and when.
4. After an outage, catch up without drowning the live data.

## Packets

Three kinds, all big-endian, defined in `link/packet.py`.

| Packet | Bytes | Carries |
| --- | ---: | --- |
| DATA | 33 | type, `seq`, `floor`, `next_seq`, car timestamp (us), CAN id, length, 8 CAN bytes, attempt count |
| HEARTBEAT | 17 | type, `floor`, `next_seq`, car clock |
| ACK | 37 | type, `next_expected`, a 256-bit bitmap of frames held beyond it |

`seq` counts frames from 0. `floor` is the oldest frame the car can still send. `next_seq` is the number its next frame will get.

## How a frame is tracked

The car puts each frame in a ring buffer (`Sender`, an ordered dict, capacity 2,048 frames, about 9.3 seconds of driving). A frame leaves the buffer only when an ack says the pit wall has it. If the buffer is full when a new frame arrives, the oldest frame is dropped and counted as `evicted`. Fresh data is worth more on a live screen.

The pit wall (`Receiver`) hands frames upward in order, once each. A frame that arrives early waits for the gap before it. A frame is counted lost only when the car's `floor` moves past it, which means the car no longer has it and no resend can come. That is why "lost" is a fact and not a timeout guess.

## Acks

Each ack says "everything below `next_expected` is done, and I also hold these frames beyond it" using the bitmap. The pit wall waits 10 ms after a frame arrives before mentioning it in an ack, so a frame that was only reordered by jitter is not reported as a gap.

## Resends

- A sent frame is resent after 150 ms with no confirmation.
- If an ack shows the pit wall holds newer frames but not this one, the first resend goes after 70 ms (fast resend). Later resends wait the full 150 ms.
- Sending is capped at 660 packets a second (three times the frame rate) with a burst of 16, so a backlog drains fast without flooding the radio.
- The pit wall holds at most 256 frames past the next one it expects. The car does not send beyond that window.

## Outages

If no ack has come for 500 ms and frames are waiting, the car marks the link down. It stops sending the backlog and sends one probe every 250 ms (the oldest buffered frame, or a heartbeat if empty). The first ack that comes back marks the link up, and the backlog drains oldest first. Those late frames are the backfill. In the dashboard a frame is "backfilled" if it arrived more than 250 ms after the car stamped it.

The 5 second outage in the README (12 s to 17 s of a 40 s run), with the default 2,048-frame buffer:

| Moment | What happens |
| --- | --- |
| 12.491 s | Car decides the link is down, 130 frames buffered |
| 12 s to 17 s | Probes only. The pit wall shows the last value, then flags it stale |
| 17.054 s | First ack returns, 1,122 frames buffered |
| about 20 s | Backlog drained, live again (2.52 s after the radio came back) |
| result | 0 of 8,800 frames lost |

With a 500-frame buffer the same outage loses 649 frames, and back-to-live drops to 1.22 s. That is the trade: a smaller buffer gets to live data sooner and gives up history. The run is `uv run python -m pitwall run --outage 12:17 --buffer 500`.

## Parameters

| Setting | Default | Where |
| --- | ---: | --- |
| Buffer capacity | 2,048 frames | `SenderConfig.capacity` |
| Send rate / burst | 660 pps / 16 | `rate_pps`, `burst` |
| Resend timer | 150 ms | `rto_us` |
| Fast resend | 70 ms | `fast_resend_us` |
| Silence before link-down | 500 ms | `silence_us` |
| Probe interval | 250 ms | `probe_us` |
| Heartbeat interval | 100 ms | `heartbeat_us` |
| Receiver window | 256 frames | `packet.WINDOW` |
| Reorder hold | 10 ms | `REORDER_HOLD_US` |

## Trade-offs, stated plainly

- **Head-of-line blocking.** In-order delivery means one missing frame holds up everything behind it until it is resent or given up. The 5% and 10% loss rows show the cost in p95 latency.
- **Drop oldest.** A long enough outage loses history. It is counted and shown, never hidden.
- **Clocks.** Latency is the pit wall's receive time minus the car's timestamp. Here both read one simulated clock. A real car and a real pit wall need clock sync (for example GPS time or PTP) for that number to mean anything.
- **No wraparound, no checksum.** Sequence numbers are 32 bits and wrap after about 226 days of driving at 220 frames a second. There is no CRC here, because the simulated radio never corrupts a packet, only loses it. Neither is handled.
