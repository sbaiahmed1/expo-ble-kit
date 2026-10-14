# A Mac as the test peripheral

This Mac serves the test GATT profile (`test-peripherals/profile.json`) with CoreBluetooth, so a phone running the example app has a real peripheral to talk to when no nRF52840, Bumble dongle or second phone is at hand. It is the counterpart of [`../macos-central`](../macos-central/README.md).

```bash
e2e/macos-peripheral/run.sh            # runs 10 minutes as BleKit-Test
e2e/macos-peripheral/run.sh 3600       # an hour
e2e/macos-peripheral/run.sh 600 BleKit-Mac   # under another name
e2e/macos-peripheral/run.sh 600 BleKit-Test heart-rate   # advertising only Heart Rate
```

It advertises the TEST and Heart Rate services under the profile's name, `BleKit-Test`, and serves the following. The 31-byte advertisement only has room for TEST, so scans filtered on Heart Rate (the example's Heart Rate tab) need the `heart-rate` argument, which advertises Heart Rate instead; everything is still served.

- every TEST characteristic with the profile's behavior: the static and 512-byte values, the echo, the sink and its counter (notified at most every 100 ms), the stream (`CONTROL SET_STREAM`, sequence numbers that only advance when a frame went out, frames cut to each central's maximum), indications (`SEND_INDICATIONS`), `SECURE` (an encrypted link, so reading it pairs), the toggled SECONDARY service (`TOGGLE_SECONDARY_SERVICE`; macOS sends Service Changed itself) and `RESET_COUNTERS`;
- Heart Rate Measurement at 1 Hz while subscribed, bpm 60 to 100;
- an L2CAP echo server, whose PSM (assigned by macOS) `L2CAP_PSM` serves.

What macOS can't do: `CONTROL DISCONNECT_AFTER` answers "request not supported" (a CoreBluetooth peripheral can't end a connection), the advertisement has no manufacturer data, service data or TX power, and the L2CAP PSM isn't the profile's fixed one.

The log (`build/peripheral.log`) shows subscriptions, CONTROL commands and L2CAP channels. The first run, and the first after a rebuild, asks to allow Bluetooth for **BleKitPeripheral**. macOS and Xcode's command line tools only; the app is built into `build/` (gitignored).
