import Foundation

/// Work scheduled for later that can still be cancelled.
protocol CancellableWork: AnyObject {
  func cancel()
}

/// Runs work on the engine's serial queue, now or after a delay, and tells the time.
/// Abstracted so timeout logic can be tested with virtual time (plan §4.7, §4.9).
protocol Scheduling: AnyObject {
  /// Monotonic time in seconds.
  var now: TimeInterval { get }
  func schedule(_ work: @escaping () -> Void)
  @discardableResult
  func schedule(after delay: TimeInterval, _ work: @escaping () -> Void) -> CancellableWork
}

extension DispatchWorkItem: CancellableWork {}

/// `Scheduling` on a GCD serial queue.
final class QueueScheduler: Scheduling {
  let queue: DispatchQueue

  init(queue: DispatchQueue) {
    self.queue = queue
  }

  var now: TimeInterval {
    TimeInterval(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
  }

  func schedule(_ work: @escaping () -> Void) {
    queue.async(execute: work)
  }

  @discardableResult
  func schedule(after delay: TimeInterval, _ work: @escaping () -> Void) -> CancellableWork {
    let item = DispatchWorkItem(block: work)
    queue.asyncAfter(deadline: .now() + delay, execute: item)
    return item
  }
}
