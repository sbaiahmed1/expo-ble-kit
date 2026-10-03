#!/usr/bin/env bash
# P3-04, S-B4 on Android: with a background scan registered, the system kills the app; the next
# matching advertisement starts it again headless, and the task receives scanResults. The task is
# unregistered at the end, so the scan doesn't keep waking the phone.
#   e2e/maestro/background-scan.sh [-s SERIAL]           # the test peripheral advertising nearby
#   e2e/maestro/background-scan.sh --apple [-s SERIAL]   # no test peripheral: Apple devices nearby
# A debug build loads its JavaScript from Metro, which must be reachable for the headless start.
set -euo pipefail

SERIAL=${ANDROID_SERIAL:-}
PACKAGE=expo.modules.blekit.example
FILTER=test
FLOWS="$(cd "$(dirname "$0")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    -s) SERIAL=$2; shift 2 ;;
    --apple) FILTER=apple; shift ;;
    *) echo "Unknown option $1" >&2; exit 2 ;;
  esac
done

dev() { adb ${SERIAL:+-s "$SERIAL"} "$@"; }
maestro_flow() { maestro ${SERIAL:+--device "$SERIAL"} test -e FILTER="$FILTER" "$FLOWS/$1"; }

maestro_flow _background-scan-register.yaml
trap 'maestro_flow _background-scan-unregister.yaml || echo "Unregister the task by hand (Developer checks → Background scan)."' EXIT
pid=$(dev shell pidof "$PACKAGE")
# `am kill` ends a background process the way the system does; a force stop would cancel the scan.
dev shell am kill "$PACKAGE"
sleep 2
if [ -n "$(dev shell pidof "$PACKAGE" || true)" ]; then
  echo "The app is still running after am kill" >&2
  exit 1
fi
echo "Killed pid $pid; waiting up to 3 min for a matching advertisement…"
since=$(dev shell date +%s).000
for _ in $(seq 1 180); do
  line=$(dev logcat -d -T "$since" -s ReactNativeJS:V | grep -m1 "BleKit background task" || true)
  if [ -n "$line" ]; then
    new=$(dev shell pidof "$PACKAGE" || true)
    echo "$line"
    echo "OK: the scan started the app again (pid ${new:-?}, was $pid) and the task got the results."
    exit 0
  fi
  sleep 1
done
echo "FAILED: no background delivery within 3 min."
exit 1
