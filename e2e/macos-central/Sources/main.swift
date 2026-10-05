import Foundation

// A Mac as the central for the example app's GATT server (P4-01, P4-02): see ../README.md.
// Arguments: <log file> <profile.json> [stream seconds]. run.sh builds and starts it.

enum Log {
  private static var file: FileHandle?
  private static let start = Date()

  static func open(_ path: String) {
    FileManager.default.createFile(atPath: path, contents: nil)
    file = FileHandle(forWritingAtPath: path)
  }

  static func write(_ message: String) {
    let line = String(format: "%7.3f ", Date().timeIntervalSince(start)) + message + "\n"
    file?.write(Data(line.utf8))
    try? file?.synchronize()
  }
}

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
  FileHandle.standardError.write(Data("usage: BleKitCentral <log> <profile.json> [stream seconds]\n".utf8))
  exit(2)
}
Log.open(arguments[1])
do {
  let profile = try Profile(path: arguments[2])
  let central = Central(profile: profile, streamSeconds: arguments.count > 3 ? Double(arguments[3]) ?? 10 : 10)
  Task { await central.run() }
  dispatchMain()
} catch {
  Log.write("FAILED: \(error)")
  exit(1)
}
