---
'expo-ble-kit': minor
---

L2CAP channels: `peripheral.openL2CAPChannel(psm, options)` opens a connection-oriented channel to a connected peripheral, and `BleManager.publishL2CAPChannel({ secure })` publishes a server that centrals open channels to. An `L2CAPChannel` is a byte stream: `write()` resolves once the system took the bytes, reading starts with the first data listener (flow control holds the peer back until then), and the close listener says why it closed. Android needs version 10. `expo-ble-kit/testing` gains L2CAP on virtual peripherals (`publishL2CAPChannel`) and a virtual central side (`FakeBle.openL2CAPChannel`).
