package expo.modules.blekit.binding

import expo.modules.blekit.core.BatchSpec
import expo.modules.blekit.core.BleCapability
import expo.modules.blekit.core.ConnectSpec
import expo.modules.blekit.core.CoreError
import expo.modules.blekit.core.ManufacturerFilter
import expo.modules.blekit.core.PeripheralSession
import expo.modules.blekit.core.ReconnectPolicy
import expo.modules.blekit.core.ScanOptionValues
import expo.modules.blekit.core.ScanSettingsSpec
import expo.modules.blekit.core.ScanSpec
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.UUID

/** JS `BlePermissionRequest` (plan §5.1). */
class PermissionRequestRecord : Record {
  @Field val scan: Boolean = false

  @Field val connect: Boolean = false

  @Field val advertise: Boolean = false

  @Field val backgroundScan: Boolean = false

  /** No flag set means the base capabilities. */
  fun capabilities(): List<BleCapability> = listOfNotNull(
    BleCapability.SCAN.takeIf { scan },
    BleCapability.CONNECT.takeIf { connect },
    BleCapability.ADVERTISE.takeIf { advertise },
    BleCapability.BACKGROUND_SCAN.takeIf { backgroundScan },
  ).ifEmpty { BleCapability.BASE }
}

class ManufacturerDataRecord : Record {
  @Field val companyId: Int = 0

  @Field val data: ByteArray? = null

  @Field val mask: ByteArray? = null
}

class AndroidScanOptionsRecord : Record {
  @Field val scanMode: String? = null

  @Field val callbackType: String? = null

  @Field val matchMode: String? = null

  @Field val legacy: Boolean = true

  @Field val phy: String? = null

  @Field val reportDelayMs: Double = 0.0
}

/** JS `ScanOptions` (plan §5.3) after the TS layer normalized it. `ios` is ignored here. */
class ScanOptionsRecord : Record {
  @Field val services: List<String> = emptyList()

  @Field val allowDuplicates: Boolean = false

  @Field val reportIntervalMs: Double = 0.0

  @Field val namePrefix: String? = null

  @Field val manufacturerData: List<ManufacturerDataRecord> = emptyList()

  @Field val android: AndroidScanOptionsRecord = AndroidScanOptionsRecord()

  /** Throws INVALID_ARGUMENT for values the TS layer should already have rejected. */
  fun toSpec(): ScanSpec {
    val settings = ScanSettingsSpec(
      scanMode = ScanOptionValues.scanMode(android.scanMode) ?: invalid("android.scanMode", android.scanMode),
      callbackType = ScanOptionValues.callbackType(android.callbackType)
        ?: invalid("android.callbackType", android.callbackType),
      matchMode = ScanOptionValues.matchMode(android.matchMode) ?: invalid("android.matchMode", android.matchMode),
      legacy = android.legacy,
      phy = ScanOptionValues.phy(android.phy) ?: invalid("android.phy", android.phy),
      reportDelayMs = android.reportDelayMs.toLong(),
    )
    return ScanSpec(
      services = services.map { runCatching { UUID.fromString(it) }.getOrElse { _ -> invalid("services", it) } },
      allowDuplicates = allowDuplicates,
      reportIntervalMs = reportIntervalMs.toLong(),
      namePrefix = namePrefix,
      manufacturerData = manufacturerData.map { ManufacturerFilter(it.companyId, it.data, it.mask) },
      settings = settings,
    )
  }

  private fun invalid(option: String, value: Any?): Nothing =
    throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Invalid scan option $option: $value")
}

class AndroidConnectOptionsRecord : Record {
  @Field val autoConnect: Boolean? = null

  /** Null asks for no MTU exchange (JS `requestMtu: false`). */
  @Field val requestMtu: Int? = ConnectSpec.DEFAULT_REQUESTED_MTU

  /** Null never resets (JS `resetAfterTimeouts: false`), P2-06. */
  @Field val resetAfterTimeouts: Int? = ConnectSpec.DEFAULT_RESET_AFTER_TIMEOUTS
}

/** JS `ReconnectPolicy` (plan §5.4) with the defaults applied; `maxAttempts` null means no limit. */
class ReconnectPolicyRecord : Record {
  @Field val maxAttempts: Int? = null

  @Field val initialDelayMs: Double = 1_000.0

  @Field val maxDelayMs: Double = 30_000.0

  @Field val backoff: String = "exponential"

  fun toPolicy(): ReconnectPolicy {
    if ((maxAttempts != null && maxAttempts < 1) || !(initialDelayMs >= 0) || !(maxDelayMs >= initialDelayMs)) {
      throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Invalid connect option reconnect")
    }
    return ReconnectPolicy(maxAttempts, initialDelayMs.toLong(), maxDelayMs.toLong(), backoff != "fixed")
  }
}

/** JS `ConnectOptions` (plan §5.4) after the TS layer applied defaults: `timeoutMs` null means none. */
class ConnectOptionsRecord : Record {
  @Field val timeoutMs: Double? = null

  @Field val autoDiscover: Boolean = true

  /** Null: no reconnection. */
  @Field val reconnect: ReconnectPolicyRecord? = null

  @Field val restoreSubscriptionsOnReconnect: Boolean = true

  @Field val android: AndroidConnectOptionsRecord = AndroidConnectOptionsRecord()

  fun toSpec(): ConnectSpec {
    val timeoutMs = timeoutMs?.let {
      if (!(it > 0)) throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Invalid connect option timeoutMs: $it")
      it.toLong()
    }
    val requestMtu = android.requestMtu?.also {
      if (it !in PeripheralSession.DEFAULT_MTU..PeripheralSession.MAX_MTU) {
        throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Invalid connect option android.requestMtu: $it")
      }
    }
    return ConnectSpec(
      timeoutMs,
      android.autoConnect ?: (timeoutMs == null),
      autoDiscover,
      requestMtu,
      reconnect?.toPolicy(),
      restoreSubscriptionsOnReconnect,
      android.resetAfterTimeouts?.also {
        if (it <
          1
        ) {
          throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Invalid connect option android.resetAfterTimeouts: $it")
        }
      },
    )
  }
}

/** Where an attribute operation goes and how (plan §5.4), after the TS layer normalized the UUIDs. */
class AttributeRequestRecord : Record {
  @Field val service: String = ""

  @Field val characteristic: String = ""

  @Field val descriptor: String? = null

  @Field val withResponse: Boolean = true

  @Field val timeoutMs: Double = 10_000.0

  /** Set when JS may cancel the operation (an `AbortSignal`); see `cancelOperation`. */
  @Field val operationId: Int? = null

  /** Set for a batched subscribe (P2-04). */
  @Field val batch: BatchRecord? = null
}

/** A batched subscription's options (P2-04). The TS layer validates them and applies the defaults. */
class BatchRecord : Record {
  @Field val intervalMs: Double = 16.0

  @Field val maxItems: Int = BatchSpec.DEFAULT_MAX_ITEMS

  fun toSpec() = BatchSpec(intervalMs.toLong().coerceAtLeast(1), maxItems)
}
