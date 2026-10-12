# iOS state restoration on a device

Scenario S-B2 of the plan: the app holds a connection with notifications on, iOS stops it, the peripheral keeps notifying, and iOS relaunches the app in the background.

1. Start the test peripheral on this Mac: `e2e/macos-peripheral/run.sh 3600`.
2. On the iPhone, in the example app (built with `ios.restoreIdentifier`, as `example/app.json` sets): **Checks → State restoration (iOS) → Connect and keep heart rate on**. Heart rate values arrive every second.
3. Stop the app the way iOS does under memory pressure: `e2e/ios-restoration/kill.sh <device id>`. Closing it from the app switcher instead tells iOS not to relaunch it.
4. Wait: the Mac keeps notifying, and iOS relaunches the app in the background for it.
5. Open the app: **Show the journal** lists what happened while it wasn't on screen (also in `BleManager.getDiagnostics()` as `ios.restoration.journal`).

`kill.sh` sends SIGKILL through `xcrun devicectl`, so the iPhone needs to be paired with this Mac (cable or network).

## The GATT server (P4-04)

`e2e/ios-restoration/server.sh <device id>` opens the example's test GATT server and advertises it (deep link `…://server/serve`), stops the app with SIGKILL, then runs this Mac as the central (`e2e/macos-central`). iOS answers static values while the app isn't running and relaunches it for the others; the example serves the restored server again when its journal says iOS restored one, and the central's checks must all pass.

Both scripts need the phone unlocked: iOS doesn't launch apps on a locked phone.

