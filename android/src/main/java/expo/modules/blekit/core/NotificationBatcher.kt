package expo.modules.blekit.core

/** Values a batched subscriber receives at once (plan §4.10, P2-04). */
class NotificationBatch(val values: List<ByteArray>, val timestamps: List<Double>, val dropped: Int)

/**
 * Collects one subscriber's notifications and hands them over at most once per [intervalMs] (plan
 * §4.10, P2-04). The first value of an empty batch starts the interval, so an idle characteristic
 * costs nothing. A batch holds at most [maxItems] values: older ones are dropped and counted, and
 * [onFirstDrop] hears about the first drop of this subscriber.
 */
class NotificationBatcher(
  private val intervalMs: Long,
  private val maxItems: Int,
  private val executor: SerialExecutor,
  private val onFirstDrop: () -> Unit,
  private val deliver: (NotificationBatch) -> Unit,
) {
  private val values = ArrayDeque<ByteArray>()
  private val timestamps = ArrayDeque<Double>()
  private var dropped = 0
  private var everDropped = false
  private var timer: Cancellable? = null

  fun add(value: ByteArray, timestamp: Double) {
    if (values.size == maxItems) {
      values.removeFirst()
      timestamps.removeFirst()
      dropped++
      if (!everDropped) {
        everDropped = true
        onFirstDrop()
      }
    }
    values.addLast(value)
    timestamps.addLast(timestamp)
    if (timer == null) {
      timer = executor.executeDelayed(intervalMs) {
        timer = null
        flush()
      }
    }
  }

  /** Hands over what was collected, if anything (also when the subscription ends with the link). */
  fun flush() {
    timer?.cancel()
    timer = null
    if (values.isEmpty() && dropped == 0) return
    val batch = NotificationBatch(values.toList(), timestamps.toList(), dropped)
    values.clear()
    timestamps.clear()
    dropped = 0
    deliver(batch)
  }

  /** Drops what was collected: the subscriber was removed, so delivery stops at once. */
  fun cancel() {
    timer?.cancel()
    timer = null
    values.clear()
    timestamps.clear()
    dropped = 0
  }
}
