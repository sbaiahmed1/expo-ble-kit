import Foundation

/// How a session reconnects after an unexpected link loss (plan §5.4 `ReconnectPolicy`, P2-01).
/// Values come from JS after the TS layer applied the defaults.
struct ReconnectPolicy {
  /// Reconnection attempts before giving up; nil for no limit.
  var maxAttempts: Int?
  var initialDelay: TimeInterval = 1
  var maxDelay: TimeInterval = 30
  /// Doubles the wait after each failed attempt, up to `maxDelay`; false waits `initialDelay` each time.
  var exponential = true

  /// The wait before attempt `attempt` (1-based).
  func delay(attempt: Int) -> TimeInterval {
    guard exponential else {
      return initialDelay
    }
    let doublings = min(max(attempt - 1, 0), 20)
    return min(maxDelay, initialDelay * Double(1 << doublings))
  }

  /// Whether attempt `attempt` (1-based) may run.
  func allows(_ attempt: Int) -> Bool {
    maxAttempts.map { attempt <= $0 } ?? true
  }
}
