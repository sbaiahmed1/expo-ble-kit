import CoreBluetooth
import Foundation

// A Mac as the test peripheral: the GATT profile of test-peripherals/profile.json, served with
// CoreBluetooth (see ../README.md). Same behaviors as the Bumble peripheral, minus what macOS can't
// do: DISCONNECT_AFTER (a peripheral can't end a connection), manufacturer data, service data and
// TX power in the advertisement, and a fixed L2CAP PSM (L2CAP_PSM serves the one macOS assigns).
// Arguments: <log file> <profile.json> [seconds to run] [local name] [heart-rate: advertise only
// Heart Rate, which the 31-byte advertisement can't hold beside TEST]. run.sh builds and starts it.

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
  let usage = "usage: BleKitPeripheral <log> <profile.json> [seconds] [local name] [heart-rate]\n"
  FileHandle.standardError.write(Data(usage.utf8))
  exit(2)
}
Log.open(arguments[1])
do {
  let profile = try Profile(path: arguments[2])
  let seconds = arguments.count > 3 ? Double(arguments[3]) ?? 600 : 600
  let name = arguments.count > 4 && !arguments[4].isEmpty ? arguments[4] : profile.localName
  let advertised = arguments.count > 5 && arguments[5] == "heart-rate"
    ? [CBUUID(string: "180D")]
    : profile.advertisedServices
  let peripheral = TestPeripheral(profile: profile, name: name, advertised: advertised)
  peripheral.start()
  DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
    Log.write("DONE: stopped after \(Int(seconds)) s")
    exit(0)
  }
  dispatchMain()
} catch {
  Log.write("FAILED: \(error)")
  exit(1)
}
