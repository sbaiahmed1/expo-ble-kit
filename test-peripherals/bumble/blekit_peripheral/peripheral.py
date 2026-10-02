"""Bumble implementation of the expo-ble-kit test GATT profile (test-peripherals/profile.json)."""

from __future__ import annotations

import asyncio
import functools
import logging
import operator
import struct
import uuid as uuid_lib
from collections import defaultdict
from collections.abc import Coroutine
from typing import Any, Union

from bumble import att, hci, l2cap
from bumble.device import Connection, Device
from bumble.gatt import Characteristic, CharacteristicValue, Descriptor, Service
from bumble.pairing import PairingConfig, PairingDelegate

from .profile import Profile, decode_value, stream_frame

logger = logging.getLogger(__name__)

# Bluetooth Core Spec Vol 3, Part F, 3.2.9: an attribute value is at most 512 bytes.
MAX_ATTRIBUTE_VALUE_SIZE = 512
# Upper bound for queued prepared-write data per connection.
MAX_PREPARED_WRITE_BYTES = 4096

PROPERTIES = {
    "broadcast": Characteristic.Properties.BROADCAST,
    "read": Characteristic.Properties.READ,
    "writeWithoutResponse": Characteristic.Properties.WRITE_WITHOUT_RESPONSE,
    "write": Characteristic.Properties.WRITE,
    "notify": Characteristic.Properties.NOTIFY,
    "indicate": Characteristic.Properties.INDICATE,
}

PERMISSIONS = {
    "readable": Characteristic.Permissions.READABLE,
    "writeable": Characteristic.Permissions.WRITEABLE,
    "readEncryptionRequired": Characteristic.Permissions.READABLE
    | Characteristic.Permissions.READ_REQUIRES_ENCRYPTION,
    "writeEncryptionRequired": Characteristic.Permissions.WRITEABLE
    | Characteristic.Permissions.WRITE_REQUIRES_ENCRYPTION,
}

AD_FLAGS = {"leLimitedDiscoverable": 0x01, "leGeneralDiscoverable": 0x02, "brEdrNotSupported": 0x04}
AD_TYPE_FLAGS = 0x01
AD_TYPE_COMPLETE_128_BIT_UUIDS = 0x07
AD_TYPE_COMPLETE_LOCAL_NAME = 0x09
AD_TYPE_TX_POWER_LEVEL = 0x0A
AD_TYPE_SERVICE_DATA_16_BIT_UUID = 0x16
AD_TYPE_MANUFACTURER_SPECIFIC_DATA = 0xFF

PARAM_FORMATS = {"uint16le": "H", "uint32le": "I"}


def ad_structure(ad_type: int, payload: bytes) -> bytes:
    return bytes([len(payload) + 1, ad_type]) + payload


def uuid_to_le_bytes(value: str) -> bytes:
    return uuid_lib.UUID(value).bytes[::-1]


def uuid16_to_le_bytes(value: str) -> bytes:
    """2-byte little-endian form of a Bluetooth SIG base UUID (0000xxxx-0000-1000-8000-00805f9b34fb)."""
    return int(value[4:8], 16).to_bytes(2, "little")


