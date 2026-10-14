"""What actually goes over the air: three kinds of packet, packed into bytes.

All numbers are big-endian ("network order"), the way most protocols write them.

    DATA       one CAN frame plus the link's own bookkeeping (33 bytes)
    HEARTBEAT  "still here, this is where my numbers are" (17 bytes)
    ACK        the pit wall saying what it has (37 bytes)

Sequence numbers are 32 bits and count frames, not seconds. At 220 frames a second that
wraps after 226 days of driving. A race weekend does not get there, so wrapping is not handled.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

WINDOW = 256  # how far past the next expected frame the pit wall will hold frames
BITMAP_BYTES = WINDOW // 8

TYPE_DATA = 0xD1
TYPE_ACK = 0xD2
TYPE_HEARTBEAT = 0xD3

_DATA = struct.Struct(">BIIIQHB8sB")
_HEARTBEAT = struct.Struct(">BIIQ")
_ACK = struct.Struct(f">BI{BITMAP_BYTES}s")


class PacketError(ValueError):
    """The bytes are not a packet this link understands."""


@dataclass(frozen=True)
class Data:
    seq: int  # this frame's number, counting from 0
    floor: int  # the oldest frame the car can still send; everything below it is gone for good
    next_seq: int  # the number the car will give its next frame
    ts_us: int  # when the frame was generated, on the car's clock
    can_id: int
    data: bytes  # the 8 raw CAN bytes
    attempt: int  # 1 for the first time this frame is sent, 2 for the first resend, and so on


@dataclass(frozen=True)
class Heartbeat:
    floor: int
    next_seq: int
    now_us: int


@dataclass(frozen=True)
class Ack:
    next_expected: int  # every frame below this has been delivered or given up on
    received: frozenset[int]  # frames held beyond next_expected, waiting for the gap to fill


Packet = Data | Heartbeat | Ack


def encode_data(p: Data) -> bytes:
    return _DATA.pack(
        TYPE_DATA,
        p.seq,
        p.floor,
        p.next_seq,
        p.ts_us,
        p.can_id,
        len(p.data),
        p.data.ljust(8, b"\0"),
        min(p.attempt, 255),
    )


def encode_heartbeat(p: Heartbeat) -> bytes:
    return _HEARTBEAT.pack(TYPE_HEARTBEAT, p.floor, p.next_seq, p.now_us)


def encode_ack(p: Ack) -> bytes:
    bitmap = bytearray(BITMAP_BYTES)
    for seq in p.received:
        i = seq - p.next_expected - 1
        if 0 <= i < WINDOW:
            bitmap[i // 8] |= 1 << (i % 8)
    return _ACK.pack(TYPE_ACK, p.next_expected, bytes(bitmap))


def decode(raw: bytes) -> Packet:
    """Parse one packet, or raise PacketError. Never anything else, whatever the bytes are."""
    if not raw:
        raise PacketError("empty packet")
    kind = raw[0]
    try:
        if kind == TYPE_DATA and len(raw) == _DATA.size:
            _, seq, floor, next_seq, ts_us, can_id, dlc, data, attempt = _DATA.unpack(raw)
            if dlc > 8 or attempt < 1 or floor > seq or seq >= next_seq:
                raise PacketError("data packet fields are inconsistent")
            return Data(seq, floor, next_seq, ts_us, can_id, data[:dlc], attempt)
        if kind == TYPE_HEARTBEAT and len(raw) == _HEARTBEAT.size:
            _, floor, next_seq, now_us = _HEARTBEAT.unpack(raw)
            if floor > next_seq:
                raise PacketError("heartbeat fields are inconsistent")
            return Heartbeat(floor, next_seq, now_us)
        if kind == TYPE_ACK and len(raw) == _ACK.size:
            _, next_expected, bitmap = _ACK.unpack(raw)
            received = frozenset(
                next_expected + 1 + i for i in range(WINDOW) if bitmap[i // 8] >> (i % 8) & 1
            )
            return Ack(next_expected, received)
    except struct.error as exc:  # pragma: no cover - lengths are checked above
        raise PacketError(str(exc)) from exc
    raise PacketError(f"unknown packet type 0x{kind:02x} or wrong length {len(raw)}")
