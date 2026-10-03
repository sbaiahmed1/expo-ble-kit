---
'expo-ble-kit': minor
---

`Peripheral.writeStream(service, characteristic, data, options)` sends a payload of any length in chunks of one packet, natively and with flow control: `onProgress` reports about every 1 %, an `AbortSignal` stops it within the chunk in flight, `withResponse: true` acknowledges each chunk, and `chunkSize` makes chunks smaller. Operations issued during a stream wait until it ends.
