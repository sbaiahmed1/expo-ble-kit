"""Loads test-peripherals/profile.json, the single source of truth for the test GATT profile."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

DEFAULT_PROFILE_PATH = Path(__file__).resolve().parents[2] / "profile.json"


def pattern_bytes(length: int, multiplier: int, offset: int, modulus: int) -> bytes:
    """b[i] = (i * multiplier + offset) % modulus, as defined by profile.json `patterns`."""
    return bytes((i * multiplier + offset) % modulus for i in range(length))


def decode_value(spec: dict[str, Any] | None) -> bytes:
    """Decodes a profile value spec: {"pattern": {...}}, {"hex": "..."} or {"utf8": "..."}."""
    if spec is None:
        return b""
    if "pattern" in spec:
        return pattern_bytes(**spec["pattern"])
    if "hex" in spec:
        return bytes.fromhex(spec["hex"])
    if "utf8" in spec:
        return spec["utf8"].encode("utf-8")
    raise ValueError(f"Unknown value spec: {spec}")


def stream_frame(seq: int, size: int) -> bytes:
    """STREAM frame: uint32 LE sequence number, then p[j] = (seq + j) % 256."""
    return (seq % 2**32).to_bytes(4, "little") + bytes((seq + j) % 256 for j in range(size - 4))


class Profile:
    def __init__(self, data: dict[str, Any]) -> None:
        self.data = data
        self.services: dict[str, dict[str, Any]] = {s["key"]: s for s in data["services"]}
        self.characteristics: dict[str, dict[str, Any]] = {
            c["key"]: c for s in data["services"] for c in s["characteristics"]
        }
        self.commands: dict[str, dict[str, Any]] = {
            c["name"]: c for c in data["control"]["commands"]
        }

    @classmethod
    def load(cls, path: str | Path | None = None) -> Profile:
        with open(path or DEFAULT_PROFILE_PATH, encoding="utf-8") as file:
            return cls(json.load(file))

    @property
    def advertising(self) -> dict[str, Any]:
        return self.data["advertising"]

    @property
    def stream(self) -> dict[str, Any]:
        return self.data["stream"]

    @property
    def l2cap_echo(self) -> dict[str, Any]:
        return self.data["l2cap"]["echo"]

    def uuid(self, key: str) -> str:
        """UUID of a service or characteristic, by key."""
        if key in self.services:
            return self.services[key]["uuid"]
        return self.characteristics[key]["uuid"]

    def opcode(self, command: str) -> int:
        return self.commands[command]["opcode"]

    def att_error(self, name: str) -> int:
        return self.data["control"]["errors"][name]["attError"]
