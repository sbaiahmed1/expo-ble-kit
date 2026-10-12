import Foundation

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

struct Failure: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}
