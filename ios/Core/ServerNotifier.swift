import CoreBluetooth
import Foundation

/// The GATT server's notifications (P4-02): one `updateValue` queue for the whole peripheral
/// manager, as iOS has one transmit queue. A full queue (`updateValue` returns false) waits for
/// `peripheralManagerIsReady`; a value waits at most `timeout` (rule 4).
///
/// Threading (plan §4.7): on the peripheral queue.
final class ServerNotifier {
  static let timeout: TimeInterval = 10
  /// A notification's payload before the MTU is known (ATT_MTU 23 − 3).
  static let defaultLimit = 20

  private struct Update {
    let characteristic: CBUUID
    let value: Data
    let centrals: [UUID]
    let completion: (CoreError?) -> Void
  }

  private let manager: PeripheralManaging
  private let scheduler: Scheduling
  private var queue: [Update] = []
  private var waiting: CancellableWork?

  init(manager: PeripheralManaging, scheduler: Scheduling) {
    self.manager = manager
    self.scheduler = scheduler
  }

  /// Queues `value` for `centrals`, which must all have subscribed. The value must fit each one.
  func send(
    _ value: Data,
    for characteristic: CBUUID,
    to centrals: [UUID],
    completion: @escaping (CoreError?) -> Void
  ) {
    guard !centrals.isEmpty else { return completion(nil) }
    for central in centrals {
      let limit = manager.maximumUpdateValueLength(for: central) ?? Self.defaultLimit
      if value.count > limit {
        return completion(CoreError(
          .invalidAttributeLength,
          "A notification to \(central.uuidString) takes at most \(limit) bytes, got \(value.count)"
        ))
      }
    }
    queue.append(Update(characteristic: characteristic, value: value, centrals: centrals, completion: completion))
    if queue.count == 1 { pump() }
  }

  /// The transmit queue has room again.
  func ready() {
    waiting?.cancel()
    waiting = nil
    pump()
  }

  /// Fails what is queued (the server closed).
  func cancelAll() {
    waiting?.cancel()
    waiting = nil
    let updates = queue
    queue.removeAll()
    updates.forEach { $0.completion(CoreError(.disconnected, "The GATT server closed")) }
  }

  private func pump() {
    while waiting == nil, let update = queue.first {
      guard manager.updateValue(update.value, for: update.characteristic, onSubscribedCentrals: update.centrals) else {
        waiting = scheduler.schedule(after: Self.timeout) { [weak self] in
          guard let self, !self.queue.isEmpty else { return }
          self.waiting = nil
          let stuck = self.queue.removeFirst()
          stuck.completion(CoreError(.operationTimeout, "Notifying timed out after \(Int(Self.timeout)) s"))
          self.pump()
        }
        return
      }
      queue.removeFirst()
      update.completion(nil)
    }
  }
}
