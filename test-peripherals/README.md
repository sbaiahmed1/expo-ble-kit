# Test peripherals

Everything the expo-ble-kit test suites talk to over Bluetooth (plan §8.3).

- [`profile.json`](profile.json) is the **single source of truth** for the test GATT profile: UUIDs, properties, values, advertising data, CONTROL commands and stream format. Every implementation (Bumble here, Zephyr firmware later, the JS fake adapter) reads or is generated from it. Change the profile first, then the implementations.
- [`bumble/`](bumble) is a Python implementation on [Bumble](https://github.com/google/bumble). It runs against the Android emulator's virtual radio (netsim) or a USB Bluetooth dongle.

## The profile at a glance

Custom UUIDs are `0c6cXXXX-b347-4cfa-9827-1c5a13658519`, with `XXXX` the 16-bit id below.

| Key | Id | Properties | Behavior |
|---|---|---|---|
| service `TEST` | 1000 | | Advertised (128-bit UUID in the advertising data) |
| `STATIC_READ` | 1001 | read | 20 bytes `00 01 … 13` |
| `LONG_READ` | 1002 | read | 512-byte pattern `(i * 31 + 7) % 251` |
| `ECHO_WRITE` | 1003 | write | Stores the value (up to 512 bytes; prepared writes supported) |
| `ECHO_READ` | 1004 | read | Last value written to `ECHO_WRITE` |
| `SINK_NO_RSP` | 1005 | writeWithoutResponse | Counts received bytes |
| `SINK_COUNTER` | 1006 | read, notify | Byte count (uint32 LE), notified at most every 100 ms |
| `STREAM` | 1007 | notify | `[seq uint32 LE][(seq + j) % 256 …]` at the rate/size set by `SET_STREAM`; 0x2901 descriptor "Stream" |
| `INDICATE` | 1008 | indicate | Sequence numbers (uint32 LE) on `SEND_INDICATIONS` |
| `SECURE` | 1009 | read, encryption required | `SECURE01`; reading triggers pairing (Just Works, bonding) |
| `L2CAP_PSM` | 100A | read | PSM of the L2CAP echo server (uint16 LE, 0x0081) |
| `CONTROL` | 100B | write | Commands below |
| service `SECONDARY` | 2000 | | Absent until toggled; `SECONDARY_VALUE` (2001) reads `SECONDARY` |
| Heart Rate `0x180D` | | | `0x2A37` notifies `[0x00, bpm]` every second, bpm 60→100 |

CONTROL commands (opcode + little-endian parameters). Invalid commands fail with ATT error 0x80 (unknown opcode) or 0x81 (bad parameters).

| Opcode | Command | Parameters |
|---|---|---|
| 0x01 | `SET_STREAM` | `rateHz` u16 (0 stops, 1–1000), `frameSize` u16 (4–512; truncated to ATT_MTU − 3) |
| 0x02 | `DISCONNECT_AFTER` | `delayMs` u32 (peripheral disconnects with reason 0x13) |
| 0x03 | `TOGGLE_SECONDARY_SERVICE` | none (adds/removes `SECONDARY`, indicates Service Changed) |
| 0x04 | `RESET_COUNTERS` | none (sink counter, stream and indication sequences) |
| 0x05 | `SEND_INDICATIONS` | `count` u16 |

Advertising: flags + `TEST` service UUID + service data `0x180D: 01 02` + TX power 0 dBm. Scan response: name `BleKit-Test` + manufacturer data `0xFFFF: 42 4B 00 01`.

## Running the Bumble peripheral

Requires [uv](https://docs.astral.sh/uv/).

```bash
cd test-peripherals/bumble
uv sync
uv run blekit-peripheral                 # android-netsim: attaches to a running Android emulator
uv run blekit-peripheral usb:0           # a USB Bluetooth dongle (see Bumble's USB transport docs)
uv run blekit-peripheral --name BleKit-Test-2 --address C0:FF:EE:00:00:02   # a second instance
```

With the emulator running, the peripheral shows up in the emulator's Settings → Connected devices → Pair new device as **BleKit-Test**. The emulator starts its virtual radio (`netsimd`) itself; Bumble finds it through `$TMPDIR/netsim.ini`.

## Tests

```bash
cd test-peripherals/bumble
uv run pytest
```

The tests run the peripheral and a Bumble central on an in-memory radio, so they need no hardware and run in CI.

Notes on Bumble: its GATT server has no prepared (long) write support, so `peripheral.py` adds the ATT Prepare/Execute Write handlers itself. Bumble's GATT database is append-only, which is why `SECONDARY` is always the last service.
