"""The DBC file, checked against frames packed by hand.

Each frame below is worked out on paper from the bit layout in dbc/pitwall.dbc, not produced
by the library, so a mistake in the DBC or in how it is read shows up here.
"""

from __future__ import annotations

import pytest
from hypothesis import given
from hypothesis import strategies as st

from car.sim import CHASSIS_ID, DRIVETRAIN_ID, ENGINE_ID, load_database
from pitwall.decode import Decoder


@pytest.fixture(scope="module")
def decoder() -> Decoder:
    return Decoder()


def test_little_endian_unsigned_signal_with_a_scale(decoder: Decoder) -> None:
    # EngineRPM: bits 0-15 little-endian, 0.25 rpm per step. 8000 rpm is raw 32000 = 0x7D00,
    # which goes on the wire low byte first: 00 7D.
    # Throttle: byte 2, 0.4 % per step. 50 % is raw 125 = 0x7D.
    frame = bytes([0x00, 0x7D, 0x7D, 0, 0, 0, 0, 0])
    assert decoder.decode(ENGINE_ID, frame) == {"EngineRPM": 8000.0, "Throttle": 50.0}


def test_big_endian_signal_reads_the_high_byte_first(decoder: Decoder) -> None:
    # Speed: Motorola, starts at bit 7 (the top of byte 0), 16 bits, 0.01 km/h per step.
    # 123.45 km/h is raw 12345 = 0x3039, high byte first: 30 39.
    # The same two bytes read the other way round would be 0x3930 = 14640 = 146.40 km/h.
    frame = bytes([0x30, 0x39, 0, 0, 0, 0, 0, 0])
    assert decoder.decode(CHASSIS_ID, frame)["Speed"] == 123.45  # type: ignore[index]
    assert int.from_bytes(frame[:2], "little") * 0.01 != pytest.approx(123.45)


def test_a_ten_bit_signal_that_crosses_a_byte_boundary(decoder: Decoder) -> None:
    # BrakePressure: bits 16-25 little-endian, 0.1 % per step. 37.5 % is raw 375 = 0b01_0111_0111.
    # Low 8 bits (0x77) fill byte 2. The top 2 bits (0b01) are the bottom of byte 3.
    frame = bytes([0, 0, 0x77, 0x01, 0, 0, 0, 0])
    assert decoder.decode(CHASSIS_ID, frame)["BrakePressure"] == 37.5  # type: ignore[index]


def test_a_signed_signal_reads_twos_complement(decoder: Decoder) -> None:
    # SteeringAngle: bits 32-47 little-endian, signed, 0.1 deg per step.
    # -12.3 deg is raw -123. In 16 bits that is 65536 - 123 = 0xFF85, low byte first: 85 FF.
    frame = bytes([0, 0, 0, 0, 0x85, 0xFF, 0, 0])
    assert decoder.decode(CHASSIS_ID, frame)["SteeringAngle"] == -12.3  # type: ignore[index]
    positive = bytes([0, 0, 0, 0, 0x7B, 0x00, 0, 0])  # +123 raw
    assert decoder.decode(CHASSIS_ID, positive)["SteeringAngle"] == 12.3  # type: ignore[index]


def test_bit_packed_flags_and_a_four_bit_gear_share_one_byte(decoder: Decoder) -> None:
    # Byte 0 = 0b0010_1101: bits 0-3 are the gear (0b1101 = 13), bit 4 BrakeOn (0),
    # bit 5 ShiftLight (1).
    # Byte 1 is CoolantTemp with an offset of -40: raw 130 means 90 degC.
    frame = bytes([0b0010_1101, 130, 0, 0, 0, 0, 0, 0])
    assert decoder.decode(DRIVETRAIN_ID, frame) == {
        "Gear": 13.0,
        "BrakeOn": 0.0,
        "ShiftLight": 1.0,
        "CoolantTemp": 90.0,
    }
    brake_on = bytes([0b0001_0110, 0, 0, 0, 0, 0, 0, 0])  # gear 6, BrakeOn 1, ShiftLight 0
    got = decoder.decode(DRIVETRAIN_ID, brake_on)
    assert got is not None
    assert (got["Gear"], got["BrakeOn"], got["ShiftLight"], got["CoolantTemp"]) == (6, 1, 0, -40)


def test_encoding_matches_the_hand_packed_frame() -> None:
    db = load_database()
    packed = db.get_message_by_frame_id(CHASSIS_ID).encode(
        {"Speed": 123.45, "BrakePressure": 37.5, "SteeringAngle": -12.3}
    )
    assert bytes(packed) == bytes([0x30, 0x39, 0x77, 0x01, 0x85, 0xFF, 0, 0])


def test_unknown_ids_and_short_frames_are_counted_not_raised() -> None:
    decoder = Decoder()
    assert decoder.decode(0x7FF, bytes(8)) is None
    assert decoder.decode(ENGINE_ID, bytes(3)) is None
    assert decoder.stats.unknown_id == 1
    assert decoder.stats.bad_frame == 1
    assert decoder.stats.decoded == 0


@given(
    speed=st.integers(0, 65535),
    brake=st.integers(0, 1023),
    steer=st.integers(-32768, 32767),
)
def test_chassis_round_trips_every_raw_value(speed: int, brake: int, steer: int) -> None:
    """Pack raw numbers by hand, decode with the DBC, and get the same raw numbers back."""
    frame = bytearray(8)
    frame[0:2] = speed.to_bytes(2, "big")
    frame[2:4] = brake.to_bytes(2, "little")
    frame[4:6] = steer.to_bytes(2, "little", signed=True)
    got = Decoder().decode(CHASSIS_ID, bytes(frame))
    assert got is not None
    assert got["Speed"] == pytest.approx(speed * 0.01, abs=1e-3)
    assert got["BrakePressure"] == pytest.approx(brake * 0.1, abs=1e-3)
    assert got["SteeringAngle"] == pytest.approx(steer * 0.1, abs=1e-3)
