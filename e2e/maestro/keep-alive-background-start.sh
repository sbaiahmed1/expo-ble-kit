#!/usr/bin/env bash
# P3-03, Android 12+: a keepAliveInBackground connect issued while the app is in the background.
# Android refuses the foreground service: the app logs a FOREGROUND_SERVICE_FAILED warning, doesn't
# crash, and the connect goes on without the service.
#   e2e/maestro/keep-alive-background-start.sh [-s SERIAL] [--deny-overlay]
# The app fires the connect at the first scan result 15 s after the tap (JS timers pause in the
# background); a scan finds devices nearby, so no peripheral is needed.
# Debug builds hold SYSTEM_ALERT_WINDOW (React Native's dev overlay), which exempts apps from the
# rule on Android 14. Use a release build, or --deny-overlay to deny that app-op during the run (it
# goes back to default at exit).
set -euo pipefail

SERIAL=${ANDROID_SERIAL:-}
PACKAGE=expo.modules.blekit.example
DENY_OVERLAY=false
FLOWS="$(cd "$(dirname "$0")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    -s) SERIAL=$2; shift 2 ;;
    --deny-overlay) DENY_OVERLAY=true; shift ;;
    *) echo "Unknown option $1" >&2; exit 2 ;;
  esac
done

dev() { adb ${SERIAL:+-s "$SERIAL"} "$@"; }
maestro_flow() { maestro ${SERIAL:+--device "$SERIAL"} test "$FLOWS/$1"; }
cleanup() {
  if $DENY_OVERLAY; then dev shell cmd appops set "$PACKAGE" SYSTEM_ALERT_WINDOW default; fi
}
trap cleanup EXIT
if $DENY_OVERLAY; then dev shell cmd appops set "$PACKAGE" SYSTEM_ALERT_WINDOW deny; fi

maestro_flow _keep-alive-arm.yaml
pid=$(dev shell pidof "$PACKAGE")
maestro_flow _keep-alive-check.yaml
crashes=$(dev logcat -d -b crash -t 200 | grep -c "Process: $PACKAGE, PID: $pid" || true)
if [ "$(dev shell pidof "$PACKAGE" || true)" != "$pid" ] || [ "$crashes" -gt 0 ]; then
  echo "FAILED: the app crashed or restarted."
  exit 1
fi
echo "OK: the start from the background was refused with a warning, no crash (pid $pid)."
