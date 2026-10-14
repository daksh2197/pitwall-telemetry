"""The car's CAN bus: the lap from profile.py, packed into raw 8-byte frames with the DBC.

Three messages go out, each at its own rate, offset from each other the way nodes on a real
bus are (two ECUs do not transmit in the same microsecond):

    ENGINE      id 256  every 10 ms   (100 Hz)  at 0 ms into each period
    CHASSIS     id 257  every 10 ms   (100 Hz)  at 3 ms
    DRIVETRAIN  id 258  every 50 ms   (20 Hz)   at 6 ms

Time is simulated and counted in whole microseconds, so a run is the same on every machine.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import cantools

from car.profile import Lap, State

DBC_PATH = Path(__file__).resolve().parent.parent / "dbc" / "pitwall.dbc"

ENGINE_ID = 256
CHASSIS_ID = 257
DRIVETRAIN_ID = 258

# (id, period in ms, offset in ms)
SCHEDULE = ((ENGINE_ID, 10, 0), (CHASSIS_ID, 10, 3), (DRIVETRAIN_ID, 50, 6))

# What the full run sends per second, for anyone doing the sums: 100 + 100 + 20.
FRAMES_PER_SECOND = 220


@dataclass(frozen=True)
class Frame:
    """One CAN frame as it left the car: when, which message, and eight raw bytes."""

    ts_us: int
    can_id: int
    data: bytes


def load_database() -> cantools.database.can.Database:
    db = cantools.database.load_file(str(DBC_PATH))
    assert isinstance(db, cantools.database.can.Database)
    return db


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


class CarSim:
    """Emits the car's frames, in time order, for a given seed and run length."""

    def __init__(self, seed: int, duration_s: float) -> None:
        self.seed = seed
        self.duration_ms = round(duration_s * 1000)
        self.lap = Lap(seed)
        self.db = load_database()

    def _signals(self, can_id: int, s: State) -> dict[str, float]:
        if can_id == ENGINE_ID:
            return {"EngineRPM": s.rpm, "Throttle": s.throttle_pct}
        if can_id == CHASSIS_ID:
            return {
                "Speed": s.speed_kph,
                "BrakePressure": s.brake_pct,
                "SteeringAngle": s.steering_deg,
            }
        return {
            "Gear": s.gear,
            "BrakeOn": 1 if s.brake_pct > 2.0 else 0,
            "ShiftLight": 1 if s.rpm > 0.96 * 11500 else 0,
            "CoolantTemp": s.coolant_c,
        }

    def encode(self, can_id: int, state: State) -> bytes:
        """Pack one message. Values are clamped to the DBC's declared range first."""
        message = self.db.get_message_by_frame_id(can_id)
        values: dict[str, float] = {}
        for name, value in self._signals(can_id, state).items():
            sig = message.get_signal_by_name(name)
            low = sig.minimum if sig.minimum is not None else float("-inf")
            high = sig.maximum if sig.maximum is not None else float("inf")
            values[name] = _clamp(value, low, high)
        data = message.encode(values, strict=True)
        return bytes(data)

    def frames(self) -> Iterator[Frame]:
        for ms in range(self.duration_ms):
            state: State | None = None
            for can_id, period, offset in SCHEDULE:
                if ms % period == offset:
                    state = state or self.lap.state_at(ms)
                    yield Frame(ms * 1000, can_id, self.encode(can_id, state))
