"""The car's end of the link: a bounded buffer, a send queue and a resend timer.

What it does, in order of importance:

1. Every frame gets the next sequence number and goes into the ring buffer.
2. The buffer holds at most `capacity` frames that the pit wall has not confirmed. If a new
   frame arrives and the buffer is full, the OLDEST frame is thrown away and counted
   (`evicted`). Fresh data is worth more than old data on a live screen, so the newest wins.
3. Frames go out oldest first, never faster than `rate_pps` packets a second.
4. A frame stays in the buffer until an ack says the pit wall has it.
5. If no ack has come for `silence_us`, the car assumes the link is down. It stops sending
   and sends one probe every `probe_us`. The first ack that comes back means the link is up,
   and the backlog drains in order. That drain is the backfill.
"""

from __future__ import annotations

import heapq
from collections import OrderedDict
from dataclasses import dataclass

from car.sim import Frame
from link import packet

__all__ = ["Sender", "SenderConfig", "SenderStats"]


@dataclass(frozen=True)
class SenderConfig:
    capacity: int = 2048  # frames held while unconfirmed: 9.3 seconds at 220 frames a second
    rate_pps: int = 660  # most packets sent per second: three times what the car produces
    burst: int = 16  # packets that can go out in a single instant
    rto_us: int = 150_000  # resend a frame if nothing has confirmed it after this long
    fast_resend_us: int = 70_000  # ... or sooner, if the pit wall has later frames but not this one
    silence_us: int = 500_000  # no ack for this long means the link is down
    probe_us: int = 250_000  # how often to knock while the link is down
    heartbeat_us: int = 100_000  # how often to say "still here" when there is nothing to send

    def __post_init__(self) -> None:
        if self.capacity < 1 or self.rate_pps < 1 or self.burst < 1:
            raise ValueError("capacity, rate and burst must be at least 1")


@dataclass
class SenderStats:
    generated: int = 0
    evicted: int = 0  # frames thrown away unconfirmed because the buffer was full
    packets_sent: int = 0
    resends: int = 0  # data packets that were not the first send of their frame
    peak_buffer: int = 0
    probes: int = 0
    down_events: int = 0  # how many times the car decided the link was down


@dataclass
class _Entry:
    frame: Frame
    attempts: int = 0
    last_sent_us: int = 0
    version: int = 0  # bumps on every send, so stale timer entries can be recognised


