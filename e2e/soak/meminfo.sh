#!/usr/bin/env bash
# P2-09 soak (plan §8.5): samples the example app's memory (PSS) on an Android phone once a minute,
# for the 60-minute notification run. Growth is measured from minute 5 (after warm-up) to the end
# and must stay under 10%. Writes a CSV next to the summary.
#   e2e/soak/meminfo.sh                  # 65 minutes, the only adb device
#   e2e/soak/meminfo.sh -m 10 -s SERIAL  # 10 minutes, a given device
# Start it, then the run: Developer checks → "100 Hz batched stream, 60 min" (or
# maestro test e2e/maestro/soak-notifications.yaml).
set -euo pipefail

MINUTES=65
WARMUP=5
SERIAL=${ANDROID_SERIAL:-}
PACKAGE=expo.modules.blekit.example
OUT=meminfo-$(date +%Y%m%d-%H%M).csv

while [ $# -gt 0 ]; do
  case "$1" in
    -m) MINUTES=$2; shift 2 ;;
    -s) SERIAL=$2; shift 2 ;;
    -p) PACKAGE=$2; shift 2 ;;
    -o) OUT=$2; shift 2 ;;
    *) echo "Unknown option $1" >&2; exit 2 ;;
  esac
done

dev() { adb ${SERIAL:+-s "$SERIAL"} "$@"; }
pss_kb() { dev shell dumpsys meminfo "$PACKAGE" | awk '/TOTAL PSS:/ { print $3; exit }'; }

pid=$(dev shell pidof "$PACKAGE" || true)
[ -n "$pid" ] || { echo "$PACKAGE isn't running" >&2; exit 1; }
echo "minute,pss_kb" > "$OUT"
baseline=""
for minute in $(seq 0 "$MINUTES"); do
  [ "$minute" -gt 0 ] && sleep 60
  if [ "$(dev shell pidof "$PACKAGE" || true)" != "$pid" ]; then
    echo "FAILED: the app crashed or restarted at minute $minute." >&2
    exit 1
  fi
  pss=$(pss_kb)
  echo "$minute,$pss" >> "$OUT"
  [ "$minute" -eq "$WARMUP" ] && baseline=$pss
  echo "minute $minute: PSS $pss kB"
done

[ -n "$baseline" ] || { echo "Run at least $WARMUP minutes." >&2; exit 2; }
growth=$(awk -v a="$baseline" -v b="$pss" 'BEGIN { printf "%.1f", (b - a) * 100 / a }')
echo "PSS minute $WARMUP: $baseline kB, minute $MINUTES: $pss kB, growth $growth% ($OUT)."
awk -v g="$growth" 'BEGIN { exit !(g < 10) }' && echo "OK: under 10%." || { echo "FAILED: 10% or more."; exit 1; }
