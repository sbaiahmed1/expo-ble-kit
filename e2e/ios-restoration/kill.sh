#!/usr/bin/env bash
# Stops the example app on a cabled or paired iPhone the way iOS does when it needs memory (SIGKILL),
# not the way the app switcher does: iOS then still relaunches the app for Bluetooth state
# restoration (README.md).
#   e2e/ios-restoration/kill.sh <device id> [app name, default expoblekitexample]
set -euo pipefail

device="${1:?usage: kill.sh <device id> [app name]}"
app="${2:-expoblekitexample}"

pid="$(xcrun devicectl device info processes --device "$device" --json-output - 2>/dev/null |
  python3 -I -c '
import json, sys
app = sys.argv[1]
processes = json.load(sys.stdin)["result"]["runningProcesses"]
print(next((str(p["processIdentifier"]) for p in processes
            if f"/{app}.app/" in p.get("executable", "")), ""))
' "$app")"

if [[ -z "$pid" ]]; then
  echo "$app isn't running on $device"
  exit 1
fi
xcrun devicectl device process signal --device "$device" --pid "$pid" --signal SIGKILL >/dev/null
echo "Killed $app (pid $pid) with SIGKILL"
