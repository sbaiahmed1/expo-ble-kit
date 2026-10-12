# Shared by run.sh and server.sh.

bundle="expo.modules.blekit.example"
journal_path="Library/Application Support/expo-ble-kit/restoration-journal.json"

# Fails when the phone is locked: iOS won't launch apps then.
require_unlocked() {
  if xcrun devicectl device info lockState --device "$1" 2>/dev/null | grep -q "passcodeRequired: true"; then
    echo "Unlock the iPhone first (and keep it awake)"
    exit 1
  fi
}

# Prints the restoration journal the library keeps on the phone ($1 device, $2 a work directory).
print_journal() {
  if xcrun devicectl device copy from --device "$1" --domain-type appDataContainer \
    --domain-identifier "$bundle" --source "$journal_path" --destination "$2/journal.json" >/dev/null 2>&1; then
    python3 -I -c '
import datetime, json, sys
for entry in json.load(open(sys.argv[1]))[-int(sys.argv[2]):]:
    time = datetime.datetime.fromtimestamp(entry["time"] / 1000).strftime("%H:%M:%S")
    count = " x" + str(entry["count"]) if entry["count"] > 1 else ""
    print("  " + time + " " + entry["event"] + count)
' "$2/journal.json" "${3:-100}"
  else
    echo "  (no journal on the phone yet)"
  fi
}
