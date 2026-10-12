package expo.modules.blekit.core

import java.util.UUID
import java.util.regex.Pattern
import java.util.regex.PatternSyntaxException

/** JS `CompanionDeviceFilter` (plan §5.2), checked: devices with any of [services], named to match [namePattern]. */
data class CompanionFilterSpec(val services: List<UUID>, val namePattern: Pattern?, val singleDevice: Boolean)

/**
 * CompanionDeviceManager (plan §4.4 `Companion`, P5-05): the pure rules. [AndroidCompanion] talks to
 * Android; the binding's presence service and task consumer deliver presence to TaskManager.
 *
 * API levels, read in the platform jars 26 to 37: association since 26, its result as
 * `AssociationInfo` since 33; presence observation by address since 31 (`CompanionDeviceService`
 * with `onDeviceAppeared(String)`), with `AssociationInfo` callbacks since 33, and by association
 * id (`ObservingDevicePresenceRequest`, `onDevicePresenceEvent`) since 36.
 */
object CompanionDevices {
  /** `startObservingDevicePresence` and `CompanionDeviceService`. */
  const val PRESENCE_API = 31

  /** The background event (plan §5.3). */
  const val PRESENCE_EVENT = "devicePresence"
  const val SCAN_EVENT = "scanResults"

  /** The permission presence observation needs (a normal one, granted at install). */
  const val OBSERVE_PRESENCE_PERMISSION = "android.permission.REQUEST_OBSERVE_COMPANION_DEVICE_PRESENCE"

  /** CompanionDeviceManager refuses apps whose manifest doesn't declare this feature. */
  const val FEATURE = "android.software.companion_device_setup"

  /** `CompanionDeviceManager.RESULT_*` (API 36), the codes of `Callback.onFailure(int, CharSequence)`. */
  const val RESULT_CANCELED = 0
  const val RESULT_USER_REJECTED = 1
  const val RESULT_DISCOVERY_TIMEOUT = 2
  const val RESULT_INTERNAL_ERROR = 3
  const val RESULT_SECURITY_ERROR = 4

  /** Throws INVALID_ARGUMENT for a service that isn't a UUID or a pattern Java can't compile. */
  fun spec(services: List<String>, namePattern: String?, singleDevice: Boolean): CompanionFilterSpec {
    val uuids = services.map { service ->
      try {
        UUID.fromString(service)
      } catch (_: IllegalArgumentException) {
        throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Invalid companion device service: $service")
      }
    }
    val pattern = namePattern?.let {
      try {
        Pattern.compile(it)
      } catch (error: PatternSyntaxException) {
        throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Invalid companion device name pattern: ${error.description}")
      }
    }
    return CompanionFilterSpec(uuids, pattern, singleDevice)
  }

  /**
   * What a failed association means for JS: null (resolve with no device) when the person closed
   * the picker or nothing turned up, else the error. Android 16 gives a code; older versions only
   * a message, which can't be told apart reliably, so those resolve null too.
   */
  fun failure(code: Int?, message: String?): CoreError? = when (code) {
    null, RESULT_CANCELED, RESULT_USER_REJECTED, RESULT_DISCOVERY_TIMEOUT -> null

    RESULT_SECURITY_ERROR ->
      CoreError(CoreError.Code.MISCONFIGURED, "Android refused the association: ${message ?: "security error"}")

    else -> CoreError(CoreError.Code.INTERNAL, "The association failed: ${message ?: "error $code"}")
  }

  /** The background events a task asked for, as TaskManager persists its options. */
  fun events(options: Map<String, Any?>): Set<String> =
    (options["events"] as? List<*>).orEmpty().map { it.toString() }.toSet()

  /**
   * What presence observation lacks on an API level: the permission and the service the config
   * plugin's `android.companionDevice` declares. Throws NOT_SUPPORTED before Android 12, and
   * MISCONFIGURED naming the missing entries.
   */
  fun checkPresence(sdkInt: Int, hasFeature: Boolean, declared: Set<String>, serviceDeclared: Boolean) {
    if (sdkInt < PRESENCE_API) {
      throw CoreError(
        CoreError.Code.NOT_SUPPORTED,
        "Companion device presence needs Android 12 (API 31); this is API $sdkInt",
      )
    }
    if (!hasFeature) {
      throw CoreError(CoreError.Code.NOT_SUPPORTED, "This device has no companion device manager")
    }
    val missing = listOfNotNull(
      OBSERVE_PRESENCE_PERMISSION.takeUnless { it in declared },
      "the presence service".takeUnless { serviceDeclared },
    )
    if (missing.isNotEmpty()) throw misconfigured(missing)
  }

  fun misconfigured(missing: List<String>) = CoreError(
    CoreError.Code.MISCONFIGURED,
    "AndroidManifest.xml doesn't declare ${missing.joinToString()}, which companion devices need. Set " +
      "android.companionDevice in the expo-ble-kit config plugin options (${CoreError.SETUP_GUIDE}).",
  )
}

/** The last presence of each device in this process, so each change is reported once. Thread-safe. */
class PresenceTracker {
  private val present = HashMap<String, Boolean>()

  /** Whether [isPresent] changes what is known of [address]. */
  @Synchronized
  fun update(address: String, isPresent: Boolean): Boolean = present.put(address, isPresent) != isPresent
}

/**
 * One association request through the system picker, to its end: [finish] settles it once,
 * whichever of Android's callbacks and the picker's activity result comes first. Main thread.
 */
class CompanionAssociation(private val onResult: (Result<String?>) -> Unit) {
  var finished = false
    private set

  /** Whether the picker was launched; Android may report the device found more than once. */
  var launched = false

  /** [address] is the associated device's (normalized), or null when nothing was associated. */
  fun finish(address: String?) = settle(Result.success(address?.let(::normalizeAddress)))

  fun fail(error: CoreError) = settle(Result.failure(error))

  private fun settle(result: Result<String?>) {
    if (finished) return
    finished = true
    onResult(result)
  }
}
