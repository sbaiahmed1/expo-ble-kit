---
'expo-ble-kit': minor
---

Reconnection policies: `connect({ reconnect: { maxAttempts, initialDelayMs, maxDelayMs, backoff } })` brings a lost connection back by itself, through the new `reconnecting` state, and restores subscriptions before `connected` (`restoreSubscriptionsOnReconnect`). On iOS 17 and later, `ios.enableAutoReconnect` lets the system reconnect first.
