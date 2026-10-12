import CoreBluetooth
import Foundation

// State restoration (P3-01, plan §4.14): iOS relaunched the app in the background, or the app
// created its manager again with the same restore identifier, and handed back the peripherals it
// kept for the app.

extension PeripheralSession {
  /// The subscriber of a characteristic that was notifying when iOS restored the peripheral. Its
  /// values reach `onNotification` until a JS subscription takes the characteristic over.
  static let restoredSubscriptionId = -1

  /// Adopts a restored peripheral, once the manager is powered on: a connected one becomes ready
  /// with the services CoreBluetooth kept (discovered again when it kept none), and the
  /// characteristics still notifying keep delivering; a pending connection stays pending, without a
  /// timeout. Returns false for a peripheral in any other state.
  @discardableResult
  func adoptRestored() -> Bool {
    switch peripheral.state {
    case .connected:
      connectTimeoutValue = nil
      setState(.connected, nil)
      guard !peripheral.serviceList.isEmpty else {
        setState(.discovering, nil)
        discover(nil, timeout: nil) { [weak self] result in
          guard let self, state == .discovering else {
            return
          }
          switch result {
          case .success:
            adoptNotifyingCharacteristics()
            becomeReady()
          case let .failure(error):
            failConnect(error)
          }
        }
        return true
      }
      services = peripheral.serviceList.map(DiscoveredService.init)
      onServicesChange?(services)
      adoptNotifyingCharacteristics()
      becomeReady()
      return true
    case .connecting:
      connectTimeoutValue = nil
      restoredPending = true
      setState(.connecting, nil)
      return true
    default:
      return false
    }
  }

  /// `service/characteristic` of the characteristics restored as notifying, for the journal.
  var restoredSubscriptions: [String] {
    subscriptions.values
      .filter { $0.subscribers.contains(Self.restoredSubscriptionId) }
      .map { "\($0.serviceUUID.fullUUIDString)/\($0.characteristicUUID.fullUUIDString)" }
      .sorted()
  }

  private func adoptNotifyingCharacteristics() {
    for service in peripheral.serviceList {
      for characteristic in service.characteristicList where characteristic.isNotifying {
        let notifies = !characteristic.properties.isDisjoint(with: [.notify, .notifyEncryptionRequired])
        let entry = CharacteristicSubscriptions(
          characteristic: characteristic,
          serviceUUID: service.uuid,
          indicate: !notifies
        )
        entry.enabled = true
        entry.subscribers.insert(Self.restoredSubscriptionId)
        subscriptions[Self.key(characteristic)] = entry
      }
    }
  }
}
