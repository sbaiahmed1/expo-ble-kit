"""Behavior of the Bumble test peripheral, exercised by a Bumble central over an in-memory radio."""

from __future__ import annotations

import asyncio
import struct

import pytest
from bumble import att, gatt, l2cap
from bumble.core import UUID

from blekit_peripheral.peripheral import TestPeripheral
from blekit_peripheral.profile import decode_value, stream_frame

from .conftest import Devices, Rig

AD_TYPE_COMPLETE_128_BIT_UUIDS = 0x07
AD_TYPE_COMPLETE_LOCAL_NAME = 0x09
AD_TYPE_MANUFACTURER_SPECIFIC_DATA = 0xFF


def parse_ad(data: bytes) -> dict[int, bytes]:
    structures: dict[int, bytes] = {}
    i = 0
    while i < len(data):
        length = data[i]
        structures[data[i + 1]] = data[i + 2 : i + 1 + length]
        i += 1 + length
    return structures


def control(rig: Rig, command: str, *params: int) -> bytes:
    spec = rig.profile.commands[command]
    fmt = "<" + "".join({"uint16le": "H", "uint32le": "I"}[p["type"]] for p in spec["params"])
    return bytes([spec["opcode"]]) + struct.pack(fmt, *params)


async def write_control(rig: Rig, command: str, *params: int) -> None:
    await rig.peer.write_value(rig.characteristic("CONTROL"), control(rig, command, *params), with_response=True)


async def att_error(awaitable) -> int:
    with pytest.raises(att.ATT_Error) as error:
        await awaitable
    return error.value.error_code


# ---------------------------------------------------------------- advertising


def test_advertising_and_scan_response_fit_legacy_pdus(devices: Devices) -> None:
    adv = devices.peripheral.advertising_data()
    scan = devices.peripheral.scan_response_data()
    assert len(adv) <= 31 and len(scan) <= 31

    adv_fields = parse_ad(adv)
    test_service = UUID(devices.profile.uuid("TEST")).to_bytes()
    assert adv_fields[AD_TYPE_COMPLETE_128_BIT_UUIDS] == test_service

    scan_fields = parse_ad(scan)
    assert scan_fields[AD_TYPE_COMPLETE_LOCAL_NAME] == b"BleKit-Test"
    assert scan_fields[AD_TYPE_MANUFACTURER_SPECIFIC_DATA] == bytes.fromhex("ffff424b0001")


async def test_scanner_sees_the_advertisement(devices: Devices) -> None:
    found: asyncio.Future[bytes] = asyncio.get_running_loop().create_future()

    def on_advertisement(advertisement) -> None:
        if not found.done() and advertisement.address == devices.peripheral.device.random_address:
            found.set_result(bytes(advertisement.data))

    devices.central.on("advertisement", on_advertisement)
    await devices.central.start_scanning()
    data = await asyncio.wait_for(found, timeout=5)
    assert UUID(devices.profile.uuid("TEST")).to_bytes() in data


# ---------------------------------------------------------------- discovery


async def test_discovers_the_profile(rig: Rig) -> None:
    for key, spec in rig.profile.services.items():
        services = rig.peer.get_services_by_uuid(UUID(spec["uuid"]))
        if spec["presence"] == "toggled":
            assert services == [], key
            continue
        assert len(services) == 1, key
        for characteristic in spec["characteristics"]:
            proxy = rig.characteristic(characteristic["key"])
            expected = TestPeripheral(rig.peripheral.device, rig.profile)._make_characteristic(characteristic)
            assert proxy.properties == expected.properties, characteristic["key"]


async def test_stream_has_user_description(rig: Rig) -> None:
    stream = rig.characteristic("STREAM")
    descriptors = await stream.discover_descriptors()
    description = next(d for d in descriptors if d.type == gatt.GATT_CHARACTERISTIC_USER_DESCRIPTION_DESCRIPTOR)
    assert await description.read_value() == b"Stream"


# ---------------------------------------------------------------- reads and writes


async def test_static_and_long_reads(rig: Rig) -> None:
    assert await rig.peer.read_value(rig.characteristic("STATIC_READ")) == bytes(range(20))
    long_value = await rig.peer.read_value(rig.characteristic("LONG_READ"))
    assert long_value == decode_value(rig.profile.characteristics["LONG_READ"]["value"])


