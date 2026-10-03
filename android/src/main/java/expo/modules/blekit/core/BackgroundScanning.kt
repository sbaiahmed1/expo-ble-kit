package expo.modules.blekit.core

/**
 * Background scans (plan §4.4, §4.14, P3-04): a PendingIntent scan that the Bluetooth stack keeps
 * running when the app process is gone, delivering to a TaskManager task. The pure rules live here;
 * [AndroidBackgroundScanner] talks to Android, and the binding's task consumer to TaskManager.
 */
object BackgroundScanning {
  /** Results batched by the controller for this long when it can't filter by itself. */
  const val BATCH_DELAY_MS = 10_000L

  /** `ScanSettings.CALLBACK_TYPE_FIRST_MATCH`. */
  private const val FIRST_MATCH = 2

  /**
   * Low power, and as few wakes as the controller allows: one per device appearance where it
   * filters in hardware (first match), else results batched every 10 s where it batches, else
   * every match.
   */
  fun settings(offloadedFiltering: Boolean, offloadedBatching: Boolean): ScanSettingsSpec = ScanSettingsSpec(
    scanMode = ScanModes.LOW_POWER,
    callbackType = if (offloadedFiltering) FIRST_MATCH else PlatformScan.ALL_MATCHES,
    reportDelayMs = if (!offloadedFiltering && offloadedBatching) BATCH_DELAY_MS else 0,
  )

  /**
   * What registering a background scan needs (plan §4.13): the `backgroundScan` declarations and
   * permissions (Android 10–11 add `ACCESS_BACKGROUND_LOCATION`), and an adapter that is on.
   * Throws MISCONFIGURED, PERMISSION_DENIED or the adapter's error.
   */
  fun check(policy: BlePermissionPolicy, isGranted: (String) -> Boolean, adapterError: CoreError?) {
    policy.checkDeclared(listOf(BleCapability.BACKGROUND_SCAN))
    val missing = policy.runtimePermissions(BleCapability.BACKGROUND_SCAN).filterNot(isGranted)
    if (missing.isNotEmpty()) {
      throw CoreError(
        CoreError.Code.PERMISSION_DENIED,
        "Background scanning needs ${missing.joinToString()}. Call " +
          "requestPermissionsAsync({ backgroundScan: true }) first.",
      )
    }
    adapterError?.let { throw it }
  }

  /** The task's scan options as TaskManager persists them (JSON: numbers may come back as Double). */
  fun spec(options: Map<String, Any?>): ScanSpec {
    @Suppress("UNCHECKED_CAST")
    val scan = options["scan"] as? Map<String, Any?> ?: emptyMap()
    val services = (scan["services"] as? List<*>).orEmpty().map { java.util.UUID.fromString(it as String) }
    val manufacturerData = (scan["manufacturerData"] as? List<*>).orEmpty().map { entry ->
      val filter = entry as Map<*, *>
      ManufacturerFilter(
        (filter["companyId"] as Number).toInt(),
        (filter["data"] as? List<*>)?.toBytes(),
        (filter["mask"] as? List<*>)?.toBytes(),
      )
    }
    return ScanSpec(
      services = services,
      namePrefix = scan["namePrefix"] as? String,
      manufacturerData = manufacturerData,
    )
  }

  private fun List<*>.toBytes(): ByteArray = ByteArray(size) { (this[it] as Number).toInt().toByte() }
}
