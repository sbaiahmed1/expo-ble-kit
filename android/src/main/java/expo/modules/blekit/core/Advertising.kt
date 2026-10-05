package expo.modules.blekit.core

import java.util.UUID

// The peripheral role's advertising (plan §5.5, P4-03): what JS asks for, where each field goes in
// a legacy or extended advertisement, and the port over BluetoothLeAdvertiser for JVM tests.

class ManufacturerSpec(val companyId: Int, val data: ByteArray)

class ServiceDataSpec(val uuid: UUID, val data: ByteArray)

/** JS `AdvertisingData` and `AdvertisingOptions`, validated and defaulted by the TS layer. */
class AdvertisingSpec(
  val localName: String?,
  val serviceUuids: List<UUID>,
  val manufacturerData: ManufacturerSpec?,
  val serviceData: List<ServiceDataSpec>,
  val includeTxPower: Boolean,
  val connectable: Boolean,
  val mode: AdvertisingMode,
  val txPower: AdvertisingTxPower,
  val extended: Boolean,
  val timeoutMs: Int?,
)

/** The interval in 0.625 ms units: `AdvertisingSetParameters.INTERVAL_HIGH`, `_MEDIUM`, `_LOW`. */
enum class AdvertisingMode(val js: String, val interval: Int) {
  LOW_POWER("lowPower", 1600),
  BALANCED("balanced", 400),
  LOW_LATENCY("lowLatency", 160),
  ;

  companion object {
    fun of(js: String): AdvertisingMode? = entries.firstOrNull { it.js == js }
  }
}

/** `AdvertisingSetParameters.TX_POWER_*`, in dBm. */
enum class AdvertisingTxPower(val js: String, val dbm: Int) {
  ULTRA_LOW("ultraLow", -21),
  LOW("low", -15),
  MEDIUM("medium", -7),
  HIGH("high", 1),
  ;

  companion object {
    fun of(js: String): AdvertisingTxPower? = entries.firstOrNull { it.js == js }
  }
}

/** The fields of the advertising data or of the scan response. */
class AdvertisingPayload(
  val serviceUuids: List<UUID>,
  val manufacturerData: ManufacturerSpec?,
  val serviceData: List<ServiceDataSpec>,
  val includeTxPower: Boolean,
  val includeName: Boolean,
) {
  val isEmpty: Boolean
    get() = serviceUuids.isEmpty() && manufacturerData == null && serviceData.isEmpty() && !includeTxPower &&
      !includeName
}

/** Where each field goes. A null [scanResponse] means the advertisement isn't scannable. */
class AdvertisingLayout(
  val advertising: AdvertisingPayload,
  val scanResponse: AdvertisingPayload?,
  val legacy: Boolean,
  val connectable: Boolean,
  /** Fields dropped, for a warning. */
  val warnings: List<String>,
)

object AdvertisingLayouts {
  /** Legacy advertising data and scan response, each (Core spec Vol 6 Part B 2.3.1). */
  const val LEGACY_MAX = 31

  /** Flags, which Android adds to connectable, discoverable advertising data. */
  const val FLAGS = 3

  /** Length and type bytes of each field. */
  private const val FIELD_OVERHEAD = 2

  private const val BASE_LSB = -0x7fffff7fa064cb05L // 0x800000805F9B34FB
  private const val BASE_MSB = 0x1000L

  /** 2, 4 or 16: how Android writes [uuid] in advertising data (`BluetoothUuid`). */
  fun uuidLength(uuid: UUID): Int = when {
    uuid.leastSignificantBits != BASE_LSB -> 16

    uuid.mostSignificantBits and -0xffff00000001L == BASE_MSB -> 2

    // 0xFFFF0000FFFFFFFF mask
    uuid.mostSignificantBits and 0xffffffffL == BASE_MSB -> 4

    else -> 16
  }

  /** The service UUID fields: one per UUID length, as AOSP's `totalBytes` counts them. */
  fun serviceUuidsSize(uuids: List<UUID>): Int =
    uuids.groupBy(::uuidLength).entries.sumOf { (length, group) -> FIELD_OVERHEAD + length * group.size }

  private class Field(val size: Int, val describe: String, val apply: (Builder) -> Unit)

  private class Builder(var free: Int) {
    val uuids = mutableListOf<UUID>()
    var manufacturer: ManufacturerSpec? = null
    val serviceData = mutableListOf<ServiceDataSpec>()
    var txPower = false
    var name = false

    fun take(field: Field): Boolean {
      if (field.size > free) return false
      free -= field.size
      field.apply(this)
      return true
    }

    fun build() = AdvertisingPayload(uuids.toList(), manufacturer, serviceData.toList(), txPower, name)
  }

