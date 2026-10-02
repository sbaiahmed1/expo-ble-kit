package expo.modules.blekit.core

/** The capabilities of JS `BlePermissionRequest` (plan §5.1). */
enum class BleCapability(val js: String) {
  SCAN("scan"),
  CONNECT("connect"),
  ADVERTISE("advertise"),
  BACKGROUND_SCAN("backgroundScan"),
  ;

  companion object {
    /** What every Bluetooth app needs; the config plugin always declares these. */
    val BASE = listOf(SCAN, CONNECT)
  }
}

/** JS `PermissionStatus` (plan §5.1). */
enum class PermissionStatus(val js: String) {
  GRANTED("granted"),
  DENIED("denied"),
  UNDETERMINED("undetermined"),
}

/** One runtime permission, as the permission manager reports it. */
data class PermissionResult(val status: PermissionStatus, val canAskAgain: Boolean)

/** JS `BlePermissions` (plan §5.1). */
data class BlePermissions(val statuses: Map<BleCapability, PermissionStatus>, val canAskAgain: Boolean) {
  fun toJs(): Map<String, Any> = statuses.entries.associate { (capability, status) -> capability.js to status.js } +
    ("canAskAgain" to canAskAgain)
}

object AndroidPermissions {
  const val BLUETOOTH = "android.permission.BLUETOOTH"
  const val BLUETOOTH_ADMIN = "android.permission.BLUETOOTH_ADMIN"
  const val ACCESS_FINE_LOCATION = "android.permission.ACCESS_FINE_LOCATION"
  const val ACCESS_BACKGROUND_LOCATION = "android.permission.ACCESS_BACKGROUND_LOCATION"
  const val BLUETOOTH_SCAN = "android.permission.BLUETOOTH_SCAN"
  const val BLUETOOTH_CONNECT = "android.permission.BLUETOOTH_CONNECT"
  const val BLUETOOTH_ADVERTISE = "android.permission.BLUETOOTH_ADVERTISE"
}

/** What the app's manifest declares, as installed on this device. */
data class DeclaredPermissions(
  /**
   * `PackageInfo.requestedPermissions`. Android leaves out entries whose `maxSdkVersion` is below
   * the device's API level, so a capped legacy permission doesn't count on newer devices.
   */
  val names: Set<String>,
  /** `BLUETOOTH_SCAN` carries `usesPermissionFlags="neverForLocation"`. */
  val scanNeverForLocation: Boolean,
)

/**
 * Which permissions each capability needs on an API level (plan §4.13), and how their states
 * combine. Pure, so every API-level rule is unit tested.
 */
class BlePermissionPolicy(private val sdkInt: Int, private val declared: DeclaredPermissions) {
  /** Runtime permissions the user grants for [capability]. Empty when install-time ones suffice. */
  fun runtimePermissions(capability: BleCapability): List<String> = when (capability) {
    BleCapability.SCAN -> scanPermissions()

    BleCapability.CONNECT -> if (sdkInt >= API_S) listOf(AndroidPermissions.BLUETOOTH_CONNECT) else emptyList()

    BleCapability.ADVERTISE -> if (sdkInt >= API_S) listOf(AndroidPermissions.BLUETOOTH_ADVERTISE) else emptyList()

    BleCapability.BACKGROUND_SCAN ->
      if (sdkInt == API_Q || sdkInt == API_R) {
        scanPermissions() + AndroidPermissions.ACCESS_BACKGROUND_LOCATION
      } else {
        scanPermissions()
      }
  }

  private fun scanPermissions(): List<String> = when {
    sdkInt < API_S -> listOf(AndroidPermissions.ACCESS_FINE_LOCATION)

    declared.scanNeverForLocation -> listOf(AndroidPermissions.BLUETOOTH_SCAN)

    // Without neverForLocation, Android 12+ also needs location permission to scan.
    else -> listOf(AndroidPermissions.BLUETOOTH_SCAN, AndroidPermissions.ACCESS_FINE_LOCATION)
  }

