#!/usr/bin/env bash
# Scenario S-B2 on a paired iPhone (README.md): arm the example's restoration check through its deep
# link, stop the app the way iOS does, wait while the test peripheral keeps notifying, and print the
# restoration journal the library kept on the phone.
#   e2e/ios-restoration/run.sh <device id> [seconds to wait after the kill, default 60]
# Needs e2e/macos-peripheral/run.sh running on this Mac and the example (with ios.restoreIdentifier,
# as example/app.json sets) installed, with Bluetooth allowed.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
device="${1:?usage: run.sh <device id> [seconds]}"
wait_seconds="${2:-60}"
bundle="expo.modules.blekit.example"
peripheral_log="$root/e2e/macos-peripheral/build/peripheral.log"
journal_path="Library/Application Support/expo-ble-kit/restoration-journal.json"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

journal() {
  if xcrun devicectl device copy from --device "$device" --domain-type appDataContainer \
    --domain-identifier "$bundle" --source "$journal_path" --destination "$work/journal.json" >/dev/null 2>&1; then
    python3 -I -c '
import datetime, json, sys
for entry in json.load(open(sys.argv[1])):
    time = datetime.datetime.fromtimestamp(entry["time"] / 1000).strftime("%H:%M:%S")
    count = " x" + str(entry["count"]) if entry["count"] > 1 else ""
    print("  " + time + " " + entry["event"] + count)
' "$work/journal.json"
  else
    echo "  (no journal on the phone yet)"
  fi
}

if ! grep -q "advertising as" "$peripheral_log" 2>/dev/null || grep -q "DONE" "$peripheral_log"; then
  echo "Start the test peripheral first: e2e/macos-peripheral/run.sh 3600"
  exit 1
fi

echo "Journal before:"
journal
subscriptions_before="$(grep -c "subscribed to HEART_RATE_MEASUREMENT" "$peripheral_log" || true)"

echo "Arming the restoration check through its deep link"
xcrun devicectl device process launch --device "$device" --terminate-existing \
  --payload-url "$bundle://restoration/arm?debug" "$bundle" >/dev/null

for _ in $(seq 60); do
  now="$(grep -c "subscribed to HEART_RATE_MEASUREMENT" "$peripheral_log" || true)"
  [[ "$now" -gt "$subscriptions_before" ]] && break
  sleep 1
done
if [[ "$now" -le "$subscriptions_before" ]]; then
  echo "The app didn't subscribe to the heart rate within 60 s (see Metro's log)"
  exit 1
fi
echo "Subscribed; heart rate values flow"
sleep 5

"$here/kill.sh" "$device"
echo "Waiting $wait_seconds s while the Mac keeps notifying"
sleep "$wait_seconds"

echo "Journal after:"
journal
