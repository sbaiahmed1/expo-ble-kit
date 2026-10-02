package expo.modules.blekit.core.fakes

import expo.modules.blekit.core.Cancellable
import expo.modules.blekit.core.SerialExecutor

/**
 * [SerialExecutor] with virtual time. Nothing runs until the test calls [runUntilIdle] or
 * [advanceBy]; tasks run in time order, then in submission order.
 */
class ManualExecutor : SerialExecutor {
  private class Task(val id: Long, val timeMs: Long, val block: () -> Unit) {
    var cancelled = false
  }

  private val tasks = mutableListOf<Task>()
  private var nextId = 0L
  private var running = false
  private var currentMs = 0L

  val pendingCount: Int get() = tasks.count { !it.cancelled }

  override fun execute(block: () -> Unit) {
    add(currentMs, block)
  }

  override fun executeDelayed(delayMs: Long, block: () -> Unit): Cancellable {
    val task = add(currentMs + maxOf(0L, delayMs), block)
    return Cancellable { task.cancelled = true }
  }

  override fun nowMs(): Long = currentMs

  override fun isOnExecutorThread(): Boolean = running

  /** Runs everything due now, including work submitted while running. */
  fun runUntilIdle() = advanceBy(0)

  /** Moves virtual time forward, running due tasks in order. */
  fun advanceBy(ms: Long) {
    val target = currentMs + ms
    while (true) {
      val next =
        tasks
          .filter { !it.cancelled && it.timeMs <= target }
          .minWithOrNull(compareBy<Task>({ it.timeMs }, { it.id })) ?: break
      tasks.remove(next)
      currentMs = next.timeMs
      running = true
      try {
        next.block()
      } finally {
        running = false
      }
    }
    tasks.removeAll { it.cancelled }
    currentMs = target
  }

  private fun add(timeMs: Long, block: () -> Unit): Task = Task(nextId++, timeMs, block).also { tasks.add(it) }
}
