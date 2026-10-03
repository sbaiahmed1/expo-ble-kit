---
'expo-ble-kit': patch
---

`getDiagnostics().sessions[].subscriptions` now counts each connection's active subscriptions; it was always 0.
