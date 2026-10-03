package expo.modules.blekit.binding

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import expo.modules.blekit.core.AndroidBackgroundScanner
import expo.modules.blekit.core.BackgroundScanning
import expo.modules.blekit.core.BleLogger
import expo.modules.blekit.core.LogLevel
import expo.modules.interfaces.taskManager.TaskConsumer
import expo.modules.interfaces.taskManager.TaskInterface
import expo.modules.interfaces.taskManager.TaskManagerUtilsInterface

/**
 * The TaskManager consumer of `registerBackgroundTask` with `scanResults` (plan §4.14, P3-04).
 *
 * The scan's PendingIntent comes from TaskManager ([TaskManagerUtilsInterface.createTaskIntent]):
 * its `TaskBroadcastReceiver` wakes the app, restores the task and calls [didReceiveBroadcast],
 * which runs the JS task (headless when the app isn't open). TaskManager creates this class by
 * reflection from its persisted name, so it must keep its name (consumer ProGuard rules).
 */
class BackgroundScanTaskConsumer(context: Context, taskManagerUtils: TaskManagerUtilsInterface) :
  TaskConsumer(context, taskManagerUtils) {
  private var task: TaskInterface? = null

  override fun taskType() = "expo-ble-kit.scan"

  /**
   * Called when JS registers the task, and when TaskManager restores it in a new process (each
   * wake). The scan outlives the process, so a restore within [RESTART_INTERVAL_MS] of the last
   * start leaves it alone: restarting on every wake would hit Android's scan-start limit.
   */
  override fun didRegister(task: TaskInterface) {
    this.task = task
    start(force = false)
  }

  override fun didUnregister() {
    val task = task ?: return
    val context = context ?: return
    AndroidBackgroundScanner(context).stop(taskManagerUtils.createTaskIntent(context, task))
    taskManagerUtils.cancelTaskIntent(context, task.appScopeKey, task.name)
    preferences(context)?.edit()?.remove(task.name)?.apply()
    this.task = null
  }

  /** Registering again with other options. */
  override fun setOptions(options: Map<String, Any>) {
    start(force = true)
  }

  /** After a reboot (with RECEIVE_BOOT_COMPLETED) or an app update, the scan has to start again. */
  override fun canReceiveCustomBroadcast(action: String) =
    action == Intent.ACTION_BOOT_COMPLETED || action == Intent.ACTION_MY_PACKAGE_REPLACED

  override fun didReceiveBroadcast(intent: Intent) {
    val task = task ?: return
    val context = context ?: return
    if (intent.action != null && canReceiveCustomBroadcast(intent.action!!)) {
      start(force = true)
      return
    }
    val scanner = AndroidBackgroundScanner(context)
    scanner.error(intent)?.let { code ->
      task.execute(null, Error("SCAN_FAILED: Android stopped the background scan (error $code)"))
      return
    }
    @Suppress("UNCHECKED_CAST")
    val spec = BackgroundScanning.spec(task.options as Map<String, Any?>)
    val results = scanner.results(intent, spec)
    if (results.isEmpty()) return
    val data = Bundle().apply {
      putString("type", "scanResults")
      putParcelableArrayList("results", ArrayList(results.map { it.toBundle() }))
    }
    task.execute(data, null)
  }

  private fun start(force: Boolean) {
    val task = task ?: return
    val context = context ?: return
    val preferences = preferences(context)
    val now = SystemClock.elapsedRealtime()
    val last = preferences?.getLong(task.name, Long.MIN_VALUE) ?: Long.MIN_VALUE
    // elapsedRealtime restarts at boot: a "last start" in the future means before a reboot.
    if (!force && last in (now - RESTART_INTERVAL_MS)..now) return
    @Suppress("UNCHECKED_CAST")
    val spec = BackgroundScanning.spec(task.options as Map<String, Any?>)
    val target = taskManagerUtils.createTaskIntent(context, task)
    val scanner = AndroidBackgroundScanner(context)
    try {
      scanner.stop(target)
      val error = scanner.start(spec, target)
      if (error == null) {
        preferences?.edit()?.putLong(task.name, now)?.apply()
      } else {
        BleLogger.logcat(LogLevel.WARN, "background scan of task ${task.name} didn't start: error $error")
      }
    } catch (error: SecurityException) {
      BleLogger.logcat(LogLevel.WARN, "background scan of task ${task.name} needs a permission: ${error.message}")
    }
  }

  private fun preferences(context: Context) = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  companion object {
    /** Bump when the task options change incompatibly: TaskManager then drops older tasks. */
    const val VERSION = 1

    const val RESTART_INTERVAL_MS = 60_000L
    private const val PREFERENCES = "expo-ble-kit.background-scans"
  }
}

/** JS values for TaskManager's Bundle: maps become Bundles, lists ArrayLists, bytes stay ByteArrays. */
private fun Map<String, Any?>.toBundle(): Bundle = Bundle().also { bundle ->
  for ((key, value) in this) {
    @Suppress("UNCHECKED_CAST")
    when (value) {
      null -> bundle.putString(key, null)
      is String -> bundle.putString(key, value)
      is Boolean -> bundle.putBoolean(key, value)
      is Int -> bundle.putInt(key, value)
      is Double -> bundle.putDouble(key, value)
      is ByteArray -> bundle.putByteArray(key, value)
      is Map<*, *> -> bundle.putBundle(key, (value as Map<String, Any?>).toBundle())
      is List<*> -> bundle.putStringArrayList(key, ArrayList(value.map { it.toString() }))
      else -> bundle.putString(key, value.toString())
    }
  }
}
