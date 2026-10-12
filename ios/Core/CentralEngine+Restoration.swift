import CoreBluetooth
import Foundation

// State restoration (P3-01, plan §4.14). With `ios.restoreIdentifier` and the bluetooth-central
// background mode, the manager carries a restore identifier: iOS then keeps the app's connections
// while it isn't running, relaunches it in the background for their events, and hands the
// peripherals back to the manager created with that identifier at launch.

/// A peripheral iOS restored, once adopted: its id, JS state and the characteristics restored as
/// notifying (`service/characteristic`).
struct RestoredPeripheral: Equatable {
  let id: String
  let state: String
  let subscriptions: [String]
}

extension CentralEngine {
  /// The restore identifier: set when Info.plist has it and the bluetooth-central background mode,
  /// without which iOS doesn't restore.
  var restoreIdentifier: String? {
    Self.restoreIdentifier(in: environment.infoDictionary())
  }

  static func restoreIdentifier(in infoDictionary: [String: Any]?) -> String? {
    guard let identifier = infoDictionary?[restoreIdentifierKey] as? String, !identifier.isEmpty,
          let modes = infoDictionary?["UIBackgroundModes"] as? [String], modes.contains("bluetooth-central")
    else {
      return nil
    }
    return identifier
  }

  /// iOS calls this before the first state update; the peripherals wait until the manager is on.
  func central(_ central: CentralManaging, willRestoreState state: [String: Any], peripherals: [PeripheralLike]) {
    restoredPeripherals = peripherals
    logger.log(.info) { "restoring \(peripherals.count) peripheral(s)" }
    if central.state == .poweredOn {
      adoptRestoredPeripherals(central)
    }
  }

  /// Sessions for the restored peripherals: connected ones become ready, pending ones stay pending.
  func adoptRestoredPeripherals(_ central: CentralManaging) {
    guard !restoredPeripherals.isEmpty else {
      return
    }
    let peripherals = restoredPeripherals
    restoredPeripherals.removeAll()
    var adopted: [RestoredPeripheral] = []
    for peripheral in peripherals {
      let identifier = peripheral.identifier
      let session = sessions[identifier] ?? makeSession(identifier, peripheral: peripheral, central: central)
      guard session.adoptRestored() else {
        if session.state == .disconnected {
          sessions.removeValue(forKey: identifier)
        }
        continue
      }
      adopted.append(RestoredPeripheral(
        id: identifier.uuidString,
        state: session.state.js,
        subscriptions: session.restoredSubscriptions
      ))
    }
    if !adopted.isEmpty {
      onRestored?(adopted)
    }
  }
}
