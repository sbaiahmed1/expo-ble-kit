import Foundation

/// Values a batched subscriber receives at once (plan §4.10, P2-04).
struct NotificationBatch: Equatable {
  let values: [Data]
  let timestamps: [Double]
  let dropped: Int
}

/// How a batched subscriber receives values (plan §4.10, P2-04).
struct BatchSpec: Equatable {
  static let defaultMaxItems = 4096

  var interval: TimeInterval
  var maxItems = defaultMaxItems
}

/// Collects one subscriber's notifications and hands them over at most once per interval (plan
/// §4.10, P2-04). The first value of an empty batch starts the interval, so an idle characteristic
/// costs nothing. A batch holds at most `maxItems` values: older ones are dropped and counted, and
/// `onFirstDrop` hears about the first drop of this subscriber.
final class NotificationBatcher {
  private let spec: BatchSpec
  private let scheduler: Scheduling
  private let onFirstDrop: () -> Void
  private let deliver: (NotificationBatch) -> Void
  private var values: [Data] = []
  private var timestamps: [Double] = []
  private var dropped = 0
  private var everDropped = false
  private var timer: CancellableWork?

  init(
    _ spec: BatchSpec,
    scheduler: Scheduling,
    onFirstDrop: @escaping () -> Void,
    deliver: @escaping (NotificationBatch) -> Void
  ) {
    self.spec = spec
    self.scheduler = scheduler
    self.onFirstDrop = onFirstDrop
    self.deliver = deliver
  }

  func add(_ value: Data, timestamp: Double) {
    if values.count == spec.maxItems {
      values.removeFirst()
      timestamps.removeFirst()
      dropped += 1
      if !everDropped {
        everDropped = true
        onFirstDrop()
      }
    }
    values.append(value)
    timestamps.append(timestamp)
    if timer == nil {
      timer = scheduler.schedule(after: spec.interval) { [weak self] in
        self?.timer = nil
        self?.flush()
      }
    }
  }

  /// Hands over what was collected, if anything (also when the subscription ends with the link).
  func flush() {
    timer?.cancel()
    timer = nil
    guard !values.isEmpty || dropped > 0 else {
      return
    }
    let batch = NotificationBatch(values: values, timestamps: timestamps, dropped: dropped)
    values.removeAll()
    timestamps.removeAll()
    dropped = 0
    deliver(batch)
  }

  /// Drops what was collected: the subscriber was removed, so delivery stops at once.
  func cancel() {
    timer?.cancel()
    timer = nil
    values.removeAll()
    timestamps.removeAll()
    dropped = 0
  }
}