async def test_echo(rig: Rig) -> None:
    assert await rig.peer.read_value(rig.characteristic("ECHO_READ")) == b""
    await rig.peer.write_value(rig.characteristic("ECHO_WRITE"), b"hello", with_response=True)
    assert await rig.peer.read_value(rig.characteristic("ECHO_READ")) == b"hello"


async def test_long_echo_write_uses_prepared_writes(rig: Rig) -> None:
    echo_write = rig.characteristic("ECHO_WRITE")
    value = bytes((i * 13) % 256 for i in range(512))
    chunk = rig.connection.att_mtu - 5
    client = rig.peer.gatt_client
    for offset in range(0, len(value), chunk):
        response = await client.send_request(
            att.ATT_Prepare_Write_Request(
                attribute_handle=echo_write.handle,
                value_offset=offset,
                part_attribute_value=value[offset : offset + chunk],
            )
        )
        assert isinstance(response, att.ATT_Prepare_Write_Response)
    response = await client.send_request(att.ATT_Execute_Write_Request(flags=0x01))
    assert isinstance(response, att.ATT_Execute_Write_Response)
    assert await rig.peer.read_value(rig.characteristic("ECHO_READ")) == value


async def test_prepared_writes_reject_values_over_512_bytes(rig: Rig) -> None:
    echo_write = rig.characteristic("ECHO_WRITE")
    client = rig.peer.gatt_client
    chunk = rig.connection.att_mtu - 5
    for offset in range(0, 513, chunk):
        await client.send_request(
            att.ATT_Prepare_Write_Request(
                attribute_handle=echo_write.handle,
                value_offset=offset,
                part_attribute_value=bytes(min(chunk, 513 - offset)),
            )
        )
    response = await client.send_request(att.ATT_Execute_Write_Request(flags=0x01))
    assert isinstance(response, att.ATT_Error_Response)
    assert response.error_code == att.ATT_INVALID_ATTRIBUTE_LENGTH_ERROR


async def test_sink_counts_bytes_and_notifies(rig: Rig) -> None:
    notified: list[bytes] = []
    await rig.peer.subscribe(rig.characteristic("SINK_COUNTER"), notified.append)
    sink = rig.characteristic("SINK_NO_RSP")
    for _ in range(10):
        await rig.peer.write_value(sink, bytes(20), with_response=False)
    await asyncio.sleep(0.3)
    counter = await rig.peer.read_value(rig.characteristic("SINK_COUNTER"))
    assert struct.unpack("<I", counter)[0] == 200
    assert notified and struct.unpack("<I", notified[-1])[0] == 200

    await write_control(rig, "RESET_COUNTERS")
    assert await rig.peer.read_value(rig.characteristic("SINK_COUNTER")) == struct.pack("<I", 0)


# ---------------------------------------------------------------- notifications and indications


async def collect_stream(rig: Rig, rate_hz: int, frame_size: int, seconds: float) -> list[bytes]:
    frames: list[bytes] = []
    await rig.peer.subscribe(rig.characteristic("STREAM"), frames.append)
    await write_control(rig, "SET_STREAM", rate_hz, frame_size)
    await asyncio.sleep(seconds)
    await write_control(rig, "SET_STREAM", 0, 0)
    await asyncio.sleep(0.05)
    return frames


async def test_stream_frames_are_sequential(rig: Rig) -> None:
    frames = await collect_stream(rig, rate_hz=200, frame_size=20, seconds=0.5)
    assert len(frames) >= 20
    first = struct.unpack("<I", frames[0][:4])[0]
    for index, frame in enumerate(frames):
        assert frame == stream_frame(first + index, 20)


async def test_stream_frames_are_truncated_to_the_mtu(rig: Rig) -> None:
    frames = await collect_stream(rig, rate_hz=50, frame_size=100, seconds=0.2)
    assert frames
    assert all(len(frame) == rig.connection.att_mtu - 3 for frame in frames)
    assert frames[0] == stream_frame(struct.unpack("<I", frames[0][:4])[0], 100)[: rig.connection.att_mtu - 3]


async def test_reset_counters_restarts_the_stream_sequence(rig: Rig) -> None:
    await collect_stream(rig, rate_hz=100, frame_size=8, seconds=0.1)
    await write_control(rig, "RESET_COUNTERS")
    frames = await collect_stream(rig, rate_hz=100, frame_size=8, seconds=0.1)
    assert struct.unpack("<I", frames[0][:4])[0] == 0


