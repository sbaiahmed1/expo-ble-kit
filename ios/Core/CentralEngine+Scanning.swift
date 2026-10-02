import CoreBluetooth
import Foundation

// Scanning (P1-04).

extension CentralEngine {
  /// Starts a scan session (plan §5.3). Throws when scanning can't start: a missing declaration, no
  /// authorization, or Bluetooth that is off. Never shows the permission prompt. While the manager
  /// still reports `unknown`, the session waits for the first real state.
  func startScan(_ sessionId: Int, spec: ScanSpec) throws {
    if let error = missingDeclaration() {
      throw error
    }
    if scanController.activeSessionIds.contains(sessionId) {
      throw CoreError(.invalidArgument, "Scan session \(sessionId) is already running")
    }
    let central = try authorizedCentral()
    if let error = Self.adapterError(central.state) {
      throw error
    }
    scanController.start(sessionId, spec: spec)
  }

  func stopScan(_ sessionId: Int) {
    scanController.stop(sessionId)
  }

  func central(
    _ central: CentralManaging,
    didDiscover peripheral: PeripheralLike,
    advertisementData: [String: Any],
    rssi: Int
  ) {
    scanController.deliver(peripheral, advertisementData: advertisementData, rssi: rssi)
  }
}
