import CoreBluetooth
import Foundation

// Notifications and indications (P1-08): one CCCD per characteristic, shared by its subscribers.

/// JS `SubscribeOptions.mode` (plan §5.4).
enum SubscribeMode: String {
  case auto
  case notify
  case indicate
}

/// The subscribers of one characteristic and the state of its CCCD.
final class CharacteristicSubscriptions {
  /// Replaced after a reconnection: discovery creates new characteristic objects.
  var characteristic: CharacteristicLike
  /// For finding the characteristic again after a reconnection (P2-01).
  let serviceUUID: CBUUID
  let characteristicUUID: CBUUID
  let indicate: Bool
  var subscribers: Set<Int> = []
  /// Subscribers waiting for the CCCD write that enables delivery.
  var waiting: [Int: (Result<Void, CoreError>) -> Void] = [:]
  var enabled = false

  init(characteristic: CharacteristicLike, serviceUUID: CBUUID, indicate: Bool) {
    self.characteristic = characteristic
    self.serviceUUID = serviceUUID
    characteristicUUID = characteristic.uuid
    self.indicate = indicate
  }
}

extension PeripheralSession {
  typealias SubscriptionCompletion = (Result<Void, CoreError>) -> Void

  /// Subscribes `subscriptionId` (plan §5.4). The first subscriber enables the CCCD through the queue;
  /// later ones share it. An explicit `mode` different from the active one is INVALID_ARGUMENT.
  func subscribe(
    _ path: AttributePath,
    mode: SubscribeMode,
    subscriptionId: Int,
    timeout: TimeInterval?,
    completion: @escaping SubscriptionCompletion
  ) {
    let entry: CharacteristicSubscriptions
    do {
      entry = try subscriptionEntry(path, mode: mode, subscriptionId: subscriptionId)
    } catch {
      return completion(.failure(Self.coreError(error)))
    }
    let key = Self.key(entry.characteristic)
    subscriptionKeys[subscriptionId] = key
    if entry.enabled {
      entry.subscribers.insert(subscriptionId)
      return completion(.success(()))
    }
    entry.waiting[subscriptionId] = completion
    guard subscriptions[key] == nil else {
      return // The CCCD write is already on its way.
    }
    subscriptions[key] = entry
    setNotify(true, for: entry, timeout: timeout) { [weak self] result in
      let waiting = entry.waiting
      entry.waiting.removeAll()
      switch result {
      case .success:
        entry.enabled = true
        entry.subscribers.formUnion(waiting.keys)
      case .failure:
        waiting.keys.forEach { self?.subscriptionKeys.removeValue(forKey: $0) }
        if self?.subscriptions[key] === entry, entry.subscribers.isEmpty {
          self?.subscriptions.removeValue(forKey: key)
        }
      }
      waiting.values.forEach { $0(result) }
    }
  }

  /// Ends `subscriptionId`: delivery stops at once; the last subscriber also disables the CCCD, and a
  /// failed write rejects. Unknown ids and lost connections succeed.
  func unsubscribe(_ subscriptionId: Int, timeout: TimeInterval?, completion: @escaping SubscriptionCompletion) {
    guard let key = subscriptionKeys.removeValue(forKey: subscriptionId), let entry = subscriptions[key] else {
      return completion(.success(()))
    }
    entry.subscribers.remove(subscriptionId)
    entry.waiting.removeValue(forKey: subscriptionId)?(
      .failure(CoreError(.operationCancelled, "unsubscribed before the subscription was ready"))
    )
    guard entry.subscribers.isEmpty, entry.waiting.isEmpty else {
      return completion(.success(()))
    }
    subscriptions.removeValue(forKey: key)
    guard state == .ready else {
      return completion(.success(()))
    }
    setNotify(false, for: entry, timeout: timeout, completion: completion)
  }

  // MARK: PeripheralLikeDelegate (subscriptions)

  func peripheral(
    _ peripheral: PeripheralLike,
    didUpdateNotificationStateFor characteristic: CharacteristicLike,
    error: Error?
  ) {
    complete(.setNotify, Self.key(characteristic), error, output: .none)
  }

  /// Only subscribed characteristics deliver; a stray value after unsubscribing is dropped.
  func deliverNotification(_ value: Data, from characteristic: CharacteristicLike) {
    if subscriptions[Self.key(characteristic)]?.enabled == true {
      onNotification?(characteristic, value)
    }
  }

  // MARK: Private

  private func subscriptionEntry(
    _ path: AttributePath,
    mode: SubscribeMode,
    subscriptionId: Int
  ) throws -> CharacteristicSubscriptions {
    if subscriptionKeys[subscriptionId] != nil {
      throw CoreError(.invalidArgument, "Subscription \(subscriptionId) already exists")
    }
    guard state == .ready else {
      throw CoreError(.disconnected, "Not connected")
    }
    let serviceUUID = CBUUID(string: path.service)
    let characteristicUUID = CBUUID(string: path.characteristic)
    guard let service = peripheral.serviceList.first(where: { $0.uuid == serviceUUID }) else {
      throw CoreError(.serviceNotFound, "Service \(path.service) not found; discover() it first")
    }
    guard let characteristic = service.characteristicList.first(where: { $0.uuid == characteristicUUID }) else {
      throw CoreError(.characteristicNotFound, "Characteristic \(path.characteristic) not found in \(path.service)")
    }
    let indicate = try Self.indicates(characteristic.properties, mode: mode, characteristic: path.characteristic)
    if let existing = subscriptions[Self.key(characteristic)] {
      if mode != .auto, existing.indicate != indicate {
        let active = existing.indicate ? "indications" : "notifications"
        throw CoreError(.invalidArgument, "Characteristic \(path.characteristic) is already subscribed with \(active)")
      }
      return existing
    }
    return CharacteristicSubscriptions(characteristic: characteristic, serviceUUID: serviceUUID, indicate: indicate)
  }

  /// CoreBluetooth picks notifications when a characteristic has both, so `indicate` needs a
  /// characteristic that only indicates (plan §6).
  private static func indicates(
    _ properties: CBCharacteristicProperties,
    mode: SubscribeMode,
    characteristic: String
  ) throws -> Bool {
    let notifies = !properties.isDisjoint(with: [.notify, .notifyEncryptionRequired])
    let indicates = !properties.isDisjoint(with: [.indicate, .indicateEncryptionRequired])
    switch mode {
    case .auto where notifies || indicates:
      return !notifies
    case .notify where notifies:
      return false
    case .indicate where indicates && !notifies:
      return true
    case .indicate where indicates:
      throw CoreError(.notSupported, "iOS uses notifications when \(characteristic) supports both")
    default:
      throw CoreError(.notSupported, "Characteristic \(characteristic) doesn't support \(mode.rawValue)")
    }
  }

  func setNotify(
    _ enable: Bool,
    for entry: CharacteristicSubscriptions,
    timeout: TimeInterval?,
    completion: @escaping SubscriptionCompletion
  ) {
    let characteristic = entry.characteristic
    queue.enqueue(.setNotify, target: Self.key(characteristic), timeout: timeout) { [weak self] in
      self?.peripheral.setNotifyValue(enable, for: characteristic)
    } completion: { result in
      completion(result.map { _ in () })
    }
  }
}
