#!/usr/bin/env bash
# P2-09 soak (plan §8.5): turns Bluetooth off and on N times on an Android phone while the example
# app's toggle soak keeps operations running, then checks that every operation settled with a coded
# error, that the app didn't crash, and how its memory moved. Bluetooth is always back on at exit.
#   e2e/soak/bluetooth-toggle.sh                      # 50 toggles on the only adb device
#   e2e/soak/bluetooth-toggle.sh -n 10 -s SERIAL      # fewer toggles, a given device
#   e2e/soak/bluetooth-toggle.sh --off 3 --on 6       # seconds off and on (defaults)
# Maestro starts and reports the in-app check (e2e/maestro/_soak-toggle-start.yaml and
# _soak-toggle-report.yaml). Without Maestro, the script asks you to tap the buttons yourself.
set -euo pipefail

TOGGLES=50
OFF_S=3
ON_S=6
SERIAL=${ANDROID_SERIAL:-}
PACKAGE=expo.modules.blekit.example
FLOWS="$(cd "$(dirname "$0")/../maestro" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    -n) TOGGLES=$2; shift 2 ;;
    -s) SERIAL=$2; shift 2 ;;
    --off) OFF_S=$2; shift 2 ;;
    --on) ON_S=$2; shift 2 ;;
    -p) PACKAGE=$2; shift 2 ;;
    *) echo "Unknown option $1" >&2; exit 2 ;;
  esac
done

dev() { adb ${SERIAL:+-s "$SERIAL"} "$@"; }
bt_state() { dev shell dumpsys bluetooth_manager | awk '/^ *state:/ { print $2; exit }'; }
pss_kb() { dev shell dumpsys meminfo "$PACKAGE" | awk '/TOTAL PSS:/ { print $3; exit }'; }

# ON or OFF. With "BLE scanning always on" (location settings), off is BLE_ON: apps see it as off.
bt_is() {
  case "$(bt_state)" in
    ON) [ "$1" = ON ] ;;
    OFF | BLE_ON) [ "$1" = OFF ] ;;
    *) return 1 ;;
  esac
}

# Turns Bluetooth on or off and waits until the adapter reports it (up to 20 s).
bt_set() {
  local want=$1
  dev shell svc bluetooth "$([ "$want" = ON ] && echo enable || echo disable)"
  for _ in $(seq 1 80); do
    bt_is "$want" && return 0
    sleep 0.25
  done
  echo "Bluetooth didn't turn $want within 20 s" >&2
  return 1
}

maestro_flow() {
  if command -v maestro >/dev/null; then
    maestro ${SERIAL:+--device "$SERIAL"} test -e TOGGLES="$TOGGLES" "$FLOWS/$1"
  else
    read -r -p "$2, then press Enter. " _
  fi
}

trap 'bt_set ON >/dev/null 2>&1 || dev shell svc bluetooth enable' EXIT
bt_set ON

maestro_flow _soak-toggle-start.yaml "Open Developer checks → Soak and tap \"Bluetooth toggle soak: start\""
pid=$(dev shell pidof "$PACKAGE" || true)
[ -n "$pid" ] || { echo "$PACKAGE isn't running" >&2; exit 1; }
# Epoch seconds: adb would split a date with a space before logcat sees it.
since=$(dev shell date +%s).000
pss_before=$(pss_kb)
echo "App pid $pid, PSS ${pss_before} kB. $TOGGLES toggles, ${OFF_S} s off, ${ON_S} s on."

started=$(date +%s)
for n in $(seq 1 "$TOGGLES"); do
  bt_set OFF
  sleep "$OFF_S"
  bt_set ON
  sleep "$ON_S"
  printf '\r%d / %d toggles, %d s' "$n" "$TOGGLES" $(($(date +%s) - started))
done
echo

report=OK
maestro_flow _soak-toggle-report.yaml "Tap \"Bluetooth toggle soak: stop and report\" and read the result" ||
  report=FAILED

pid_after=$(dev shell pidof "$PACKAGE" || true)
pss_after=$(pss_kb || echo 0)
crashes=$(dev logcat -d -b crash -T "$since" | grep -c "$PACKAGE" || true)
echo "PSS before ${pss_before} kB, after ${pss_after} kB."
if [ "$pid_after" != "$pid" ] || [ "$crashes" -gt 0 ]; then
  echo "FAILED: the app crashed or restarted (pid $pid → ${pid_after:-none}, $crashes crash log lines)."
  exit 1
fi
if [ "$report" != OK ]; then
  echo "FAILED: no crash, but the in-app report isn't OK (above)."
  exit 1
fi
echo "OK: $TOGGLES toggles, every operation settled with a coded error, no crash (pid $pid throughout)."
