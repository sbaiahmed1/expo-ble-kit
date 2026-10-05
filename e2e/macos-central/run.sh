#!/usr/bin/env bash
# Runs the GATT server checks with this Mac as the central (README.md).
#   e2e/macos-central/run.sh [stream seconds, default 10]
# Exits 0 when every check passed.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
build="$here/build"
app="$build/BleKitCentral.app"
binary="$app/Contents/MacOS/BleKitCentral"
log="$build/central.log"
seconds="${1:-10}"

# An app, not a bare tool: CoreBluetooth needs a usage description, and macOS asks on behalf of
# the app that launched a tool (a terminal or an IDE may have none). Rebuilt only when a source
# changed: an ad-hoc signed build can count as a new app for macOS privacy and ask again.
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
# `open` makes the app its own process for macOS privacy: the first run asks to allow Bluetooth.
open -W -n "$app" --args "$log" "$root/test-peripherals/profile.json" "$seconds"
sleep 0.5
grep -Eq 'DONE: [0-9]+ passed, 0 failed' "$log"