async def test_indications_carry_sequence_numbers(rig: Rig) -> None:
    received: list[bytes] = []
    await rig.peer.subscribe(rig.characteristic("INDICATE"), received.append, prefer_notify=False)
    await write_control(rig, "SEND_INDICATIONS", 5)
    for _ in range(50):
        if len(received) == 5:
            break
        await asyncio.sleep(0.02)
    assert [struct.unpack("<I", value)[0] for value in received] == [0, 1, 2, 3, 4]


async def test_heart_rate_notifications(rig: Rig) -> None:
    received: list[bytes] = []
    await rig.peer.subscribe(rig.characteristic("HEART_RATE_MEASUREMENT"), received.append)
    await asyncio.sleep(0.3)
    assert len(received) >= 2
    assert all(value[0] == 0x00 for value in received)
    assert received[1][1] == received[0][1] + 1


# ---------------------------------------------------------------- CONTROL


async def test_control_rejects_invalid_commands(rig: Rig) -> None:
    write = rig.characteristic("CONTROL")
    unknown = rig.profile.att_error("unknownOpcode")
    invalid = rig.profile.att_error("invalidParameters")
    assert await att_error(rig.peer.write_value(write, b"", with_response=True)) == unknown
    assert await att_error(rig.peer.write_value(write, b"\x7f", with_response=True)) == unknown
    assert await att_error(rig.peer.write_value(write, b"\x01\x10", with_response=True)) == invalid
    assert await att_error(rig.peer.write_value(write, control(rig, "SET_STREAM", 2000, 20), with_response=True)) == invalid
    assert await att_error(rig.peer.write_value(write, control(rig, "SET_STREAM", 10, 2), with_response=True)) == invalid


async def test_disconnect_after(rig: Rig) -> None:
    reason: asyncio.Future[int] = asyncio.get_running_loop().create_future()
    rig.connection.on("disconnection", reason.set_result)
    await write_control(rig, "DISCONNECT_AFTER", 50)
    assert await asyncio.wait_for(reason, timeout=2) == 0x13


async def test_toggle_secondary_service_indicates_service_changed(rig: Rig) -> None:
    service_changed = rig.peer.get_characteristics_by_uuid(gatt.GATT_SERVICE_CHANGED_CHARACTERISTIC)[0]
    ranges: list[tuple[int, int]] = []
    await rig.peer.subscribe(service_changed, lambda value: ranges.append(struct.unpack("<HH", value)), prefer_notify=False)
    secondary = UUID(rig.profile.uuid("SECONDARY"))

    await write_control(rig, "TOGGLE_SECONDARY_SERVICE")
    await asyncio.sleep(0.1)
    found = await rig.peer.gatt_client.discover_services([secondary])
    assert len(found) == 1
    assert ranges == [(found[0].handle, found[0].end_group_handle)]
    characteristics = await found[0].discover_characteristics()
    assert await characteristics[0].read_value() == b"SECONDARY"

    await write_control(rig, "TOGGLE_SECONDARY_SERVICE")
    await asyncio.sleep(0.1)
    assert len(ranges) == 2 and ranges[1] == ranges[0]
    assert await att_error(rig.peer.read_value(characteristics[0].handle)) == att.ATT_INVALID_HANDLE_ERROR


# ---------------------------------------------------------------- security and L2CAP


async def test_secure_requires_encryption(rig: Rig) -> None:
    secure = rig.characteristic("SECURE")
    assert await att_error(rig.peer.read_value(secure)) == att.ATT_INSUFFICIENT_ENCRYPTION_ERROR
    await rig.connection.pair()
    assert await rig.peer.read_value(secure) == b"SECURE01"


async def test_l2cap_echo(rig: Rig) -> None:
    psm = struct.unpack("<H", await rig.peer.read_value(rig.characteristic("L2CAP_PSM")))[0]
    assert psm == rig.profile.l2cap_echo["psm"]
    channel = await rig.central.create_l2cap_channel(rig.connection, l2cap.LeCreditBasedChannelSpec(psm=psm))
    received = bytearray()
    channel.sink = received.extend
    payload = bytes(i % 256 for i in range(1000))
    channel.write(payload)
    for _ in range(100):
        if len(received) >= len(payload):
            break
        await asyncio.sleep(0.02)
    assert bytes(received) == payload
