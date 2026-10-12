# A Mac as an L2CAP peripheral

The other half of [`../macos-central`](../macos-central/README.md): this Mac publishes an L2CAP echo server (P5-03), so a phone running the example app can open a channel to it when no second phone or test peripheral is at hand.

```bash
e2e/macos-peripheral/run.sh        # runs 10 minutes; e2e/macos-peripheral/run.sh 120 for 2
```

It publishes an L2CAP channel without encryption, adds the TEST service with `L2CAP_PSM` (the assigned PSM, uint16 LE), and advertises it as `BleKit-Mac`. Every byte a channel receives goes back on the same channel; the log (`build/peripheral.log`) shows each channel and the bytes in and out.

On the phone: **Checks → L2CAP → Echo 1 MB over L2CAP**. The check finds the Mac by the TEST service, reads `L2CAP_PSM`, sends 1 MB and expects every byte back, in order. Turn the phone's own Peripheral tab off first.

The first run asks to allow Bluetooth for **BleKitPeripheral**. macOS and Xcode's command line tools only; the app is built into `build/` (gitignored).
