"""Two Bumble devices on an in-memory radio (LocalLink): the test peripheral and a central."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass

import pytest_asyncio
from bumble.controller import Controller
from bumble.core import UUID
from bumble.device import Connection, Device, Peer
from bumble.gatt_client import CharacteristicProxy
from bumble.hci import Address
from bumble.host import Host
from bumble.link import LocalLink
from bumble.transport.common import AsyncPipeSink

from blekit_peripheral.peripheral import TestPeripheral
from blekit_peripheral.profile import Profile

PERIPHERAL_ADDRESS = "C0:FF:EE:00:00:01"
CENTRAL_ADDRESS = "C0:FF:EE:00:00:02"


def make_device(link: LocalLink, name: str, address: str) -> Device:
    controller = Controller(name, link=link)
    return Device(name=name, address=Address(address), host=Host(controller, AsyncPipeSink(controller)))


@dataclass
class Devices:
    profile: Profile
    peripheral: TestPeripheral
    central: Device


@dataclass
class Rig(Devices):
    connection: Connection
    peer: Peer

    def characteristic(self, key: str) -> CharacteristicProxy:
        found = self.peer.get_characteristics_by_uuid(UUID(self.profile.uuid(key)))
        assert found, f"{key} not discovered"
        return found[0]


@pytest_asyncio.fixture
async def devices() -> AsyncIterator[Devices]:
    link = LocalLink()
    profile = Profile.load()
    peripheral_device = make_device(link, "BleKit-Test", PERIPHERAL_ADDRESS)
    central = make_device(link, "central", CENTRAL_ADDRESS)
    peripheral = TestPeripheral(peripheral_device, profile, heart_rate_interval_s=0.05)
    await peripheral_device.power_on()
    await central.power_on()
    await peripheral.start()
    yield Devices(profile, peripheral, central)
    await peripheral.stop()


@pytest_asyncio.fixture
async def rig(devices: Devices) -> Rig:
    connection = await devices.central.connect(devices.peripheral.device.random_address)
    peer = Peer(connection)
    await peer.discover_all()
    return Rig(devices.profile, devices.peripheral, devices.central, connection, peer)
