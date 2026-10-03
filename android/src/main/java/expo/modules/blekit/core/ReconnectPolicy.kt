package expo.modules.blekit.core

/**
 * How a session reconnects after an unexpected link loss (plan §5.4 `ReconnectPolicy`, P2-01).
 * Values come from JS after the TS layer applied the defaults.
 */
class ReconnectPolicy(
  /** Reconnection attempts before giving up; null for no limit. */
  val maxAttempts: Int? = null,
  val initialDelayMs: Long = 1_000,
  val maxDelayMs: Long = 30_000,
  /** Doubles the wait after each failed attempt, up to [maxDelayMs]; false waits [initialDelayMs] each time. */
  val exponential: Boolean = true,
) {
  /** The wait before attempt [attempt] (1-based). */
  fun delayMs(attempt: Int): Long {
    if (!exponential) return initialDelayMs
    val doublings = (attempt - 1).coerceIn(0, MAX_DOUBLINGS)
    return minOf(maxDelayMs, initialDelayMs shl doublings)
  }

  /** Whether attempt [attempt] (1-based) may run. */
  fun allows(attempt: Int): Boolean = maxAttempts == null || attempt <= maxAttempts

  private companion object {
    /** Keeps the shift far from overflowing: 2^20 × any sane delay is already past maxDelayMs. */
    const val MAX_DOUBLINGS = 20
  }
}
