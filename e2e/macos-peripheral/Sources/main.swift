import CoreBluetooth
import Foundation

// A Mac as the test peripheral: the GATT profile of test-peripherals/profile.json, served with
// CoreBluetooth (see ../README.md). Same behaviors as the Bumble peripheral, minus what macOS can't
// do: DISCONNECT_AFTER (a peripheral can't end a connection), manufacturer data, service data and
// TX power in the advertisement, and a fixed L2CAP PSM (L2CAP_PSM serves the one macOS assigns).
// Arguments: <log file> <profile.json> [seconds to run] [local name]. run.sh builds and starts it.

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
  FileHandle.standardError.write(Data("usage: BleKitPeripheral <log> <profile.json> [seconds] [local name]\n".utf8))
  exit(2)
}
Log.open(arguments[1])
do {
  let profile = try Profile(path: arguments[2])
  let seconds = arguments.count > 3 ? Double(arguments[3]) ?? 600 : 600
  let name = arguments.count > 4 ? arguments[4] : profile.localName
  let peripheral = TestPeripheral(profile: profile, name: name)
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
