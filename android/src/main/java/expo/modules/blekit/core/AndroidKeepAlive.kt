package expo.modules.blekit.core

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler

/**
 * Starts and stops [ConnectionService] for the engine (plan §4.14).
 *
 * The service starts with `startService` while the app is in the foreground, then promotes itself
 * with `startForeground`. Android refuses `startService` from the background right away, which
 * [start] reports; a refusal of `startForeground` arrives later through [onStopped]. Unlike
 * `startForegroundService`, a failed promotion can't crash the app for missing its deadline.
 */
class AndroidKeepAlive(
  private val context: Context,
  /** The BLE thread, where [onStopped] is delivered. */
  private val handler: Handler,
  private val permissionSystem: PermissionSystem,
) : KeepAlivePort {
  override var onStopped: ((CoreError?) -> Unit)? = null

  /** Each start and stop gets a new one, so a report from an older service run is ignored. */
  private var generation = 0
  private var running = false

  init {
    reporter = { reported, error ->
      handler.post {
        if (reported == generation && running) {
          running = false
          onStopped?.invoke(error)
        }
      }
    }
  }

  override fun missingDeclaration(): String? {
    val service =
      try {
        val component = ComponentName(context, ConnectionService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          context.packageManager.getServiceInfo(component, PackageManager.ComponentInfoFlags.of(0))
        } else {
          @Suppress("DEPRECATION")
          context.packageManager.getServiceInfo(component, 0)
        }
      } catch (_: PackageManager.NameNotFoundException) {
        null
      }
    val connectedDevice =
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
        service != null &&
        (service.foregroundServiceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE) != 0
    return missingKeepAliveDeclarations(
      permissionSystem.sdkInt,
      permissionSystem.declaredPermissions().names,
      serviceDeclared = service != null,
      serviceIsConnectedDevice = connectedDevice,
    )
  }

  override fun start(notification: KeepAliveNotification) {
    Companion.notification = notification
    val intent = Intent(
      context,
      ConnectionService::class.java,
    ).putExtra(ConnectionService.EXTRA_GENERATION, ++generation)
    try {
      context.startService(intent)
      running = true
    } catch (error: IllegalStateException) {
      // BackgroundServiceStartNotAllowedException on Android 12+.
      throw CoreError(
        CoreError.Code.FOREGROUND_SERVICE_FAILED,
        "Android didn't let the foreground service start because the app is in the background, so the " +
          "connection isn't kept alive. Connect with keepAliveInBackground while the app is in the foreground.",
      )
    }
  }

  override fun update(notification: KeepAliveNotification) {
    Companion.notification = notification
    if (running) {
      context
        .getSystemService(NotificationManager::class.java)
        .notify(ConnectionService.NOTIFICATION_ID, ConnectionService.build(context, notification))
    }
  }

  override fun stop() {
    generation++
    running = false
    context.stopService(Intent(context, ConnectionService::class.java))
  }

  companion object {
    /** What the service shows; set before it starts. */
    @Volatile
    var notification = KeepAliveNotification()
      private set

    @Volatile
    private var reporter: ((Int, CoreError?) -> Unit)? = null

    /** From [ConnectionService], on the main thread: the run [generation] stopped, with [error] if refused. */
    fun report(generation: Int, error: CoreError?) {
      reporter?.invoke(generation, error)
    }
  }
}
