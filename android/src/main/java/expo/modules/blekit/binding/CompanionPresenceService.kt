package expo.modules.blekit.binding

import android.annotation.TargetApi
import android.companion.AssociationInfo
import android.companion.CompanionDeviceService
import android.companion.DevicePresenceEvent
import android.content.Context
import android.content.Intent
import expo.modules.blekit.core.AndroidCompanion
import expo.modules.blekit.core.BleLogger
import expo.modules.blekit.core.LogLevel
import expo.modules.blekit.core.PresenceTracker
import expo.modules.blekit.core.normalizeAddress

/**
 * Android binds this service when an observed companion device comes into range and unbinds it when
 * the device leaves (P5-05), starting the app's process if needed. Each change goes to TaskManager
 * as a broadcast, which hands it to the consumers of `devicePresence` tasks
 * ([BackgroundScanTaskConsumer]); TaskManager then runs the JS task, headless when the app isn't
 * open. Declared in the app's manifest by the config plugin's `android.companionDevice`, with
 * `BIND_COMPANION_DEVICE_SERVICE`.
 *
 * Android calls one of the overloads per change: by address on Android 12, with the association
 * from 13, as a presence event from 16 for observations by association id. [tracker] drops repeats.
 */
@TargetApi(31)
class CompanionPresenceService : CompanionDeviceService() {
  @Deprecated("Android 13 added the AssociationInfo overload")
  override fun onDeviceAppeared(address: String) = report(this, address, true)

  @Deprecated("Android 13 added the AssociationInfo overload")
  override fun onDeviceDisappeared(address: String) = report(this, address, false)

  @TargetApi(33)
  @Deprecated("Android 16 added onDevicePresenceEvent")
  override fun onDeviceAppeared(info: AssociationInfo) {
    info.deviceMacAddress?.let { report(this, it.toString(), true) }
  }

  @TargetApi(33)
  @Deprecated("Android 16 added onDevicePresenceEvent")
  override fun onDeviceDisappeared(info: AssociationInfo) {
    info.deviceMacAddress?.let { report(this, it.toString(), false) }
  }

  @TargetApi(36)
  override fun onDevicePresenceEvent(event: DevicePresenceEvent) {
    val present = when (event.event) {
      DevicePresenceEvent.EVENT_BLE_APPEARED, DevicePresenceEvent.EVENT_BT_CONNECTED -> true
      DevicePresenceEvent.EVENT_BLE_DISAPPEARED, DevicePresenceEvent.EVENT_BT_DISCONNECTED -> false
      else -> return
    }
    val association = AndroidCompanion(this).associations().find { it.id == event.associationId } ?: return
    report(this, association.address, present)
  }

  companion object {
    /** The custom broadcast TaskManager hands to consumers ([BackgroundScanTaskConsumer.canReceiveCustomBroadcast]). */
    const val ACTION = "expo.modules.blekit.DEVICE_PRESENCE"
    const val EXTRA_ADDRESS = "expo.modules.blekit.address"
    const val EXTRA_PRESENT = "expo.modules.blekit.present"

    /** expo-task-manager's receiver, in the app's manifest when it is installed (not exported: explicit only). */
    private const val TASK_RECEIVER = "expo.modules.taskManager.TaskBroadcastReceiver"

    private val tracker = PresenceTracker()

    private fun report(context: Context, address: String, present: Boolean) {
      val id = normalizeAddress(address) ?: return
      if (!tracker.update(id, present)) return
      BleLogger.logcat(LogLevel.INFO, "companion device $id ${if (present) "appeared" else "disappeared"}")
      context.sendBroadcast(
        Intent(ACTION)
          .setClassName(context, TASK_RECEIVER)
          .putExtra(EXTRA_ADDRESS, id)
          .putExtra(EXTRA_PRESENT, present),
      )
    }
  }
}

/**
 * The tasks that receive `devicePresence`, by name, kept across processes: presence observation is
 * on while there is one, and a new association is observed at once.
 */
internal object PresenceTasks {
  private const val PREFERENCES = "expo-ble-kit.presence-tasks"
  private const val KEY = "tasks"

  /** Whether [taskName] is new. */
  fun add(context: Context, taskName: String): Boolean = update(context) { it.add(taskName) }

  /** Whether [taskName] was there. */
  fun remove(context: Context, taskName: String): Boolean = update(context) { it.remove(taskName) }

  fun any(context: Context): Boolean = names(context).isNotEmpty()

  private fun names(context: Context): Set<String> =
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getStringSet(KEY, null).orEmpty()

  @Synchronized
  private fun update(context: Context, change: (MutableSet<String>) -> Boolean): Boolean {
    val names = names(context).toMutableSet()
    val changed = change(names)
    if (changed) context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putStringSet(KEY, names).apply()
    return changed
  }
}
