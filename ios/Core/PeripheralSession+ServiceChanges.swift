import CoreBluetooth
import Foundation

// Service changes (P2-06): the peripheral's GATT database changed while connected.

extension PeripheralSession {
  /// CoreBluetooth reports invalidated services (and already dropped them from the peripheral). The
  /// cache is stale, so it is emptied and discovered again ahead of queued operations; the
  /// subscriptions are restored on what is still there, then `onServicesChanged` fires. During
  /// setup the discovery under way picks up the new database.
  func peripheral(_ peripheral: PeripheralLike, didModifyServices invalidatedServices: [ServiceLike]) {
    guard state == .ready else {
      return
    }
    if !services.isEmpty {
      services = []
      onServicesChange?([])
    }
    subscriptions.values.forEach { $0.enabled = false }
    discover(nil, timeout: nil, first: true) { [weak self] result in
      guard let self, state == .ready else {
        return
      }
      if case let .failure(error) = result {
        onWarning?(CoreError(error.code, "Discovering the changed services failed (\(error.message))"))
      }
      restoreSubscriptions(after: "the service change") { [weak self] in
        self?.onServicesChanged?()
      }
    }
  }
}
