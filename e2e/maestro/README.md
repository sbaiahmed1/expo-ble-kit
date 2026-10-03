# Maestro flows

End-to-end flows for the example app's screens (plan §7, P1-15; §8.1 L4).

| Flow | What it checks |
|---|---|
| `explorer-basic.yaml` | Explorer: find `BleKit-Test`, connect, read `STATIC_READ`, write `ECHO_WRITE` and read it back from `ECHO_READ`, subscribe to Heart Rate Measurement, disconnect |
| `heart-rate.yaml` | Heart Rate: find the monitor by its 0x180D service, live BPM, reconnection after the test device drops the link (`CONTROL` `DISCONNECT_AFTER`), disconnect |
| `sink.yaml` | Developer checks: 1 MB through repeated writes without response reaches the peripheral's byte counter (`SINK_NO_RSP` → `SINK_COUNTER`), with the throughput (P2-02) |
| `_setup.yaml` | Shared start: launch, demo mode, the Bluetooth permission |

They target the test peripheral of `test-peripherals/profile.json`.

## Running

Install the example app on the phone first (`cd example && npx expo run:android`, or `run:ios`).

```bash
# Against real hardware: the Bumble peripheral (USB dongle) or the nRF52840 advertising nearby
maestro test e2e/maestro/explorer-basic.yaml e2e/maestro/heart-rate.yaml e2e/maestro/sink.yaml

# Without hardware: the app's demo mode, a virtual test peripheral built from profile.json
maestro test -e DEMO=true e2e/maestro/explorer-basic.yaml e2e/maestro/heart-rate.yaml e2e/maestro/sink.yaml
```

Parameters: `DEVICE_NAME` (default `BleKit-Test`, for a second peripheral instance), `DEMO` (default `false`). With several phones attached, pass `--device <serial>`. On Android, stop other tools that hold the phone's UI automation session (Argent's device server, for example) before running Maestro.

Demo mode checks the screens and the library's TypeScript layer, but not the native Bluetooth code. The hardware runs are what the P1-15 and P2-02 acceptances need.
