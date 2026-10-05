# A Mac as the central

Checks the example app's GATT server (P4-01, P4-02) from a real central: this Mac's Bluetooth. Use it while no phone can find the server through advertising (before P4-03), or when no second phone is at hand.

```bash
e2e/macos-central/run.sh        # 10 s stream at 100 Hz; e2e/macos-central/run.sh 60 for a minute
```

Before running it:

1. Run the example app on the phone, in front, and open the server: **Checks → GATT server → Open the test GATT server**.
2. Keep the phone near the Mac and unlocked.
3. The first run asks to allow Bluetooth for **BleKitCentral** (after a source change, the rebuilt app may ask again). Click Allow. It waits up to 3 minutes.

The script exits 0 when every check passed. The log is in `build/central.log`, and the phone's GATT server group lists each request.

## How it finds the server

It scans for 8 seconds, then tries the devices in this order:

1. Devices advertising the TEST service: a test peripheral, or a phone once it advertises (P4-03).
2. Connectable Apple advertisements, strongest first. An iPhone serves its apps' services behind its own advertisement, usually named after the phone. So an iPhone can be tested before P4-03; an Android phone can't, because it doesn't advertise by itself.

It connects to each one and looks for the TEST service.

## What it checks

UUIDs, values and CONTROL opcodes come from [`test-peripherals/profile.json`](../../test-peripherals/profile.json).

| Check | Pass |
|---|---|
| `STATIC_READ` | the profile's 20 bytes |
| `LONG_READ`, twice | each read is one snapshot of the profile value. The example's server shifts it by one per handler call, so a read stitched from two calls would fail |
| `ECHO_WRITE` / `ECHO_READ` | 3 bytes, then a 300-byte long write, read back |
| `SINK_NO_RSP` / `SINK_COUNTER` | 20 × 100 bytes without response count 2000 |
| `STREAM`, 100 Hz × 20 B | frames arrive, 0 gaps, 0 corrupt |
| `STREAM`, 1000 Hz × the largest frame | the same, paced by the server's flow control. Prints frames/s and KiB/s |
| `INDICATE` | `SEND_INDICATIONS(5)` delivers 0…4 in order |
| invalid CONTROL commands | refused: the profile's 0x80 / 0x81, or 0x06 / 0x0D from the example (its API has no application errors) |

macOS and Xcode's command line tools only. The app is built ad hoc into `build/` (gitignored) and isn't part of the npm package.
