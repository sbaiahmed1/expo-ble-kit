import Foundation
@testable import BleKitCore

/// `Scheduling` with virtual time. Nothing runs until the test calls `runUntilIdle()` or
/// `advance(by:)`; tasks run in time order, then in scheduling order.
final class TestScheduler: Scheduling {
  private final class Task: CancellableWork {
    let id: Int
    let time: TimeInterval
    let work: () -> Void
    var isCancelled = false

    init(id: Int, time: TimeInterval, work: @escaping () -> Void) {
      self.id = id
      self.time = time
      self.work = work
    }

    func cancel() {
      isCancelled = true
    }
  }

  private(set) var now: TimeInterval = 0
  private var tasks: [Task] = []
  private var nextId = 0

  var pendingCount: Int { tasks.filter { !$0.isCancelled }.count }

  func schedule(_ work: @escaping () -> Void) {
    add(at: now, work)
  }

  @discardableResult
  func schedule(after delay: TimeInterval, _ work: @escaping () -> Void) -> CancellableWork {
    add(at: now + max(0, delay), work)
  }

  /// Runs everything due now, including work scheduled while running.
  func runUntilIdle() {
    advance(by: 0)
  }

  /// Moves virtual time forward, running due tasks in order.
  func advance(by seconds: TimeInterval) {
    let target = now + seconds
    while let next = tasks
      .filter({ !$0.isCancelled && $0.time <= target })
      .min(by: { ($0.time, $0.id) < ($1.time, $1.id) }) {
      tasks.removeAll { $0 === next }
      now = next.time
      next.work()
    }
    tasks.removeAll { $0.isCancelled }
    now = target
  }

  @discardableResult
  private func add(at time: TimeInterval, _ work: @escaping () -> Void) -> CancellableWork {
    let task = Task(id: nextId, time: time, work: work)
    nextId += 1
    tasks.append(task)
    return task
  }
}
