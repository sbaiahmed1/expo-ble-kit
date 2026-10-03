import Foundation
import os

/// JS `LogLevel` (plan §4.16), most severe first.
enum LogLevel: String, CaseIterable {
  case none, error, warn, info, debug, verbose

  var rank: Int { Self.allCases.firstIndex(of: self) ?? 0 }
}

/// One log line as JS `LogEntry` gets it; `timestamp` in epoch milliseconds.
struct LogEntry: Equatable {
  let level: LogLevel
  let message: String
  let timestamp: Double
  var peripheralId: String?
  var opId: Int?
}

/// The core's log (plan §4.16): lines at or above `level` go to `platform` (`os.Logger`, subsystem
/// `expo.blekit`, in the app) and to `forward` while JS has a log handler. Messages are built only
/// when their level is on. Safe from any thread.
final class BleLogger {
  private let lock = NSLock()
  private let clock: () -> Double
  private var storedLevel = LogLevel.warn
  private var storedForward: ((LogEntry) -> Void)?
  private var storedPlatform: (LogLevel, String) -> Void

  init(clock: @escaping () -> Double, platform: @escaping (LogLevel, String) -> Void = { _, _ in }) {
    self.clock = clock
    storedPlatform = platform
  }

  var level: LogLevel {
    get { lock.withLock { storedLevel } }
    set { lock.withLock { storedLevel = newValue } }
  }

  var forward: ((LogEntry) -> Void)? {
    get { lock.withLock { storedForward } }
    set { lock.withLock { storedForward = newValue } }
  }

  var platform: (LogLevel, String) -> Void {
    get { lock.withLock { storedPlatform } }
    set { lock.withLock { storedPlatform = newValue } }
  }

  func isOn(_ level: LogLevel) -> Bool {
    level != .none && level.rank <= self.level.rank
  }

  func log(_ level: LogLevel, peripheralId: String? = nil, opId: Int? = nil, _ message: () -> String) {
    guard isOn(level) else {
      return
    }
    let text = message()
    let prefix = [peripheralId, opId.map { "op #\($0)" }].compactMap { $0 }.joined(separator: " ")
    platform(level, prefix.isEmpty ? text : "\(prefix): \(text)")
    forward?(LogEntry(level: level, message: text, timestamp: clock(), peripheralId: peripheralId, opId: opId))
  }

  private static let osLogger = Logger(subsystem: "expo.blekit", category: "ble")

  /// Writes a line to the unified log, subsystem `expo.blekit`.
  static func osLog(_ level: LogLevel, _ line: String) {
    let type: OSLogType
    switch level {
    case .error:
      type = .error
    case .warn:
      type = .default
    case .info:
      type = .info
    default:
      type = .debug
    }
    osLogger.log(level: type, "\(line, privacy: .public)")
  }
}
