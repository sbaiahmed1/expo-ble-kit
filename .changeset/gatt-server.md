---
'expo-ble-kit': minor
---

Peripheral role: `BleManager.openGattServer(services)` publishes a local GATT server on iOS and Android. Static values are answered natively; `onReadRequest` and `onWriteRequest` handlers answer the rest within 25 s (else an ATT error and a warning). Long reads are served from one handler result per read sequence, long writes arrive as one value, thrown `BleError`s become ATT errors, and `addSubscriptionListener` reports CCCD subscriptions. The testing entry gains `connectCentral()`, a virtual central for testing server handlers. Advertising and notifications come next.
