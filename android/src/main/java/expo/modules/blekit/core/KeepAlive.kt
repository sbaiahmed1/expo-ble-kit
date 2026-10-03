package expo.modules.blekit.core

/** What the keep-alive notification shows (JS `ForegroundServiceNotification`); null fields get defaults. */
data class KeepAliveNotification(
  /** Default: the app's name. */
  val title: String? = null,
  val text: String? = null,
  /** The notification channel's name in the system settings. */
  val channelName: String? = null,
  /** A drawable resource of the app; default: the app icon. */
  val smallIcon: String? = null,
)

/**
 * Android's foreground service of type `connectedDevice` (plan §4.4, §4.14), which keeps the app
 * process running while a `keepAliveInBackground` session is open. Real implementation:
 * [AndroidKeepAlive]. Called on the BLE thread.
 */
interface KeepAlivePort {
  /** What the app's manifest lacks for the service (plugin option `android.foregroundService`), or null. */
  fun missingDeclaration(): String?

  /**
   * Starts the service. Throws a [CoreError] with FOREGROUND_SERVICE_FAILED when Android refuses
   * right away (the app is in the background). A later refusal arrives through [onStopped].
   */
  fun start(notification: KeepAliveNotification)

  /** Shows [notification] on the running service. */
  fun update(notification: KeepAliveNotification)

  fun stop()

  /**
   * The service stopped without [stop]: an error when Android refused to put it in the foreground,
   * null when the system stopped it. Delivered on the BLE thread.
   */
  var onStopped: ((CoreError?) -> Unit)?
}

/**
 * What the keep-alive service needs in the app's manifest on [sdkInt], given what is declared: the
 * service with type `connectedDevice` (API 29+ checks the type), `FOREGROUND_SERVICE` (API 28+) and
 * `FOREGROUND_SERVICE_CONNECTED_DEVICE` (API 34+). Null when nothing is missing.
 */
fun missingKeepAliveDeclarations(
  sdkInt: Int,
  declaredPermissions: Set<String>,
  serviceDeclared: Boolean,
  serviceIsConnectedDevice: Boolean,
): String? {
  val missing = buildList {
    if (!serviceDeclared) {
      add("the ConnectionService")
    } else if (sdkInt >= 29 && !serviceIsConnectedDevice) {
      add("foregroundServiceType=\"connectedDevice\" on the ConnectionService")
    }
    if (sdkInt >= 28 && KeepAlivePermissions.FOREGROUND_SERVICE !in declaredPermissions) {
      add(KeepAlivePermissions.FOREGROUND_SERVICE)
    }
    if (sdkInt >= 34 && KeepAlivePermissions.FOREGROUND_SERVICE_CONNECTED_DEVICE !in declaredPermissions) {
      add(KeepAlivePermissions.FOREGROUND_SERVICE_CONNECTED_DEVICE)
    }
  }
  return if (missing.isEmpty()) null else "the manifest lacks ${missing.joinToString()}"
}

object KeepAlivePermissions {
  const val FOREGROUND_SERVICE = "android.permission.FOREGROUND_SERVICE"
  const val FOREGROUND_SERVICE_CONNECTED_DEVICE = "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE"
}

/** No foreground service: JVM tests and platforms without one. */
object NoKeepAlive : KeepAlivePort {
  override fun missingDeclaration() = "No foreground service on this platform"

  override fun start(notification: KeepAliveNotification) = Unit

  override fun update(notification: KeepAliveNotification) = Unit

  override fun stop() = Unit

  override var onStopped: ((CoreError?) -> Unit)? = null
}