class TestPeripheral:
    """Serves the test profile on a Bumble Device. Call start() after device.power_on()."""

    # Not a pytest test class, despite the name.
    __test__ = False

    def __init__(
        self,
        device: Device,
        profile: Profile | None = None,
        heart_rate_interval_s: float | None = None,
    ) -> None:
        self.device = device
        self.profile = profile or Profile.load()

        hr = self.profile.characteristics["HEART_RATE_MEASUREMENT"]
        self.heart_rate_interval_s = heart_rate_interval_s or hr["intervalMs"] / 1000
        self.bpm = hr["minBpm"]

        self.echo_value = decode_value(self.profile.characteristics["ECHO_READ"].get("value"))
        self.sink_count = 0
        self.stream_seq = 0
        self.indicate_seq = 0

        self._tasks: set[asyncio.Task[Any]] = set()
        self._stream_task: asyncio.Task[Any] | None = None
        self._sink_notify_pending = False
        self._prepared_writes: dict[int, list[tuple[int, int, bytes]]] = defaultdict(list)
        self._commands_by_opcode = {c["opcode"]: c for c in self.profile.data["control"]["commands"]}

        self.characteristics: dict[str, Characteristic] = {}
        self.services: dict[str, Service] = {
            key: Service(
                spec["uuid"],
                [self._make_characteristic(c) for c in spec["characteristics"]],
                primary=spec["primary"],
            )
            for key, spec in self.profile.services.items()
        }

        device.pairing_config_factory = lambda _connection: PairingConfig(
            sc=True,
            mitm=False,
            bonding=True,
            delegate=PairingDelegate(io_capability=PairingDelegate.IoCapability.NO_OUTPUT_NO_INPUT),
        )

    # ------------------------------------------------------------------ setup

    def _make_characteristic(self, spec: dict[str, Any]) -> Characteristic:
        properties = functools.reduce(
            operator.or_, (PROPERTIES[p] for p in spec["properties"]), Characteristic.Properties(0)
        )
        permissions = functools.reduce(
            operator.or_, (PERMISSIONS[p] for p in spec["permissions"]), Characteristic.Permissions(0)
        )
        descriptors = [
            Descriptor(d["uuid"], Descriptor.READABLE, decode_value(d["value"]))
            for d in spec.get("descriptors", [])
        ]
        characteristic = Characteristic(
            spec["uuid"], properties, permissions, self._make_value(spec), descriptors
        )
        self.characteristics[spec["key"]] = characteristic
        return characteristic

    def _make_value(self, spec: dict[str, Any]) -> Union[CharacteristicValue, bytes]:
        key = spec["key"]
        if key == "ECHO_WRITE":
            return CharacteristicValue(write=self._on_echo_write)
        if key == "ECHO_READ":
            return CharacteristicValue(read=lambda _connection: self.echo_value)
        if key == "SINK_NO_RSP":
            return CharacteristicValue(write=self._on_sink_write)
        if key == "SINK_COUNTER":
            return CharacteristicValue(read=lambda _connection: self._sink_counter_value())
        if key == "L2CAP_PSM":
            return struct.pack("<H", self.profile.l2cap_echo["psm"])
        if key == "CONTROL":
            return CharacteristicValue(write=self._on_control)
        return decode_value(spec.get("value"))

    def advertising_data(self) -> bytes:
        adv = self.profile.advertising["advertisingData"]
        flags = functools.reduce(operator.or_, (AD_FLAGS[f] for f in adv["flags"]), 0)
        data = ad_structure(AD_TYPE_FLAGS, bytes([flags]))
        data += ad_structure(
            AD_TYPE_COMPLETE_128_BIT_UUIDS,
            b"".join(uuid_to_le_bytes(u) for u in adv["completeServiceUuids128"]),
        )
        for service_uuid, payload in adv.get("serviceData", {}).items():
            data += ad_structure(
                AD_TYPE_SERVICE_DATA_16_BIT_UUID,
                uuid16_to_le_bytes(service_uuid) + bytes.fromhex(payload),
            )
        if "txPowerLevel" in adv:
            data += ad_structure(AD_TYPE_TX_POWER_LEVEL, struct.pack("<b", adv["txPowerLevel"]))
        return data

    def scan_response_data(self, local_name: str | None = None) -> bytes:
        scan = self.profile.advertising["scanResponseData"]
        name = local_name or scan["completeLocalName"]
        data = ad_structure(AD_TYPE_COMPLETE_LOCAL_NAME, name.encode("utf-8"))
        if manufacturer := scan.get("manufacturerData"):
            data += ad_structure(
                AD_TYPE_MANUFACTURER_SPECIFIC_DATA,
                struct.pack("<H", manufacturer["companyId"]) + bytes.fromhex(manufacturer["data"]),
            )
        return data

    async def start(self, local_name: str | None = None) -> None:
        for key, spec in self.profile.services.items():
            if spec["presence"] == "always":
                self.device.add_service(self.services[key])

        echo = self.profile.l2cap_echo
        self.device.create_l2cap_server(
            spec=l2cap.LeCreditBasedChannelSpec(psm=echo["psm"], mtu=echo["mtu"]),
            handler=self._on_l2cap_channel,
        )
        self._install_prepared_writes()
        self.device.on("connection", self._on_connection)
        self._spawn(self._heart_rate_loop())

        interval = self.profile.advertising["intervalMs"]
        await self.device.start_advertising(
            advertising_data=self.advertising_data(),
            scan_response_data=self.scan_response_data(local_name),
            auto_restart=True,
            advertising_interval_min=interval,
            advertising_interval_max=interval,
        )

    async def stop(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await self.device.stop_advertising()

    # ------------------------------------------------------------------ helpers

    def _spawn(self, coroutine: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
        task = asyncio.get_running_loop().create_task(coroutine)
        self._tasks.add(task)

        def done(finished: asyncio.Task[Any]) -> None:
            self._tasks.discard(finished)
            if not finished.cancelled() and (error := finished.exception()):
                logger.error("background task failed", exc_info=error)

        task.add_done_callback(done)
        return task

    def _has_subscribers(self, characteristic: Characteristic) -> bool:
        return any(
            int.from_bytes(cccd, "little") != 0
            for subscriptions in self.device.gatt_server.subscribers.values()
            if (cccd := subscriptions.get(characteristic.handle))
        )

    def _sink_counter_value(self) -> bytes:
        return struct.pack("<I", self.sink_count)

    def _on_connection(self, connection: Connection) -> None:
        connection.on(
            "disconnection",
            lambda _reason: self._prepared_writes.pop(connection.handle, None),
        )

    # ------------------------------------------------------------------ characteristic handlers

    def _on_echo_write(self, _connection: Connection, value: bytes) -> None:
        self.echo_value = bytes(value)

    def _on_sink_write(self, _connection: Connection, value: bytes) -> None:
        self.sink_count = (self.sink_count + len(value)) % 2**32
        if self._sink_notify_pending:
            return
        self._sink_notify_pending = True

        async def notify_later() -> None:
            await asyncio.sleep(self.profile.characteristics["SINK_COUNTER"]["notifyIntervalMs"] / 1000)
            self._sink_notify_pending = False
            await self.device.notify_subscribers(
                self.characteristics["SINK_COUNTER"], self._sink_counter_value()
            )

        self._spawn(notify_later())

    def _on_control(self, connection: Connection, value: bytes) -> None:
        if not value or value[0] not in self._commands_by_opcode:
            raise att.ATT_Error(self.profile.att_error("unknownOpcode"))
        command = self._commands_by_opcode[value[0]]
        params = bytes(value[1:])
        fmt = "<" + "".join(PARAM_FORMATS[p["type"]] for p in command["params"])
        if len(params) != struct.calcsize(fmt):
            raise att.ATT_Error(self.profile.att_error("invalidParameters"))
        handler = getattr(self, f"_command_{command['name'].lower()}")
        handler(connection, *struct.unpack(fmt, params))

    def _on_l2cap_channel(self, channel: l2cap.LeCreditBasedChannel) -> None:
        channel.sink = channel.write

    # ------------------------------------------------------------------ CONTROL commands

    def _command_set_stream(self, _connection: Connection, rate_hz: int, frame_size: int) -> None:
        stream = self.profile.stream
        if rate_hz != 0 and not (
            1 <= rate_hz <= 1000 and stream["minFrameSize"] <= frame_size <= stream["maxFrameSize"]
        ):
            raise att.ATT_Error(self.profile.att_error("invalidParameters"))
        if self._stream_task is not None:
            self._stream_task.cancel()
            self._stream_task = None
        if rate_hz:
            self._stream_task = self._spawn(self._stream_loop(rate_hz, frame_size))

    def _command_disconnect_after(self, connection: Connection, delay_ms: int) -> None:
        async def disconnect_later() -> None:
            await asyncio.sleep(delay_ms / 1000)
            await connection.disconnect(reason=hci.HCI_REMOTE_USER_TERMINATED_CONNECTION_ERROR)

        self._spawn(disconnect_later())

    def _command_toggle_secondary_service(self, _connection: Connection) -> None:
        self._spawn(self._toggle_secondary_service())

    def _command_reset_counters(self, _connection: Connection) -> None:
        self.sink_count = 0
        self.stream_seq = 0
        self.indicate_seq = 0

    def _command_send_indications(self, connection: Connection, count: int) -> None:
        async def send() -> None:
            characteristic = self.characteristics["INDICATE"]
            for _ in range(count):
                value = struct.pack("<I", self.indicate_seq)
                self.indicate_seq = (self.indicate_seq + 1) % 2**32
                await self.device.indicate_subscriber(connection, characteristic, value)

        self._spawn(send())

    # ------------------------------------------------------------------ background behaviors

    async def _stream_loop(self, rate_hz: int, frame_size: int) -> None:
        loop = asyncio.get_running_loop()
        characteristic = self.characteristics["STREAM"]
        interval = 1 / rate_hz
        deadline = loop.time()
        while True:
            # Sequence numbers only advance for frames that someone receives, so a gap
            # always means a lost frame.
            if self._has_subscribers(characteristic):
                await self.device.notify_subscribers(
                    characteristic, stream_frame(self.stream_seq, frame_size)
                )
                self.stream_seq = (self.stream_seq + 1) % 2**32
            deadline += interval
            delay = deadline - loop.time()
            if delay < -1:
                deadline = loop.time()  # fell far behind: don't burst to catch up
            await asyncio.sleep(max(0.0, delay))

    async def _heart_rate_loop(self) -> None:
        hr = self.profile.characteristics["HEART_RATE_MEASUREMENT"]
        characteristic = self.characteristics["HEART_RATE_MEASUREMENT"]
        while True:
            await asyncio.sleep(self.heart_rate_interval_s)
            if self._has_subscribers(characteristic):
                await self.device.notify_subscribers(characteristic, bytes([0x00, self.bpm]))
                self.bpm = self.bpm + 1 if self.bpm < hr["maxBpm"] else hr["minBpm"]

    async def _toggle_secondary_service(self) -> None:
        server = self.device.gatt_server
        service = self.services["SECONDARY"]
        if service in server.services:
            # SECONDARY is always the last service, so removing it never moves other handles.
            assert server.services[-1] is service
            start, end = service.handle, service.end_group_handle
            server.attributes = [a for a in server.attributes if a.handle < start]
            server.services.remove(service)
            for handle in range(start, end + 1):
                server.attributes_by_handle.pop(handle, None)
        else:
            server.add_service(service)
            start, end = service.handle, service.end_group_handle
        logger.info("SECONDARY service %s (0x%04X-0x%04X)",
                    "added" if service in server.services else "removed", start, end)

        gatt_service = self.device.gatt_service
        if gatt_service is not None and gatt_service.service_changed_characteristic is not None:
            await self.device.indicate_subscribers(
                gatt_service.service_changed_characteristic, struct.pack("<HH", start, end)
            )

    # ------------------------------------------------------------------ prepared (long) writes

    def _install_prepared_writes(self) -> None:
        """Adds ATT Prepare/Execute Write support, which Bumble's GATT server lacks."""
        server = self.device.gatt_server

        def error(connection: Connection, request: att.ATT_PDU, handle: int, code: int) -> None:
            server.send_response(
                connection,
                att.ATT_Error_Response(
                    request_opcode_in_error=request.op_code,
                    attribute_handle_in_error=handle,
                    error_code=code,
                ),
            )

        def on_prepare(connection: Connection, request: att.ATT_Prepare_Write_Request) -> None:
            attribute = server.get_attribute(request.attribute_handle)
            if attribute is None:
                return error(connection, request, request.attribute_handle, att.ATT_INVALID_HANDLE_ERROR)
            if not (
                isinstance(attribute, Characteristic)
                and attribute.properties & Characteristic.Properties.WRITE
            ):
                return error(connection, request, request.attribute_handle, att.ATT_WRITE_NOT_PERMITTED_ERROR)
            queue = self._prepared_writes[connection.handle]
            if sum(len(part) for _, _, part in queue) + len(request.part_attribute_value) > MAX_PREPARED_WRITE_BYTES:
                return error(connection, request, request.attribute_handle, att.ATT_PREPARE_QUEUE_FULL_ERROR)
            queue.append((request.attribute_handle, request.value_offset, bytes(request.part_attribute_value)))
            server.send_response(
                connection,
                att.ATT_Prepare_Write_Response(
                    attribute_handle=request.attribute_handle,
                    value_offset=request.value_offset,
                    part_attribute_value=request.part_attribute_value,
                ),
            )

        async def execute(connection: Connection, request: att.ATT_Execute_Write_Request) -> None:
            queue = self._prepared_writes.pop(connection.handle, [])
            if request.flags == 0x00:  # cancel all prepared writes
                return server.send_response(connection, att.ATT_Execute_Write_Response())
            values: dict[int, bytearray] = {}
            for handle, offset, part in queue:
                buffer = values.setdefault(handle, bytearray())
                if offset != len(buffer):
                    return error(connection, request, handle, att.ATT_INVALID_OFFSET_ERROR)
                buffer += part
            for handle, buffer in values.items():
                if len(buffer) > MAX_ATTRIBUTE_VALUE_SIZE:
                    return error(connection, request, handle, att.ATT_INVALID_ATTRIBUTE_LENGTH_ERROR)
                attribute = server.get_attribute(handle)
                try:
                    await attribute.write_value(connection, bytes(buffer))
                except att.ATT_Error as write_error:
                    return error(connection, request, handle, write_error.error_code)
            server.send_response(connection, att.ATT_Execute_Write_Response())

        server.on_att_prepare_write_request = on_prepare
        server.on_att_execute_write_request = lambda connection, request: self._spawn(
            execute(connection, request)
        )
