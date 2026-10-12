---
'expo-ble-kit': minor
---

The web: in Chrome and Edge, the central role works over Web Bluetooth. A scan opens the browser's device chooser (it needs a tap just before), and the picked device is its one result; connecting, discovery, reads, writes, `writeStream`, descriptors and notifications then work as on phones, one operation at a time. `ScanOptions.web.optionalServices` names the other services the page will use, since the browser only allows those named in the scan. What browsers can't do (MTU, RSSI, reconnection policies, the GATT server, advertising, L2CAP, background tasks) rejects with `NOT_SUPPORTED`; without Web Bluetooth the state is `unsupported`.
