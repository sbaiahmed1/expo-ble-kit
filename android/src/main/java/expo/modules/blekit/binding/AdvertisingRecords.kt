package expo.modules.blekit.binding

import expo.modules.blekit.core.AdvertisingMode
import expo.modules.blekit.core.AdvertisingSpec
import expo.modules.blekit.core.AdvertisingTxPower
import expo.modules.blekit.core.CoreError
import expo.modules.blekit.core.ManufacturerSpec
import expo.modules.blekit.core.ServiceDataSpec
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.UUID

/** JS `AdvertisingData` after the TS layer validated it (plan §5.5, P4-03). */
class AdvertisingDataRecord : Record {
  @Field val localName: String? = null

  @Field val serviceUuids: List<String> = emptyList()

  @Field val manufacturerData: AdvertisingManufacturerRecord? = null

  @Field val serviceData: List<ServiceDataRecord> = emptyList()

  @Field val includeTxPower: Boolean = false
}

class AdvertisingManufacturerRecord : Record {
  @Field val companyId: Int = 0

  @Field val data: ByteArray = ByteArray(0)
}

class ServiceDataRecord : Record {
  @Field val uuid: String = ""

  @Field val data: ByteArray = ByteArray(0)
}

/** JS `AdvertisingOptions`, with the defaults applied by the TS layer. */
class AdvertisingOptionsRecord : Record {
  @Field val connectable: Boolean = true

  @Field val mode: String = AdvertisingMode.LOW_LATENCY.js

  @Field val txPower: String = AdvertisingTxPower.MEDIUM.js

  @Field val extended: Boolean = false

  @Field val timeoutMs: Int? = null
}

fun advertisingSpec(data: AdvertisingDataRecord, options: AdvertisingOptionsRecord) = AdvertisingSpec(
  localName = data.localName,
  serviceUuids = data.serviceUuids.map(UUID::fromString),
  manufacturerData = data.manufacturerData?.let { ManufacturerSpec(it.companyId, it.data) },
  serviceData = data.serviceData.map { ServiceDataSpec(UUID.fromString(it.uuid), it.data) },
  includeTxPower = data.includeTxPower,
  connectable = options.connectable,
  mode = AdvertisingMode.of(options.mode) ?: throw invalid("mode", options.mode),
  txPower = AdvertisingTxPower.of(options.txPower) ?: throw invalid("txPower", options.txPower),
  extended = options.extended,
  timeoutMs = options.timeoutMs,
)

private fun invalid(option: String, value: String) =
  CoreError(CoreError.Code.INVALID_ARGUMENT, "Invalid advertising option android.$option: $value")