class Sender:
    def __init__(self, config: SenderConfig | None = None) -> None:
        self.config = config or SenderConfig()
        self.stats = SenderStats()
        self._buffer: OrderedDict[int, _Entry] = OrderedDict()  # unconfirmed frames, oldest first
        self._next_seq = 0
        self._ready: list[int] = []  # heap of sequence numbers that may be sent now
        self._waiting: list[tuple[int, int, int]] = []  # heap of (resend due, seq, version)
        self._tokens = float(self.config.burst)
        self._last_refill_us = 0
        self._confirmed_below = 0  # the pit wall's next_expected, as last heard
        self._last_ack_us = 0
        self._last_send_us = 0
        self._last_probe_us = 0
        self._down = False

    # ----- the car hands over a frame -----

    def push(self, frame: Frame) -> None:
        seq = self._next_seq
        self._next_seq += 1
        self.stats.generated += 1
        self._buffer[seq] = _Entry(frame)
        heapq.heappush(self._ready, seq)
        if len(self._buffer) > self.config.capacity:
            self._buffer.popitem(last=False)  # the oldest unconfirmed frame is gone for good
            self.stats.evicted += 1
        self.stats.peak_buffer = max(self.stats.peak_buffer, len(self._buffer))

    # ----- the pit wall answers -----

    def on_packet(self, now_us: int, raw: bytes) -> None:
        try:
            pkt = packet.decode(raw)
        except packet.PacketError:
            return
        if not isinstance(pkt, packet.Ack):
            return
        self._last_ack_us = max(self._last_ack_us, now_us)
        self._down = False
        self._confirmed_below = max(self._confirmed_below, pkt.next_expected)
        while self._buffer and next(iter(self._buffer)) < pkt.next_expected:
            self._buffer.popitem(last=False)
        for seq in pkt.received:
            self._buffer.pop(seq, None)
        # Fast resend: the pit wall holds frames newer than these, so these were probably lost.
        if pkt.received:
            newest = max(pkt.received)
            for seq, entry in self._buffer.items():
                if seq >= newest:
                    break
                if entry.attempts and now_us - entry.last_sent_us >= self._resend_gap(entry):
                    heapq.heappush(self._ready, seq)

    # ----- what goes on the air right now -----

    def _resend_gap(self, entry: _Entry) -> int:
        """How long a sent frame must wait before it may go again.

        The first resend can come early, as soon as the pit wall reports later frames but not
        this one. After that the ack has a whole round trip to come back, so wait the full timer.
        """
        return self.config.fast_resend_us if entry.attempts == 1 else self.config.rto_us

    def _floor(self) -> int:
        return next(iter(self._buffer)) if self._buffer else self._next_seq

    def _data_packet(self, now_us: int, seq: int, entry: _Entry) -> bytes:
        entry.attempts += 1
        entry.last_sent_us = now_us
        entry.version += 1
        self.stats.packets_sent += 1
        if entry.attempts > 1:
            self.stats.resends += 1
        heapq.heappush(self._waiting, (now_us + self.config.rto_us, seq, entry.version))
        return packet.encode_data(
            packet.Data(
                seq=seq,
                floor=self._floor(),
                next_seq=self._next_seq,
                ts_us=entry.frame.ts_us,
                can_id=entry.frame.can_id,
                data=entry.frame.data,
                attempt=entry.attempts,
            )
        )

    def poll(self, now_us: int) -> list[bytes]:
        cfg = self.config
        out: list[bytes] = []

        was_down = self._down
        if not self._down and now_us - self._last_ack_us > cfg.silence_us and self._buffer:
            self._down = True
        if self._down and not was_down:
            self.stats.down_events += 1

        if self._down:
            if now_us - self._last_probe_us >= cfg.probe_us:
                self._last_probe_us = now_us
                self.stats.probes += 1
                self._last_send_us = now_us
                if self._buffer:
                    seq, entry = next(iter(self._buffer.items()))
                    out.append(self._data_packet(now_us, seq, entry))
                else:
                    out.append(self._heartbeat(now_us))
            return out

        self._tokens = min(
            float(cfg.burst),
            self._tokens + cfg.rate_pps * (now_us - self._last_refill_us) / 1_000_000,
        )
        self._last_refill_us = now_us

        while self._waiting and self._waiting[0][0] <= now_us:
            _, seq, version = heapq.heappop(self._waiting)
            timed = self._buffer.get(seq)
            if timed is not None and timed.version == version:
                heapq.heappush(self._ready, seq)

        sent_seqs: set[int] = set()
        deferred: list[int] = []
        while self._ready and self._tokens >= 1.0:
            seq = heapq.heappop(self._ready)
            queued = self._buffer.get(seq)
            if queued is None or seq in sent_seqs:
                continue  # confirmed or thrown away since it was queued
            entry = queued
            if entry.attempts and now_us - entry.last_sent_us < self._resend_gap(entry):
                continue  # sent a moment ago; the resend timer will bring it back if needed
            if seq >= self._confirmed_below + packet.WINDOW:
                deferred.append(seq)  # the pit wall has no room for it yet
                break
            sent_seqs.add(seq)
            self._tokens -= 1.0
            out.append(self._data_packet(now_us, seq, entry))
        for seq in deferred:
            heapq.heappush(self._ready, seq)

        if out:
            self._last_send_us = now_us
        elif now_us - self._last_send_us >= cfg.heartbeat_us:
            self._last_send_us = now_us
            out.append(self._heartbeat(now_us))
        return out

    def _heartbeat(self, now_us: int) -> bytes:
        self.stats.packets_sent += 1
        return packet.encode_heartbeat(packet.Heartbeat(self._floor(), self._next_seq, now_us))

    @property
    def buffered(self) -> int:
        return len(self._buffer)

    @property
    def link_down(self) -> bool:
        return self._down
