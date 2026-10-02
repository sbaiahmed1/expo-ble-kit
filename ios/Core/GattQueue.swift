import Foundation

/// One GATT operation waiting in, or running through, a `GattQueue`.
final class GattOperation {
  enum Kind: String {
    case discoverServices, discoverCharacteristics, discoverDescriptors
    case read, write, writeWithoutResponse, readDescriptor, writeDescriptor
    case setNotify, readRSSI, requestMTU, connectionPriority, phy, bond
  }

  enum Output: Equatable {
    case none
    case value(Data?)
    case int(Int)
  }

  typealias Completion = (Result<Output, CoreError>) -> Void

  let id: Int
  let kind: Kind
  /// Identifies what the operation acts on (for example "service/characteristic"), so a platform
  /// callback can be matched to the operation it completes.
  let target: String?
  let timeout: TimeInterval
  fileprivate let start: () -> Void
  fileprivate let completion: Completion
  fileprivate var timer: CancellableWork?
  /// The caller was already answered (cancelled); the operation may still occupy the radio.
  fileprivate(set) var isSettled = false

  fileprivate init(
    id: Int,
    kind: Kind,
    target: String?,
    timeout: TimeInterval,
    start: @escaping () -> Void,
    completion: @escaping Completion
  ) {
    self.id = id
    self.kind = kind
    self.target = target
    self.timeout = timeout
    self.start = start
    self.completion = completion
  }

  fileprivate func settle(_ result: Result<Output, CoreError>) {
    guard !isSettled else {
      return
    }
    isSettled = true
    completion(result)
  }
}

/// Serial GATT operation queue for one connection (plan §4.9, ADR-006, Appendix B rules 2, 4, 5).
///
/// - Exactly one operation is in flight; the next starts only after the current one completes,
///   times out, or the queue is failed.
/// - Every operation has a timeout and every caller is answered exactly once.
/// - Cancelling a queued operation removes it. Cancelling the running one answers the caller at once,
///   but the queue stays busy until the radio answers or the timeout fires, because the platform
///   operation can't be aborted.
/// - A completion arriving after its operation timed out is ignored.
///
/// Not thread-safe: call it only on the engine's queue, the same one `scheduler` runs on.
final class GattQueue {
  static let defaultTimeout: TimeInterval = 10

  private let scheduler: Scheduling
  private let defaultTimeout: TimeInterval
  private var pending: [GattOperation] = []
  private(set) var current: GattOperation?
  private var nextId = 1
  private var pumpScheduled = false
  /// Timeouts in a row, reset by any completion. The Android session disconnects after two (§4.9).
  private(set) var consecutiveTimeouts = 0
  var onTimeout: ((GattOperation, _ consecutiveTimeouts: Int) -> Void)?

  init(scheduler: Scheduling, defaultTimeout: TimeInterval = GattQueue.defaultTimeout) {
    self.scheduler = scheduler
    self.defaultTimeout = defaultTimeout
  }

  /// Queued plus in-flight operations.
  var depth: Int { pending.count + (current == nil ? 0 : 1) }

  /// Queues an operation. `start` issues the platform call when its turn comes; the result is
  /// reported later through `complete(_:where:)`.
  @discardableResult
  func enqueue(
    _ kind: GattOperation.Kind,
    target: String? = nil,
    timeout: TimeInterval? = nil,
    start: @escaping () -> Void,
    completion: @escaping GattOperation.Completion
  ) -> GattOperation {
    let operation = GattOperation(
      id: nextId,
      kind: kind,
      target: target,
      timeout: timeout ?? defaultTimeout,
      start: start,
      completion: completion
    )
    nextId += 1
    pending.append(operation)
    schedulePump()
    return operation
  }

  /// Completes the in-flight operation if it matches. Returns false for late or foreign callbacks.
  @discardableResult
  func complete(_ result: Result<GattOperation.Output, CoreError>, where matches: (GattOperation) -> Bool) -> Bool {
    guard let operation = current, matches(operation) else {
      return false
    }
    finishCurrent()
    consecutiveTimeouts = 0
    operation.settle(result)
    return true
  }

  /// Answers the caller with OPERATION_CANCELLED (plan §4.9).
  func cancel(_ operation: GattOperation) {
    if let index = pending.firstIndex(where: { $0 === operation }) {
      pending.remove(at: index)
    }
    operation.settle(.failure(CoreError(.operationCancelled, "Operation \(operation.kind.rawValue) was cancelled")))
  }

  /// Fails the running and all queued operations, for example on disconnection (rule 5).
  func failAll(_ error: CoreError) {
    let operations = (current.map { [$0] } ?? []) + pending
    current?.timer?.cancel()
    current = nil
    pending.removeAll()
    for operation in operations {
      operation.settle(.failure(error))
    }
  }

  // MARK: - Internals

  private func schedulePump() {
    guard !pumpScheduled else {
      return
    }
    pumpScheduled = true
    // Always asynchronous: an operation can complete inside `start`, and the next one must not
    // start re-entrantly from inside that callback.
    scheduler.schedule { [weak self] in
      self?.pumpScheduled = false
      self?.pump()
    }
  }

  private func pump() {
    guard current == nil, !pending.isEmpty else {
      return
    }
    let operation = pending.removeFirst()
    current = operation
    operation.timer = scheduler.schedule(after: operation.timeout) { [weak self, weak operation] in
      guard let self, let operation else {
        return
      }
      self.timeOut(operation)
    }
    operation.start()
  }

  private func finishCurrent() {
    current?.timer?.cancel()
    current = nil
    schedulePump()
  }

  private func timeOut(_ operation: GattOperation) {
    guard current === operation else {
      return
    }
    finishCurrent()
    consecutiveTimeouts += 1
    let message = "Operation \(operation.kind.rawValue) timed out after \(operation.timeout) s"
    operation.settle(.failure(CoreError(.operationTimeout, message)))
    onTimeout?(operation, consecutiveTimeouts)
  }
}
