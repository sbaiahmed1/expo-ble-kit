#!/usr/bin/env bash
# P4-05: the two-phone suite. Phone B switches on the Peripheral tab (the test peripheral), then
# phone A finds it by the TEST service and runs the suite: reads and long reads, writes and long
# writes, writes without response, the 100 Hz stream, indications, invalid commands, Heart Rate.
#   e2e/maestro/two-phone.sh <phone B> <phone A>          # 10 s stream
#   e2e/maestro/two-phone.sh <phone B> <phone A> --long   # 10-minute stream (P4-02's acceptance)
# Phones by the id `maestro --device` takes (adb serial, iPhone UDID). Run it with B and A swapped,
# and with each iOS/Android pairing, for P4-05's acceptance.
set -euo pipefail

if [ $# -lt 2 ]; then
  sed -n '2,8p' "$0" >&2
  exit 2
fi
PERIPHERAL=$1
CENTRAL=$2
LONG=false
[ "${3:-}" = "--long" ] && LONG=true
FLOWS="$(cd "$(dirname "$0")" && pwd)"

maestro --device "$PERIPHERAL" test "$FLOWS/_two-phone-peripheral.yaml"
maestro --device "$CENTRAL" test -e LONG="$LONG" "$FLOWS/_two-phone-central.yaml"
