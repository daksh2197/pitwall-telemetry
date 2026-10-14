from __future__ import annotations

import contextlib

import pytest
from hypothesis import given
from hypothesis import strategies as st

from link import packet


def test_data_packet_round_trips() -> None:
    d = packet.Data(
        seq=41,
        floor=30,
        next_seq=45,
        ts_us=1_234_567,
        can_id=257,
        data=b"\x01\x02\x03\x04\x05\x06\x07\x08",
        attempt=3,
    )
    raw = packet.encode_data(d)
    assert len(raw) == 33
    assert packet.decode(raw) == d


def test_heartbeat_round_trips() -> None:
    h = packet.Heartbeat(floor=5, next_seq=9, now_us=77)
    raw = packet.encode_heartbeat(h)
    assert len(raw) == 17
    assert packet.decode(raw) == h


def test_ack_round_trips_and_its_bitmap_means_what_the_docs_say() -> None:
    a = packet.Ack(next_expected=100, received=frozenset({101, 103, 355}))
    raw = packet.encode_ack(a)
    assert len(raw) == 37
    assert packet.decode(raw) == a
    # Bit 0 of the bitmap is next_expected + 1, so 101 sets the lowest bit of the first byte.
    assert raw[5] == 0b0000_0101  # 101 and 103
    assert packet.decode(raw).received == a.received  # type: ignore[union-attr]


def test_an_ack_cannot_name_frames_outside_its_window() -> None:
    a = packet.Ack(next_expected=0, received=frozenset({5, packet.WINDOW + 1, 0}))
    assert packet.decode(packet.encode_ack(a)) == packet.Ack(0, frozenset({5}))


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"\x00",
        b"\xd1",
        b"\xd1" + bytes(10),
        b"\xff" * 33,
        b"\xd2" + bytes(5),
        b"\xd3" + b"\xff" * 4 + bytes(12),
    ],  # a heartbeat whose floor is past its next_seq
)
def test_junk_is_refused_with_packet_error(raw: bytes) -> None:
    with pytest.raises(packet.PacketError):
        packet.decode(raw)


def test_a_data_packet_with_impossible_fields_is_refused() -> None:
    good = packet.Data(seq=5, floor=3, next_seq=6, ts_us=0, can_id=1, data=bytes(8), attempt=1)
    raw = bytearray(packet.encode_data(good))
    raw[-1] = 0  # attempt 0 does not exist
    with pytest.raises(packet.PacketError):
        packet.decode(bytes(raw))
    inverted = packet.Data(seq=5, floor=9, next_seq=6, ts_us=0, can_id=1, data=bytes(8), attempt=1)
    with pytest.raises(packet.PacketError):
        packet.decode(packet.encode_data(inverted))


@given(st.binary(max_size=80))
def test_no_byte_string_can_make_decode_raise_anything_else(raw: bytes) -> None:
    with contextlib.suppress(packet.PacketError):
        packet.decode(raw)
