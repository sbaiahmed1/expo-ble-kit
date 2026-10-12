#!/usr/bin/env bash
# P4-04 on a paired iPhone (README.md): the example's GATT server and advertisement survive iOS
# stopping the app. Opens the test server through the app's deep link, stops the app the way iOS
# does, then runs this Mac as the central against the phone: iOS answers static values itself and
# relaunches the app for the others, whose JS serves the restored server again.
#   e2e/ios-restoration/server.sh <device id>
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
device="${1:?usage: server.sh <device id>}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# shellcheck source=lib.sh
source "$here/lib.sh"

require_unlocked "$device"
echo "Opening the test GATT server and advertising it"
xcrun devicectl device process launch --device "$device" --terminate-existing \
  --payload-url "$bundle://server/serve" "$bundle" >/dev/null
sleep 15
"$here/kill.sh" "$device"
sleep 5

echo "This Mac as the central:"
status=0
"$root/e2e/macos-central/run.sh" 5 >/dev/null 2>&1 || status=$?
grep -E "advertises TEST|trying|PASS|FAIL|SKIP|DONE" "$root/e2e/macos-central/build/central.log" | sed 's/^/  /'

echo "Journal:"
print_journal "$device" "$work" 12
exit "$status"
