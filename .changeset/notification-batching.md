---
'expo-ble-kit': minor
---

`Peripheral.subscribeBatched(service, characteristic, onBatch, { intervalMs, maxItems })` collects notifications natively and delivers them at most once per `intervalMs`, each value with the time it arrived, so fast sensors don't flood the JS thread. When more than `maxItems` (default 4096) arrive in one interval, the oldest are dropped and counted in `dropped`, with a new `BUFFER_OVERFLOW` warning.