  /**
   * Places the fields (plan §5.5). Service UUIDs come first, then manufacturer data, service data
   * and the TX power level: each goes in the advertising data while it fits, else in the scan
   * response. The scan response starts with the name. Extended advertising puts everything in the
   * advertising data and isn't scannable (Android can't make it connectable and scannable).
   *
   * @param nameLength UTF-8 bytes of the phone's Bluetooth name; null when it can't be read, which
   *   keeps the scan response for the name.
   * @param maxExtended `BluetoothAdapter.getLeMaximumAdvertisingDataLength()`.
   * @throws CoreError ADVERTISING_FAILED when a field doesn't fit.
   */
  fun plan(spec: AdvertisingSpec, nameLength: Int?, maxExtended: Int): AdvertisingLayout {
    val flags = if (spec.connectable) FLAGS else 0
    val fields = buildList {
      if (spec.serviceUuids.isNotEmpty()) {
        add(Field(serviceUuidsSize(spec.serviceUuids), "serviceUUIDs") { it.uuids += spec.serviceUuids })
      }
      spec.manufacturerData?.let { data ->
        add(Field(FIELD_OVERHEAD + 2 + data.data.size, "manufacturerData") { it.manufacturer = data })
      }
      spec.serviceData.forEach { entry ->
        val size = FIELD_OVERHEAD + uuidLength(entry.uuid) + entry.data.size
        add(Field(size, "serviceData[${entry.uuid}]") { it.serviceData += entry })
      }
      if (spec.includeTxPower) add(Field(FIELD_OVERHEAD + 1, "includeTxPower") { it.txPower = true })
    }
    val name = spec.localName?.let { Field(FIELD_OVERHEAD + (nameLength ?: 0), "localName") { it.name = true } }

    if (spec.extended) {
      val advertising = Builder(maxExtended - flags)
      for (field in listOfNotNull(name) + fields) {
        if (!advertising.take(field)) throw tooLarge(field, "extended advertising takes $maxExtended bytes")
      }
      return AdvertisingLayout(advertising.build(), null, legacy = false, spec.connectable, emptyList())
    }

    val warnings = mutableListOf<String>()
    val advertising = Builder(LEGACY_MAX - flags)
    val scanResponse = Builder(LEGACY_MAX)
    if (name != null) {
      if (nameLength == null) {
        // Unknown length: the scan response is the name's alone.
        scanResponse.name = true
        scanResponse.free = 0
      } else if (!scanResponse.take(name)) {
        warnings += "the phone's Bluetooth name is too long to advertise"
      }
    }
    for (field in fields) {
      if (!advertising.take(field) && !scanResponse.take(field)) {
        throw tooLarge(
          field,
          "legacy advertising takes ${LEGACY_MAX - flags} bytes and a $LEGACY_MAX-byte scan response",
        )
      }
    }
    val response = scanResponse.build()
    // Legacy connectable advertising must be scannable (AdvertisingSetParameters.Builder.build).
    val scannable = spec.connectable || !response.isEmpty
    return AdvertisingLayout(
      advertising.build(),
      response.takeIf { scannable },
      legacy = true,
      spec.connectable,
      warnings,
    )
  }

  private fun tooLarge(field: Field, limit: String) = CoreError(
    CoreError.Code.ADVERTISING_FAILED,
    "The advertising data doesn't fit: ${field.describe} needs ${field.size} more bytes, and $limit. " +
      "Advertise less, or use android.extended",
  )

  /** `AdvertisingSetCallback` start statuses (plan Appendix A.1). */
  fun startError(status: Int): CoreError = when (status) {
    ADVERTISE_FAILED_DATA_TOO_LARGE ->
      CoreError(CoreError.Code.ADVERTISING_FAILED, "The advertising data is too large for this phone", status)

    ADVERTISE_FAILED_TOO_MANY_ADVERTISERS ->
      CoreError(
        CoreError.Code.ADVERTISING_FAILED,
        "No advertising slot is free: other apps are advertising",
        status,
        retryable = true,
      )

    ADVERTISE_FAILED_ALREADY_STARTED ->
      CoreError(CoreError.Code.ADVERTISING_FAILED, "Android says this advertisement already runs", status)

    ADVERTISE_FAILED_FEATURE_UNSUPPORTED ->
      CoreError(CoreError.Code.NOT_SUPPORTED, "This phone can't advertise this way", status)

    else -> CoreError(CoreError.Code.ADVERTISING_FAILED, "Android failed to start advertising (status $status)", status)
  }

  const val ADVERTISE_SUCCESS = 0
  const val ADVERTISE_FAILED_DATA_TOO_LARGE = 1
  const val ADVERTISE_FAILED_TOO_MANY_ADVERTISERS = 2
  const val ADVERTISE_FAILED_ALREADY_STARTED = 3
  const val ADVERTISE_FAILED_FEATURE_UNSUPPORTED = 5
}

/** What the phone can do, read when an advertisement starts. */
class AdvertiserCapabilities(
  val extended: Boolean,
  val maxExtendedLength: Int,
  /** The phone's Bluetooth name; null when it can't be read (no connect permission). */
  val deviceName: String?,
)

/** `AdvertisingSetCallback`, on the server thread. */
interface AdvertiserEvents {
  fun onStarted(status: Int)

  /** The controller turned the set off: its `timeoutMs` elapsed. */
  fun onDisabled()
}

/** The port over `BluetoothLeAdvertiser`: one advertising set at a time. */
interface AdvertiserPort {
  /** Null when the phone can't advertise (no LE advertiser, or Bluetooth off). */
  fun capabilities(): AdvertiserCapabilities?

  /** Throws `IllegalArgumentException` or `IllegalStateException` when Android refuses at once. */
  fun start(layout: AdvertisingLayout, spec: AdvertisingSpec, events: AdvertiserEvents)

  fun stop()
}
