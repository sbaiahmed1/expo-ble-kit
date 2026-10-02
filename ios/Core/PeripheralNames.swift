import Foundation

/// The latest name seen for each peripheral (plan §4.7), for the synchronous `Peripheral.name`:
/// written on the engine's queue, read from any thread. Keeps the `capacity` most recent names.
final class PeripheralNames {
  private let lock = NSLock()
  private var names: [String: String] = [:]
  /// Ids by last write, oldest first.
  private var order: [String] = []
  private let capacity: Int

  init(capacity: Int = 1_000) {
    self.capacity = capacity
  }

  /// A nil or empty name keeps the one already known.
  subscript(id: String) -> String? {
    get {
      lock.lock()
      defer { lock.unlock() }
      return names[id]
    }
    set {
      guard let newValue, !newValue.isEmpty else {
        return
      }
      lock.lock()
      defer { lock.unlock() }
      if names.updateValue(newValue, forKey: id) != nil {
        order.removeAll { $0 == id }
      }
      order.append(id)
      if order.count > capacity {
        names[order.removeFirst()] = nil
      }
    }
  }
}
