---
'expo-ble-kit': minor
---

Bonding: `peripheral.android.createBond(options)` bonds with a connected Android device (queued with the GATT operations; Android's pairing dialog asks the user, and the library never confirms a pairing itself), and `peripheral.android.bondState` reads `'none'`, `'bonding'` or `'bonded'`. A refused or failed pairing rejects with `BOND_FAILED`. On iOS, which pairs by itself when an attribute needs encryption, `bondState` is `'none'` and `createBond` rejects with `NOT_SUPPORTED`. The testing fake bonds connected virtual peripherals (`injectError` op `createBond`).
