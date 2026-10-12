#!/usr/bin/env bash
# Runs this Mac as an L2CAP echo peripheral (README.md).
#   e2e/macos-peripheral/run.sh [seconds, default 600]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
build="$here/build"
app="$build/BleKitPeripheral.app"
binary="$app/Contents/MacOS/BleKitPeripheral"
log="$build/peripheral.log"
seconds="${1:-600}"

# An app, not a bare tool, for the Bluetooth usage description (see ../macos-central/run.sh).
if [[ ! -x "$binary" || -n "$(find "$here/Sources" "$here/Info.plist" -newer "$binary" 2>/dev/null)" ]]; then
  echo "Building $app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS"
  cp "$here/Info.plist" "$app/Contents/Info.plist"
  swiftc -O -swift-version 5 "$here"/Sources/*.swift -o "$binary"
  codesign --force --sign - "$app" >/dev/null 2>&1
fi

: >"$log"
tail -n +1 -f "$log" &
tailer=$!
trap 'kill "$tailer" 2>/dev/null || true' EXIT
open -W -n "$app" --args "$log" "$root/test-peripherals/profile.json" "$seconds"
sleep 0.5
grep -q 'DONE' "$log"
