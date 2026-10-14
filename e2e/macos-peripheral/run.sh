#!/usr/bin/env bash
# Runs this Mac as the test peripheral (README.md).
#   e2e/macos-peripheral/run.sh [seconds, default 600] [local name, default the profile's BleKit-Test]
#     [heart-rate: advertise only Heart Rate, for scans filtered on it such as the Heart Rate tab]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
build="$here/build"
app="$build/BleKitPeripheral.app"
binary="$app/Contents/MacOS/BleKitPeripheral"
log="$build/peripheral.log"
seconds="${1:-600}"
name="${2:-}"
advertise="${3:-}"

# An app, not a bare tool, for the Bluetooth usage description (see ../macos-central/run.sh).
if [[ ! -x "$binary" || -n "$(find "$here/Sources" "$here/Info.plist" -newer "$binary" 2>/dev/null)" ]]; then
  echo "Building $app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS"
  cp "$here/Info.plist" "$app/Contents/Info.plist"
  swiftc -O -swift-version 5 "$here"/Sources/*.swift -o "$binary"
  # Ad hoc, but with the bundle id as the designated requirement, so macOS may keep the Bluetooth
  # permission across rebuilds instead of asking again for each new signature.
  codesign --force --sign - --requirements '=designated => identifier "dev.expo-ble-kit.macos-peripheral"' \
    "$app" >/dev/null 2>&1
fi

: >"$log"
tail -n +1 -f "$log" &
tailer=$!
trap 'kill "$tailer" 2>/dev/null || true' EXIT
open -W -n "$app" --args "$log" "$root/test-peripherals/profile.json" "$seconds" "$name" ${advertise:+"$advertise"}
sleep 0.5
grep -q 'DONE' "$log"
