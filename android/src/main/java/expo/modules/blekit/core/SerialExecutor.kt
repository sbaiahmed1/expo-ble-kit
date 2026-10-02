package expo.modules.blekit.core

import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock

/** Work scheduled for later that can still be cancelled. */
fun interface Cancellable {
  fun cancel()
}

/**
 * Runs work on the core's single BLE thread (plan §4.7), now or after a delay, and tells the time.
 * Abstracted so timeout logic can be tested with virtual time.
 */
interface SerialExecutor {
  fun execute(block: () -> Unit)

  fun executeDelayed(delayMs: Long, block: () -> Unit): Cancellable

  /** Monotonic time in milliseconds. */
  fun nowMs(): Long

  fun isOnExecutorThread(): Boolean
}

/** [SerialExecutor] on an Android [Handler]. GATT callbacks are delivered on the same handler. */
class HandlerExecutor(val handler: Handler) : SerialExecutor {
  override fun execute(block: () -> Unit) {
    handler.post { block() }
  }

  override fun executeDelayed(delayMs: Long, block: () -> Unit): Cancellable {
    val runnable = Runnable { block() }
    handler.postDelayed(runnable, delayMs)
    return Cancellable { handler.removeCallbacks(runnable) }
  }

  override fun nowMs(): Long = SystemClock.elapsedRealtime()

  override fun isOnExecutorThread(): Boolean = Looper.myLooper() == handler.looper

  companion object {
    /** Starts the dedicated BLE thread. */
    fun start(name: String = "blekit-gatt"): HandlerExecutor {
      val thread = HandlerThread(name).apply { start() }
      return HandlerExecutor(Handler(thread.looper))
    }
  }
}
