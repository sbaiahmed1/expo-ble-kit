"""Runs the expo-ble-kit test peripheral on a Bumble transport.

Examples:
  blekit-peripheral android-netsim          # attach to a running Android emulator's virtual radio
  blekit-peripheral usb:0                   # a USB Bluetooth dongle (see Bumble's USB transport docs)
  blekit-peripheral android-netsim --name BleKit-Test-2 --address C0:FF:EE:00:00:02
"""

from __future__ import annotations

import argparse
import asyncio
import logging

from bumble.device import Device
from bumble.hci import Address
from bumble.transport import open_transport_or_link

from .peripheral import TestPeripheral
from .profile import Profile

DEFAULT_ADDRESS = "C0:FF:EE:00:00:01"


async def run(transport: str, name: str | None, address: str, profile_path: str | None) -> None:
    profile = Profile.load(profile_path)
    local_name = name or profile.advertising["localName"]
    async with await open_transport_or_link(transport) as hci_transport:
        device = Device.with_hci(
            local_name, Address(address), hci_transport.source, hci_transport.sink
        )
        peripheral = TestPeripheral(device, profile)
        await device.power_on()
        await peripheral.start(local_name)
        logging.getLogger(__name__).info(
            "Advertising as %r (%s) on %s. Ctrl+C to stop.", local_name, address, transport
        )
        await hci_transport.source.wait_for_termination()


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="blekit-peripheral",
        description="expo-ble-kit test peripheral (test-peripherals/profile.json) on Bumble.",
    )
    parser.add_argument(
        "transport",
        nargs="?",
        default="android-netsim",
        help="Bumble transport spec (default: android-netsim)",
    )
    parser.add_argument("--name", help="local name (default: profile advertising.localName)")
    parser.add_argument(
        "--address",
        default=DEFAULT_ADDRESS,
        help=f"random static address (default: {DEFAULT_ADDRESS}); use a different one per instance",
    )
    parser.add_argument("--profile", help="path to profile.json (default: test-peripherals/profile.json)")
    parser.add_argument("--log-level", default="INFO", help="Python log level (default: INFO)")
    args = parser.parse_args()

    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        asyncio.run(run(args.transport, args.name, args.address, args.profile))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
