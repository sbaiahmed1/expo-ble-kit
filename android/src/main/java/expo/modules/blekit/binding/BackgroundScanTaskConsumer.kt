package expo.modules.blekit.binding

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import expo.modules.blekit.core.AndroidBackgroundScanner
import expo.modules.blekit.core.AndroidCompanion
import expo.modules.blekit.core.BackgroundScanning
import expo.modules.blekit.core.BleLogger
import expo.modules.blekit.core.CompanionDevices
import expo.modules.blekit.core.LogLevel
import expo.modules.interfaces.taskManager.TaskConsumer
import expo.modules.interfaces.taskManager.TaskInterface
import expo.modules.interfaces.taskManager.TaskManagerUtilsInterface

/**
 * The TaskManager consumer of `registerBackgroundTask` on Android (plan §4.14): `scanResults`
 * (P3-04) and `devicePresence` (P5-05). TaskManager creates this class by reflection from its
 * persisted name, so it keeps the name it had when it only scanned (and the consumer ProGuard rules).
 *
 * The scan's PendingIntent comes from TaskManager ([TaskManagerUtilsInterface.createTaskIntent]):
 * its `TaskBroadcastReceiver` wakes the app, restores the task and calls [didReceiveBroadcast],
 * which runs the JS task (headless when the app isn't open). Presence arrives the same way, as the
 * custom broadcast [CompanionPresenceService] sends to that receiver.
 */
class BackgroundScanTaskConsumer(context: Context, taskManagerUtils: TaskManagerUtilsInterface) :
  TaskConsumer(context, taskManagerUtils) {
  private var task: TaskInterface? = null

  override fun taskType() = "expo-ble-kit.scan"

  @Suppress("UNCHECKED_CAST")
  private val events: Set<String>
    get() = task?.let { CompanionDevices.events(it.options as Map<String, Any?>) }.orEmpty()

  /**
   * Called when JS registers the task, and when TaskManager restores it in a new process (each
   * wake). The scan outlives the process, so a restore within [RESTART_INTERVAL_MS] of the last
   * start leaves it alone: restarting on every wake would hit Android's scan-start limit.
   */
  override fun didRegister(task: TaskInterface) {
    this.task = task
    if (CompanionDevices.SCAN_EVENT in events) start(force = false)
    if (CompanionDevices.PRESENCE_EVENT in events) observePresence(force = false)
  }

  override fun didUnregister() {
    val task = task ?: return
    val context = context ?: return
    AndroidBackgroundScanner(context).stop(taskManagerUtils.createTaskIntent(context, task))
    taskManagerUtils.cancelTaskIntent(context, task.appScopeKey, task.name)
    preferences(context)?.edit()?.remove(task.name)?.apply()
    stopObservingPresence(task.name)
    this.task = null
  }

  /** Registering again with other options. */
  override fun setOptions(options: Map<String, Any>) {
    val task = task ?: return
    val context = context ?: return
    if (CompanionDevices.SCAN_EVENT in events) {
      start(force = true)
    } else {
      AndroidBackgroundScanner(context).stop(taskManagerUtils.createTaskIntent(context, task))
      preferences(context)?.edit()?.remove(task.name)?.apply()
    }
    if (CompanionDevices.PRESENCE_EVENT in events) observePresence(force = true) else stopObservingPresence(task.name)
  }

  /**
   * After a reboot (with RECEIVE_BOOT_COMPLETED) or an app update, the scan has to start again.
   * Presence comes from [CompanionPresenceService].
   */
  override fun canReceiveCustomBroadcast(action: String) = action == Intent.ACTION_BOOT_COMPLETED ||
    action == Intent.ACTION_MY_PACKAGE_REPLACED ||
    action == CompanionPresenceService.ACTION

  override fun didReceiveBroadcast(intent: Intent) {
    val task = task ?: return
    val context = context ?: return
    when (intent.action) {
      CompanionPresenceService.ACTION -> return deliverPresence(task, intent)

      Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
        if (CompanionDevices.SCAN_EVENT in events) start(force = true)
        return
      }
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

  private fun deliverPresence(task: TaskInterface, intent: Intent) {
    if (CompanionDevices.PRESENCE_EVENT !in events) return
    val address = intent.getStringExtra(CompanionPresenceService.EXTRA_ADDRESS) ?: return
    val data = Bundle().apply {
      putString("type", CompanionDevices.PRESENCE_EVENT)
      putString("peripheralId", address)
      putBoolean("present", intent.getBooleanExtra(CompanionPresenceService.EXTRA_PRESENT, false))
    }
    task.execute(data, null)
  }

  /**
   * Observes the presence of every association. Android keeps observing across restarts, so a
   * restore ([force] false) of a task already recorded leaves it alone.
   */
  private fun observePresence(force: Boolean) {
    val task = task ?: return
    val context = context ?: return
    if (!PresenceTasks.add(context, task.name) && !force) return
    val companion = AndroidCompanion(context)
    companion.associations().forEach { companion.observe(it, observe = true) }
  }

  /** Stops observing once no task wants presence. */
  private fun stopObservingPresence(taskName: String) {
    val context = context ?: return
    if (!PresenceTasks.remove(context, taskName) || PresenceTasks.any(context)) return
    val companion = AndroidCompanion(context)
    companion.associations().forEach { companion.observe(it, observe = false) }
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
