"""Consistency checks for test-peripherals/profile.json."""

import re

from blekit_peripheral.peripheral import PERMISSIONS, PROPERTIES
from blekit_peripheral.profile import Profile, decode_value, pattern_bytes, stream_frame

profile = Profile.load()
SIG_BASE = re.compile(r"^0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb$")


def custom_uuid_pattern() -> re.Pattern[str]:
    base = profile.data["uuidBase"]
    return re.compile("^" + re.escape(base[:4]) + "[0-9a-f]{4}" + re.escape(base[8:]) + "$")


def all_uuids() -> list[str]:
    return [s["uuid"] for s in profile.data["services"]] + [
        c["uuid"] for c in profile.characteristics.values()
    ]


def test_uuids_are_lowercase_unique_and_derived_from_the_base() -> None:
    uuids = all_uuids()
    assert len(uuids) == len(set(uuids))
    custom = custom_uuid_pattern()
    for value in uuids:
        assert value == value.lower()
        assert custom.match(value) or SIG_BASE.match(value), value


def test_keys_are_unique() -> None:
    keys = [s["key"] for s in profile.data["services"]] + [
        c["key"] for s in profile.data["services"] for c in s["characteristics"]
    ]
    assert len(keys) == len(set(keys))


def test_every_plan_characteristic_is_defined() -> None:
    # docs/ARCHITECTURE_AND_PLAN.md §8.3
    expected = {
        "STATIC_READ": ["read"],
        "LONG_READ": ["read"],
        "ECHO_WRITE": ["write"],
        "ECHO_READ": ["read"],
        "SINK_NO_RSP": ["writeWithoutResponse"],
        "SINK_COUNTER": ["read", "notify"],
        "STREAM": ["notify"],
        "INDICATE": ["indicate"],
        "SECURE": ["read"],
        "L2CAP_PSM": ["read"],
        "CONTROL": ["write"],
    }
    for key, properties in expected.items():
        assert profile.characteristics[key]["properties"] == properties, key
    assert profile.uuid("HEART_RATE") == "0000180d-0000-1000-8000-00805f9b34fb"
    assert profile.uuid("HEART_RATE_MEASUREMENT") == "00002a37-0000-1000-8000-00805f9b34fb"


def test_properties_and_permissions_use_known_names() -> None:
    for characteristic in profile.characteristics.values():
        assert set(characteristic["properties"]) <= PROPERTIES.keys()
        assert set(characteristic["permissions"]) <= PERMISSIONS.keys()


def test_values() -> None:
    assert decode_value(profile.characteristics["STATIC_READ"]["value"]) == bytes(range(20))
    long_read = decode_value(profile.characteristics["LONG_READ"]["value"])
    assert len(long_read) == 512
    assert long_read[:3] == bytes([7, 38, 69])
    assert pattern_bytes(5, 31, 7, 251) == long_read[:5]
    assert decode_value(profile.characteristics["SECURE"]["value"]) == b"SECURE01"


def test_stream_frame_format() -> None:
    frame = stream_frame(0x01020304, 8)
    assert frame == bytes([0x04, 0x03, 0x02, 0x01, 0x04, 0x05, 0x06, 0x07])
    assert len(stream_frame(5, profile.stream["minFrameSize"])) == 4


def test_control_opcodes_are_unique() -> None:
    opcodes = [c["opcode"] for c in profile.data["control"]["commands"]]
    assert len(opcodes) == len(set(opcodes))
