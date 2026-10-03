---
'expo-ble-kit': minor
---

Writes without response are flow-controlled: they resolve once the phone's Bluetooth stack took the packet and wait while it is full, so bursts are neither dropped nor failed. On Android a congested link no longer fails a write with `CONGESTED`, and a packet the stack refused while congested is sent again; on iOS a write that timed out while waiting is no longer sent later.
