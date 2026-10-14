#!/usr/bin/env bash
# Records the screen of the iPhone connected by cable into a .mov (README.md).
#   e2e/ios-screen-record/run.sh <output.mov> [max seconds, default 120]
# Stop it early with: touch e2e/ios-screen-record/build/stop
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
build="$here/build"
app="$build/BleKitScreenRecord.app"
binary="$app/Contents/MacOS/BleKitScreenRecord"
log="$build/record.log"
stop="$build/stop"
output="$(cd "$(dirname "${1:?usage: run.sh <output.mov> [max seconds]}")" && pwd)/$(basename "$1")"
seconds="${2:-120}"

# An app, not a bare tool, for the camera usage description: macOS stops a process that captures
# without one. Launched with open, so it is its own responsible process for the permission.
if [[ ! -x "$binary" || -n "$(find "$here/Sources" "$here/Info.plist" -newer "$binary" 2>/dev/null)" ]]; then
  echo "Building $app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS"
  cp "$here/Info.plist" "$app/Contents/Info.plist"
  swiftc -O -swift-version 5 "$here"/Sources/*.swift -o "$binary"
  codesign --force --sign - --requirements '=designated => identifier "dev.expo-ble-kit.ios-screen-record"' \
    "$app" >/dev/null 2>&1
fi

rm -f "$stop"
: >"$log"
open -W -n "$app" --args "$log" "$output" "$seconds" "$stop"
cat "$log"
grep -q '^ *[0-9.]* DONE' "$log"
