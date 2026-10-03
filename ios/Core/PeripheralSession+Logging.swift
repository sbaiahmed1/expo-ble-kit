import Foundation

// The debug log of GATT operations (plan §4.16, P2-07).

extension PeripheralSession {
  /// `read <target>: ok in 12 ms`: op id, peripheral, kind, status and duration.
  func logSettled(
    _ operation: GattOperation,
    _ result: Result<GattOperation.Output, CoreError>,
    elapsed: TimeInterval?
  ) {
    logger.log(.debug, peripheralId: peripheral.identifier.uuidString, opId: operation.id) {
      let what = [operation.kind.rawValue, operation.target].compactMap { $0 }.joined(separator: " ")
      let status: String
      switch result {
      case .success:
        status = "ok"
      case let .failure(error):
        status = "\(error.code.rawValue) (\(error.message))"
      }
      let when = elapsed.map { "in \(Int(($0 * 1000).rounded())) ms" } ?? "before it started"
      return "\(what): \(status) \(when)"
    }
  }
}

extension BleLogger {
  /// A logger that writes nothing, for sessions created outside an engine.
  func silenced() -> BleLogger {
    level = .none
    return self
  }
}
