---
title: Accessory setup (iOS)
---

# Accessory setup (iOS 18+)

`BleManager.ios.showAccessoryPicker` shows AccessorySetupKit's system picker. It lists the nearby accessories that match your items, with your product name and picture. The person picks one, and the app may then use that accessory with no Bluetooth permission prompt.

It suits apps built around their own accessories. Declaring AccessorySetupKit changes how Bluetooth works for the **whole app**, so read the next section before you enable it.

## What changes for the whole app

Measured on an iPhone 14 Pro Max with iOS 27.0.1. The comparison is the example app's AccessorySetupKit build against the normal build, on the same phone at the same time:

|                                                 | Normal app                       | App that declares AccessorySetupKit                                                                                         |
| ----------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Bluetooth prompt                                | On the first `requestPermissionsAsync()` | Never. iOS keeps the app's Bluetooth authorization "not determined".                                                 |
| `getPermissionsAsync()`                         | What the person answered         | `scan` and `connect` read `granted` (limited to picked accessories). `advertise` and `backgroundScan` read `undetermined`. `canAskAgain` is `false`. |
| Adapter state                                   | The radio's state                | `poweredOff` until the person has set up an accessory, **even with Bluetooth on**. `poweredOn` from the moment one is set up, including after a restart. |
| Scanning with no filter                         | Every advertiser nearby (6)      | Only the accessories the person picked (1)                                                                                  |
| Connecting, discovery, reads                    | Any peripheral                   | Work for picked accessories                                                                                                 |
| GATT server and advertising                     | With the permission              | Reject with `PERMISSION_DENIED`: they need the Bluetooth permission, which iOS never asks for here                          |

So:

- An app that needs to see every device nearby, such as a scanner or a generic BLE tool, can't use AccessorySetupKit.
- Before the first pick, don't tell people to turn Bluetooth on when the state reads `poweredOff`. Show the picker instead.
- `requestPermissionsAsync()` resolves at once with the values above. It never shows a prompt.

Not measured yet: background scanning and state restoration in such an app.

## Setup

List every service, name substring and company id your picker items use in the config plugin's `ios.accessorySetupKit` option:

```json
{
  "expo": {
    "plugins": [
      [
        "expo-ble-kit",
        {
          "ios": {
            "accessorySetupKit": {
              "services": ["0C6C1000-B347-4CFA-9827-1C5A13658519"],
              "names": ["Thermo"],
              "companyIdentifiers": [76]
            }
          }
        }
      ]
    ]
  }
}
```

- Each list takes up to 500 values. Leave out a list you don't need: the plugin never writes an empty one.
- Company ids are numbers or hex strings (`"0x004C"`, `"004C"`). The plugin writes them as four hex digits, a form iOS accepts.
- Bare React Native apps add the keys by hand: see [bare setup](bare-setup.md).

iOS stops the app when a declaration is wrong. To prevent that, the library checks Info.plist before it shows the picker and rejects with `MISCONFIGURED` when:

- an item uses a service, name or company id that isn't listed;
- a list is empty, has more than 500 values, or holds a company id iOS can't read.

## Showing the picker

```ts
import { BleManager } from 'expo-ble-kit';

const thermometer = await BleManager.ios.showAccessoryPicker([
  {
    name: 'Thermo',
    productImage: require('./assets/thermo.png'),
    service: '0C6C1000-B347-4CFA-9827-1C5A13658519',
  },
]);
if (thermometer) {
  await thermometer.connect();
  // Keep thermometer.id: BleManager.getPeripheral(id) gives the accessory back later.
}
```

Each item needs a `name`, a `productImage` (from `require()`, or an image URL), and a `service` or a `companyId`. These optional fields narrow the match:

- `nameSubstring`: part of the advertised name. It must be one of the declared `names`.
- `manufacturerData`: `{ data, mask }` of the same length. Needs `companyId`.
- `serviceData`: `{ data, mask }` of the same length. Needs `service`.
- `immediateRange`: only accessories right next to the phone.

The call resolves:

- with the accessory's `Peripheral` once the person has set it up and closed the picker;
- with `null` when they close it without a pick, or when nothing turns up. iOS doesn't offer an accessory again once it is set up: it shows "No Accessory Found" instead. Reach the accessory by its id.

It rejects with:

- `OPERATION_TIMEOUT` when the picker is still open after `timeoutMs` (default 5 minutes). The library closes the picker first.
- `MISCONFIGURED` as described above.
- `INVALID_ARGUMENT` for an invalid item, an image that can't be loaded, or a second picker while one is showing.
- `BLUETOOTH_UNAUTHORIZED` when device management restricts AccessorySetupKit.
- `OPERATION_CANCELLED` when iOS ends the picker session.
- `NOT_SUPPORTED` before iOS 18 and on Android.

## Testing

- **Unit tests:** in the testing fake (`expo-ble-kit/testing`), `showAccessoryPicker` picks the first advertising virtual peripheral that matches an item. Make it fail with `injectError` and the op `showAccessoryPicker`.
- **On a phone:** the example app has a separate AccessorySetupKit build with its own bundle id ("BLE Kit ASK"), so it keeps its Bluetooth state apart from the normal build. Build it with `EXPO_BLE_KIT_ASK=1 npx expo prebuild --clean`. Run `e2e/macos-peripheral/run.sh` on a Mac to act as the accessory. Then, in the Checks tab, tap "Pick the test peripheral".
- **Starting over:** deleting the app forgets its accessories. After a reinstall the picker offers them again.