  /** Manifest entries [capability] needs: its runtime permissions plus the install-time ones. */
  fun requiredDeclarations(capability: BleCapability): List<String> {
    val installTime = when {
      sdkInt >= API_S -> emptyList()
      capability == BleCapability.CONNECT -> listOf(AndroidPermissions.BLUETOOTH)
      else -> listOf(AndroidPermissions.BLUETOOTH, AndroidPermissions.BLUETOOTH_ADMIN)
    }
    return installTime + runtimePermissions(capability)
  }

  fun missingDeclarations(capabilities: Collection<BleCapability>): List<String> =
    capabilities.flatMap(::requiredDeclarations).distinct().filter { it !in declared.names }

  fun isDeclared(capability: BleCapability): Boolean = missingDeclarations(listOf(capability)).isEmpty()

  /** Throws MISCONFIGURED naming every missing manifest entry (plan §4.15). */
  fun checkDeclared(capabilities: Collection<BleCapability>) {
    val missing = missingDeclarations(capabilities)
    if (missing.isNotEmpty()) {
      throw CoreError(
        CoreError.Code.MISCONFIGURED,
        "AndroidManifest.xml doesn't declare ${missing.joinToString()}, which Bluetooth needs on this device " +
          "(API $sdkInt). Add the expo-ble-kit config plugin to your app config, or add the entries by hand " +
          "(${CoreError.SETUP_GUIDE}).",
      )
    }
  }

  /** Every runtime permission of the declared capabilities: what the status read covers. */
  fun declaredRuntimePermissions(): List<String> =
    BleCapability.entries.filter(::isDeclared).flatMap(::runtimePermissions).distinct()

  /**
   * The runtime permissions to request, in stages. Background location comes last and alone:
   * Android 11 ignores it when asked together with foreground location, and it may only be asked
   * once foreground location is granted.
   */
  fun requestStages(capabilities: Collection<BleCapability>): List<List<String>> {
    val (background, foreground) = capabilities.flatMap(::runtimePermissions).distinct()
      .partition { it == AndroidPermissions.ACCESS_BACKGROUND_LOCATION }
    return listOf(foreground, background).filter { it.isNotEmpty() }
  }

  /**
   * Combines per-permission [results] into JS `BlePermissions`. A capability the manifest doesn't
   * declare reads `denied` (requesting it rejects with MISCONFIGURED) and doesn't affect
   * `canAskAgain`.
   */
  fun permissions(results: Map<String, PermissionResult>): BlePermissions {
    val statuses = BleCapability.entries.associateWith { capability ->
      if (isDeclared(capability)) {
        combine(runtimePermissions(capability).map { results[it] ?: UNDETERMINED_RESULT })
      } else {
        PermissionStatus.DENIED
      }
    }
    val canAskAgain = declaredRuntimePermissions()
      .map { results[it] ?: UNDETERMINED_RESULT }
      .filter { it.status != PermissionStatus.GRANTED }
      .all { it.canAskAgain }
    return BlePermissions(statuses, canAskAgain)
  }

  /** Android 12+ needs `BLUETOOTH_CONNECT` to use the adapter at all (plan §4.8). */
  fun isAuthorized(isGranted: (String) -> Boolean): Boolean = sdkInt < API_S ||
    (AndroidPermissions.BLUETOOTH_CONNECT in declared.names && isGranted(AndroidPermissions.BLUETOOTH_CONNECT))

  companion object {
    const val API_Q = 29
    const val API_R = 30
    const val API_S = 31
    private val UNDETERMINED_RESULT = PermissionResult(PermissionStatus.UNDETERMINED, canAskAgain = true)

    fun combine(results: List<PermissionResult>): PermissionStatus = when {
      results.all { it.status == PermissionStatus.GRANTED } -> PermissionStatus.GRANTED
      results.any { it.status == PermissionStatus.DENIED } -> PermissionStatus.DENIED
      else -> PermissionStatus.UNDETERMINED
    }
  }
}
