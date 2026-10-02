package expo.modules.blekit.core

import java.util.UUID

/** A manufacturer-data filter of JS `ScanOptions` (plan §5.3). */
class ManufacturerFilter(val companyId: Int, val data: ByteArray? = null, val mask: ByteArray? = null) {
  /** [value] starts with [data], comparing only the bits set in [mask]. */
  fun matches(value: ByteArray): Boolean {
    val expected = data ?: return true
    if (value.size < expected.size) {
      return false
    }
    return expected.indices.all { i ->
      val bits = mask?.getOrNull(i)?.toInt() ?: 0xFF
      (value[i].toInt() and bits) == (expected[i].toInt() and bits)
    }
  }
}

/** JS `ScanOptions` after the TS layer validated it and normalized its UUIDs (plan §5.3). */
class ScanSpec(
  val services: List<UUID> = emptyList(),
  val allowDuplicates: Boolean = false,
  val reportIntervalMs: Long = 0,
  val namePrefix: String? = null,
  val manufacturerData: List<ManufacturerFilter> = emptyList(),
  val settings: ScanSettingsSpec = ScanSettingsSpec(),
) {
  /** Every given criterion must match; within a list, any entry may. */
  fun matches(record: ScanRecordData): Boolean = (services.isEmpty() || record.serviceUuids.any { it in services }) &&
    (namePrefix == null || record.name?.startsWith(namePrefix) == true) &&
    (
      manufacturerData.isEmpty() ||
        manufacturerData.any { filter -> record.manufacturerData[filter.companyId]?.let(filter::matches) == true }
      )

  /**
   * Hardware filters that select a superset of this session's matches. Empty means an unfiltered
   * scan: Android can't filter by name prefix, so such a session is filtered in the core only.
   */
  fun platformFilters(): List<ScanFilterSpec> {
    if (services.isEmpty() && manufacturerData.isEmpty()) {
      return emptyList()
    }
    val serviceOptions: List<UUID?> = services.ifEmpty { listOf(null) }
    val manufacturerOptions: List<ManufacturerFilter?> = manufacturerData.ifEmpty { listOf(null) }
    return serviceOptions.flatMap { service ->
      manufacturerOptions.map { manufacturer ->
        ScanFilterSpec(
          serviceUuid = service,
          manufacturerId = manufacturer?.companyId,
          manufacturerData = manufacturer?.data,
          manufacturerDataMask = manufacturer?.data?.let { manufacturer.mask },
        )
      }
    }
  }
}

/** The one platform scan that serves every session (plan §5.3). Compared by content. */
class PlatformScan(val filters: List<ScanFilterSpec>, val settings: ScanSettingsSpec) {
  private val key = filters.map(::filterKey).sorted().joinToString("|") + "/" + settings

  override fun equals(other: Any?): Boolean = other is PlatformScan && other.key == key

  override fun hashCode(): Int = key.hashCode()

  override fun toString(): String = key

  companion object {
    /** `ScanSettings.CALLBACK_TYPE_ALL_MATCHES` and `ScanSettings.PHY_LE_ALL_SUPPORTED`. */
    const val ALL_MATCHES = 1
    const val PHY_ALL = 255

    /**
     * The union of the sessions' filters (unfiltered if any session is), and for settings that
     * can't be merged, the most demanding value (plan §5.3).
     */
    fun union(specs: Collection<ScanSpec>): PlatformScan {
      val perSession = specs.map { it.platformFilters() }
      val filters =
        if (perSession.any { it.isEmpty() }) emptyList() else perSession.flatten().distinctBy(::filterKey)
      val all = specs.map { it.settings }
      val settings = ScanSettingsSpec(
        // OPPORTUNISTIC < LOW_POWER < BALANCED < LOW_LATENCY.
        scanMode = all.maxOf { it.scanMode },
        callbackType = all.map { it.callbackType }.distinct().singleOrNull() ?: ALL_MATCHES,
        // MATCH_MODE_AGGRESSIVE (1) reports more than MATCH_MODE_STICKY (2).
        matchMode = all.minOf { it.matchMode },
        legacy = all.all { it.legacy },
        phy = all.map { it.phy }.distinct().singleOrNull() ?: PHY_ALL,
        reportDelayMs = all.minOf { it.reportDelayMs },
      )
      return PlatformScan(filters, settings)
    }

    private fun filterKey(filter: ScanFilterSpec): String = listOf(
      filter.serviceUuid,
      filter.deviceName,
      filter.deviceAddress,
      filter.manufacturerId,
      filter.manufacturerData?.toHex(),
      filter.manufacturerDataMask?.toHex(),
    ).joinToString(",")
  }
}

/** JS option strings to `ScanSettings` values. Null when the value is unknown. */
object ScanOptionValues {
  fun scanMode(value: String?): Int? = when (value) {
    null, "balanced" -> ScanModes.BALANCED
    "opportunistic" -> ScanModes.OPPORTUNISTIC
    "lowPower" -> ScanModes.LOW_POWER
    "lowLatency" -> ScanModes.LOW_LATENCY
    else -> null
  }

  /** `ScanSettings.CALLBACK_TYPE_*`. */
  fun callbackType(value: String?): Int? = when (value) {
    null, "allMatches" -> 1
    "firstMatch" -> 2
    "matchLost" -> 4
    else -> null
  }

  /** `ScanSettings.MATCH_MODE_*`. */
  fun matchMode(value: String?): Int? = when (value) {
    null, "aggressive" -> 1
    "sticky" -> 2
    else -> null
  }

  /** `BluetoothDevice.PHY_LE_*` / `ScanSettings.PHY_LE_ALL_SUPPORTED`. */
  fun phy(value: String?): Int? = when (value) {
    null, "all" -> PlatformScan.PHY_ALL
    "le1m" -> 1
    "leCoded" -> 3
    else -> null
  }
}

/**
 * Epoch milliseconds from monotonic time, so timestamps are comparable with `Date.now()` and never
 * go backwards within a process (plan §4.10).
 */
class EpochClock(private val wallAtStartMs: Long, private val monotonicAtStartMs: Long) {
  fun epochMs(monotonicMs: Long): Long = wallAtStartMs + (monotonicMs - monotonicAtStartMs)
}

/**
 * The advertising and scan-response structures without Android's zero padding: everything up to
 * the first zero-length structure.
 */
fun trimAdvertisement(bytes: ByteArray): ByteArray {
  var end = 0
  while (end < bytes.size) {
    val length = bytes[end].toInt() and 0xFF
    if (length == 0) {
      break
    }
    end += length + 1
  }
  return bytes.copyOf(minOf(end, bytes.size))
}

/** JS `ScanResult` (plan §5.3). Map keys must be strings in JS, so company ids become strings. */
fun ScanRecordData.toJs(clock: EpochClock): Map<String, Any?> = mapOf(
  "id" to address,
  "name" to name,
  "rssi" to rssi,
  "txPowerLevel" to txPowerLevel,
  "isConnectable" to isConnectable,
  "serviceUUIDs" to serviceUuids.map { it.toString() },
  "serviceData" to serviceData.entries.associate { (uuid, value) -> uuid.toString() to value },
  "manufacturerData" to manufacturerData.entries.associate { (companyId, value) -> companyId.toString() to value },
  "rawAdvertisement" to rawBytes?.let(::trimAdvertisement),
  "timestamp" to clock.epochMs(timestampNanos / 1_000_000).toDouble(),
)

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
