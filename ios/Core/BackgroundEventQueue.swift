import Foundation

/// Background events (P3-02) on their way to the app's tasks. Until released they wait, in order:
/// expo-task-manager 57 loses an event handed to it while JS starts listening (its module swaps
/// its queue on the JS thread while events arrive on the main thread), so delivery starts `grace`
/// after the app's JS reached the library, or `fallbackDelay` after launch for an app whose JS
/// never does. At most `maxHeld` wait; older ones are dropped and counted.
///
/// Threading: any thread; `output` runs on the scheduler's queue.
final class BackgroundEventQueue {
  typealias Event = [String: Any]

  static let maxHeld = 1000
  static let grace: TimeInterval = 1
  static let fallbackDelay: TimeInterval = 15

  private let scheduler: Scheduling
  private let output: (Event) -> Void
  private let lock = NSLock()
  private var held: [Event] = []
  private var released = false
  private var pendingRelease: CancellableWork?
  private(set) var dropped = 0

  init(scheduler: Scheduling, output: @escaping (Event) -> Void) {
    self.scheduler = scheduler
    self.output = output
  }

  /// At launch: the fallback release.
  func launched() {
    schedule(after: Self.fallbackDelay)
  }

  /// The app's JS reached the library: release after the grace period.
  func jsStarted() {
    schedule(after: Self.grace)
  }

  func submit(_ event: Event) {
    lock.lock()
    guard !released else {
      lock.unlock()
      return scheduler.schedule { [output] in output(event) }
    }
    held.append(event)
    if held.count > Self.maxHeld {
      held.removeFirst(held.count - Self.maxHeld)
      dropped += 1
    }
    lock.unlock()
  }

  var heldCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return held.count
  }

  private func schedule(after delay: TimeInterval) {
    lock.lock()
    defer { lock.unlock() }
    guard !released else {
      return
    }
    pendingRelease?.cancel()
    pendingRelease = scheduler.schedule(after: delay) { [weak self] in self?.release() }
  }

  private func release() {
    lock.lock()
    released = true
    pendingRelease = nil
    let events = held
    held.removeAll()
    lock.unlock()
    events.forEach(output)
  }
}
