"""Turn raw CAN frames into named, scaled signals, using the DBC file.

The DBC says where each signal sits in the eight bytes, which way round the bytes go, whether
the number is signed, and how to scale it. This module does not know any of that. It asks
`cantools`, and counts what it could not read instead of crashing on it.
"""

from __future__ import annotations

from dataclasses import dataclass

import cantools

from car.sim import load_database


@dataclass
class DecodeStats:
    decoded: int = 0
    unknown_id: int = 0  # a frame id the DBC has no message for
    bad_frame: int = 0  # the right id but bytes the DBC cannot read (wrong length)


class Decoder:
    def __init__(self, db: cantools.database.can.Database | None = None) -> None:
        self.db = db or load_database()
        self.stats = DecodeStats()

    def message_names(self) -> dict[int, str]:
        return {m.frame_id: m.name for m in self.db.messages}

    def signal_info(self) -> dict[str, dict[str, object]]:
        """Name, unit and range of every signal, for the dashboard's axes."""
        info: dict[str, dict[str, object]] = {}
        for message in self.db.messages:
            for sig in message.signals:
                info[sig.name] = {
                    "unit": sig.unit or "",
                    "min": sig.minimum,
                    "max": sig.maximum,
                    "message": message.name,
                }
        return info

    def decode(self, can_id: int, data: bytes) -> dict[str, float] | None:
        """Signals as plain numbers, or None if the frame cannot be read."""
        try:
            message = self.db.get_message_by_frame_id(can_id)
        except KeyError:
            self.stats.unknown_id += 1
            return None
        try:
            raw = message.decode(data, decode_choices=False, scaling=True)
        except (cantools.database.DecodeError, ValueError):
            self.stats.bad_frame += 1
            return None
        assert isinstance(raw, dict)
        self.stats.decoded += 1
        return {name: round(float(value), 3) for name, value in raw.items()}  # type: ignore[arg-type]
