package expo.modules.blekit.core

/** One GATT operation waiting in, or running through, a [GattQueue]. */
class GattOperation internal constructor(
  val id: Long,
  val kind: Kind,
  /** Identifies what the operation acts on, so a platform callback can be matched to it. */
  val target: String?,
  val timeoutMs: Long,
  internal val start: () -> Unit,
  private val completion: (GattResult) -> Unit,
) {
  enum class Kind {
    DISCOVER_SERVICES,
    READ,
    WRITE,
    WRITE_WITHOUT_RESPONSE,
    READ_DESCRIPTOR,
    WRITE_DESCRIPTOR,
    SET_NOTIFY,
    READ_RSSI,
    REQUEST_MTU,
    CONNECTION_PRIORITY,
    PHY,
    BOND,
  }

  internal var timer: Cancellable? = null

  /** The caller was already answered (cancelled); the operation may still occupy the radio. */
  var isSettled = false
    private set

  internal fun settle(result: GattResult) {
    if (isSettled) return
    isSettled = true
    completion(result)
  }
}

sealed interface GattResult {
  data class Success(val value: ByteArray? = null, val number: Int? = null) : GattResult

  data class Failure(val error: CoreError) : GattResult
}

/**
 * Serial GATT operation queue for one connection (plan §4.9, ADR-006, Appendix B rules 2, 4, 5).
 *
 * - Exactly one operation is in flight; the next starts only after the current one completes,
 *   times out, or the queue is failed.
 * - Every operation has a timeout and every caller is answered exactly once.
 * - Cancelling a queued operation removes it. Cancelling the running one answers the caller at once,
 *   but the queue stays busy until the radio answers or the timeout fires, because the platform
 *   operation can't be aborted.
 * - A completion arriving after its operation timed out is ignored.
 *
 * Not thread-safe: call it only on the BLE thread, the one [executor] runs on.
 */
class GattQueue(private val executor: SerialExecutor, private val defaultTimeoutMs: Long = DEFAULT_TIMEOUT_MS) {
  private val pending = ArrayDeque<GattOperation>()
  private var nextId = 1L
  private var pumpScheduled = false

  var current: GattOperation? = null
    private set

  /** Timeouts in a row, reset by any completion. Two in a row force a disconnect (plan §4.9). */
  var consecutiveTimeouts = 0
    private set

  var onTimeout: ((operation: GattOperation, consecutiveTimeouts: Int) -> Unit)? = null

  /** Queued plus in-flight operations. */
  val depth: Int get() = pending.size + (if (current == null) 0 else 1)

  /**
   * Queues an operation. [start] issues the platform call when its turn comes; the result is
   * reported later through [complete].
   */
  fun enqueue(
    kind: GattOperation.Kind,
    target: String? = null,
    timeoutMs: Long? = null,
    start: () -> Unit,
    completion: (GattResult) -> Unit,
  ): GattOperation {
    val operation = GattOperation(nextId++, kind, target, timeoutMs ?: defaultTimeoutMs, start, completion)
    pending.addLast(operation)
    schedulePump()
    return operation
  }

  /** Completes the in-flight operation if it matches. Returns false for late or foreign callbacks. */
  fun complete(result: GattResult, matches: (GattOperation) -> Boolean): Boolean {
    val operation = current ?: return false
    if (!matches(operation)) return false
    finishCurrent()
    consecutiveTimeouts = 0
    operation.settle(result)
    return true
  }

  /** Answers the caller with OPERATION_CANCELLED (plan §4.9). */
  fun cancel(operation: GattOperation) {
    pending.remove(operation)
    operation.settle(
      GattResult.Failure(CoreError(CoreError.Code.OPERATION_CANCELLED, "Operation ${operation.kind} was cancelled")),
    )
  }

  /** Fails the running and all queued operations, for example on disconnection (rule 5). */
  fun failAll(error: CoreError) {
    val operations = listOfNotNull(current) + pending
    current?.timer?.cancel()
    current = null
    pending.clear()
    operations.forEach { it.settle(GattResult.Failure(error)) }
  }

  private fun schedulePump() {
    if (pumpScheduled) return
    pumpScheduled = true
    // Always asynchronous: an operation can complete inside `start`, and the next one must not start
    // re-entrantly from inside that callback.
    executor.execute {
      pumpScheduled = false
      pump()
    }
  }

  private fun pump() {
    if (current != null) return
    val operation = pending.removeFirstOrNull() ?: return
    current = operation
    operation.timer = executor.executeDelayed(operation.timeoutMs) { timeOut(operation) }
    operation.start()
  }

  private fun finishCurrent() {
    current?.timer?.cancel()
    current = null
    schedulePump()
  }

  private fun timeOut(operation: GattOperation) {
    if (current !== operation) return
    finishCurrent()
    consecutiveTimeouts++
    val message = "Operation ${operation.kind} timed out after ${operation.timeoutMs} ms"
    operation.settle(GattResult.Failure(CoreError(CoreError.Code.OPERATION_TIMEOUT, message)))
    onTimeout?.invoke(operation, consecutiveTimeouts)
  }

  companion object {
    const val DEFAULT_TIMEOUT_MS = 10_000L
  }
}
