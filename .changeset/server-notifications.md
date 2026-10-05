---
'expo-ble-kit': minor
---

GATT server notifications: `GattServer.notify(characteristic, value, { centrals })` sends a notification, or an indication to centrals that asked for one, to the subscribed centrals. It is flow-controlled on both platforms (Android waits for `onNotificationSent` per central and retries a busy stack, iOS waits for `peripheralManagerIsReady`), so awaiting each call paces a stream to the link. Values longer than a target's MTU − 3 reject with `INVALID_ATTRIBUTE_LENGTH`, a value waits at most 10 s, and centrals that disconnect drop out. The testing entry's `VirtualCentral` gains `notifications`.
