# Maestro flows

End-to-end flows for the example app's screens (plan §7, P1-15; §8.1 L4).

| Flow | What it checks |
|---|---|
| `explorer-basic.yaml` | Explorer: find `BleKit-Test`, connect, read `STATIC_READ`, write `ECHO_WRITE` and read it back from `ECHO_READ`, subscribe to Heart Rate Measurement, disconnect |
| `heart-rate.yaml` | Heart Rate: find the monitor by its 0x180D service, live BPM, reconnection after the test device drops the link (`CONTROL` `DISCONNECT_AFTER`), disconnect |
| `sink.yaml` | Developer checks: 1 MB through repeated writes without response (P2-02), then through one `writeStream` (P2-03), reaches the peripheral's byte counter (`SINK_NO_RSP` → `SINK_COUNTER`), with the throughput; a stream aborted at 25 % rejects with `OPERATION_CANCELLED` |
| `batching.yaml` | Developer checks: the peripheral streams 100 Hz × 20 B to a batched subscription (16 ms) for 30 s: at most ~63 batches/s, no sequence gaps, nothing dropped (P2-04) |
| `multi-devices.yaml` | Developer checks: every test peripheral around (5+) connected at once and streaming; one drops itself and the others keep streaming and answering reads (P2-05). Demo mode has five |
| `gatt-hygiene.yaml` | Developer checks: the peripheral toggles a service and the app gets `servicesChanged` with the new services; then 500 connect/disconnect cycles leave no GATT client open (P2-06) |
| `logging.yaml` | Developer checks: at log level debug, the GATT operations of the service-change check show up in the log with op id, kind, status and duration (P2-07) |
| `throughput.yaml` | The Throughput tab: the transfers of docs/benchmarks.md, one result each (P2-08) |
| `_setup.yaml` | Shared start: launch, demo mode, the Bluetooth permission |

They target the test peripheral of `test-peripherals/profile.json`.

## Running

Install the example app on the phone first (`cd example && npx expo run:android`, or `run:ios`).

```bash
# Against real hardware: the Bumble peripheral (USB dongle) or the nRF52840 advertising nearby
maestro test e2e/maestro/explorer-basic.yaml e2e/maestro/heart-rate.yaml e2e/maestro/sink.yaml e2e/maestro/batching.yaml e2e/maestro/multi-devices.yaml e2e/maestro/gatt-hygiene.yaml e2e/maestro/logging.yaml e2e/maestro/throughput.yaml

# Without hardware: the app's demo mode, a virtual test peripheral built from profile.json
maestro test -e DEMO=true e2e/maestro/explorer-basic.yaml e2e/maestro/heart-rate.yaml e2e/maestro/sink.yaml e2e/maestro/batching.yaml e2e/maestro/multi-devices.yaml e2e/maestro/gatt-hygiene.yaml e2e/maestro/logging.yaml e2e/maestro/throughput.yaml
```

Parameters: `DEVICE_NAME` (default `BleKit-Test`, for a second peripheral instance), `DEMO` (default `false`). With several phones attached, pass `--device <serial>`. On Android, stop other tools that hold the phone's UI automation session (Argent's device server, for example) before running Maestro.

Demo mode checks the screens and the library's TypeScript layer, but not the native Bluetooth code. The hardware runs are what the P1-15 and P2-02 to P2-08 acceptances need.
