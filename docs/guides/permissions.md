---
title: Permissions
---

# Permissions

Bluetooth needs two things: **declarations** in the app (which the config plugin writes) and, on most platforms, **the user's consent** at runtime.

## The two calls

- `BleManager.getPermissionsAsync()` reads the current status. It never shows a prompt.
- `BleManager.requestPermissionsAsync(request?)` asks. With no argument it asks for scanning and connecting.

Both resolve with:

```ts
{
  scan: 'granted' | 'denied' | 'undetermined',
  connect: 'granted' | 'denied' | 'undetermined',
  advertise: 'granted' | 'denied' | 'undetermined',
  backgroundScan: 'granted' | 'denied' | 'undetermined',
  canAskAgain: boolean,
}
```

`undetermined` means the user hasn't been asked. When `canAskAgain` is `false`, the system won't show the prompt again: send the user to Settings with `Linking.openSettings()` from `react-native`.

Nothing else prompts. Scanning or connecting without permission rejects with `BLUETOOTH_UNAUTHORIZED` (iOS) or `PERMISSION_DENIED` (Android, naming the missing permission).

In a component, `useBlePermissions()` gives the status and a request function, and reads the status again when the app returns from Settings:

```tsx
import { useBlePermissions } from 'expo-ble-kit';

function BluetoothGate({ children }: { children: React.ReactNode }) {
  const [permissions, request] = useBlePermissions();
  if (!permissions) return null; // still reading
  if (permissions.scan === 'granted' && permissions.connect === 'granted') return children;
  return permissions.canAskAgain ? (
    <Button title="Allow Bluetooth" onPress={() => request()} />
  ) : (
    <Button title="Open Settings" onPress={() => Linking.openSettings()} />
  );
}
```

## iOS

- One permission covers everything. The prompt appears the first time the app calls `requestPermissionsAsync()`; the request's flags don't matter.
- The prompt shows the `bluetoothAlwaysPermission` text from the config plugin (`NSBluetoothAlwaysUsageDescription`). App Review reads it, so say what the app does with Bluetooth.
- Until the user answers, the adapter state is `unknown`. After a denial it is `unauthorized`.
- If the text is missing, calls reject with `MISCONFIGURED` instead of crashing, as iOS would.

## Android 12 and later (API 31+)

- Scanning needs `BLUETOOTH_SCAN`, connecting needs `BLUETOOTH_CONNECT`. Both are runtime permissions, asked together in one dialog ("Nearby devices").
- The adapter state is `unauthorized` until `BLUETOOTH_CONNECT` is granted.
- By default the plugin declares `BLUETOOTH_SCAN` with `neverForLocation`, so scanning needs no location permission. Some beacon advertisements are filtered out in that mode. If your app derives location from scans, set `android.neverForLocation: false`; `requestPermissionsAsync()` then asks for location too.
- A permission granted later in Settings shows up when the app returns to the foreground.
- With `keepAliveInBackground` (plugin option `android.foregroundService`), Android 13+ only shows the service's notification in the drawer once the user allows notifications (`POST_NOTIFICATIONS`). `requestPermissionsAsync()` doesn't ask for it; your app does.

## Android 11 and earlier (API 30 and below)

- Scanning needs location permission (`ACCESS_FINE_LOCATION`), which `requestPermissionsAsync()` asks for. The `BLUETOOTH` and `BLUETOOTH_ADMIN` permissions need no prompt.
- **Location services must be on** for scans to return results, even with the permission. See [troubleshooting](../troubleshooting.md).
- Android 10–11 also need background location for scanning in the background (`backgroundScan`, used by `registerBackgroundTask`): declare it with the plugin option `android.backgroundLocation`. `requestPermissionsAsync({ backgroundScan: true })` asks for it after foreground location, as Android requires; Android 11 sends the user to Settings for it.

## When something is missing

If the app lacks a declaration that a call needs, the call rejects with `MISCONFIGURED`. The message names the missing entry. Add the config plugin and rebuild, or follow the [bare setup guide](bare-setup.md).

`advertise` reads `denied` until the app declares advertising, which arrives with the peripheral role.
