package expo.modules.blekit.binding

import expo.modules.blekit.core.AttributePermissions
import expo.modules.blekit.core.CharacteristicProperties
import expo.modules.blekit.core.CoreError
import expo.modules.blekit.core.GattServer
import expo.modules.blekit.core.ServerCharacteristicSpec
import expo.modules.blekit.core.ServerDescriptorSpec
import expo.modules.blekit.core.ServerServiceSpec
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.sharedobjects.SharedObject
import java.util.UUID

/**
 * The JS handle of the GATT server (plan §4.5, P4-01), with events `readRequest`, `writeRequest`
 * and `subscriptionChange`. Holds no BLE state: [server] does, on the server thread.
 */
class GattServerObject(appContext: AppContext) : SharedObject(appContext) {
  /** Null once closed. Touched on the server thread only. */
  var server: GattServer? = null

  /** Forwards the core's requests to JS; warnings go to [warn] (the log and the module's `warning` event). */
  fun listener(warn: (CoreError) -> Unit) = object : GattServer.Listener {
    override fun onReadRequest(requestId: Int, central: String, characteristic: UUID, offset: Int) {
      emit(
        "readRequest",
        mapOf(
          "requestId" to requestId,
          "centralId" to central,
          "characteristic" to characteristic.toString(),
          "offset" to offset,
        ),
      )
    }

    override fun onWriteRequest(
      requestId: Int,
      central: String,
      characteristic: UUID,
      offset: Int,
      value: ByteArray,
      withResponse: Boolean,
    ) {
      emit(
        "writeRequest",
        mapOf(
          "requestId" to requestId,
          "centralId" to central,
          "characteristic" to characteristic.toString(),
          "offset" to offset,
          "value" to value,
          "withResponse" to withResponse,
        ),
      )
    }

    override fun onSubscriptionChange(central: String, characteristic: UUID, subscribed: Boolean) {
      emit(
        "subscriptionChange",
        mapOf("centralId" to central, "characteristic" to characteristic.toString(), "subscribed" to subscribed),
      )
    }

    override fun onWarning(warning: CoreError) = warn(warning)
  }
}

/** JS `ServiceDefinition`, validated and normalized by the TS layer (plan §5.5). */
class ServerServiceRecord : Record {
  @Field val uuid: String = ""

  @Field val primary: Boolean = true

  @Field val characteristics: List<ServerCharacteristicRecord> = emptyList()

  fun toSpec() = ServerServiceSpec(UUID.fromString(uuid), primary, characteristics.map { it.toSpec() })
}

class ServerCharacteristicRecord : Record {
  @Field val uuid: String = ""

  @Field val properties: List<String> = emptyList()

  @Field val permissions: List<String> = emptyList()

  @Field val value: ByteArray? = null

  @Field val descriptors: List<ServerDescriptorRecord> = emptyList()

  fun toSpec(): ServerCharacteristicSpec {
    val propertyMask = properties.fold(0) { mask, name ->
      mask or (
        when (name) {
          "read" -> CharacteristicProperties.READ
          "write" -> CharacteristicProperties.WRITE
          "writeWithoutResponse" -> CharacteristicProperties.WRITE_NO_RESPONSE
          "notify" -> CharacteristicProperties.NOTIFY
          "indicate" -> CharacteristicProperties.INDICATE
          else -> throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Unsupported characteristic property $name")
        }
        )
    }
    val permissionMask = AttributePermissions.of(permissions)
      ?: throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Unknown attribute permission in $permissions")
    return ServerCharacteristicSpec(
      UUID.fromString(uuid),
      propertyMask,
      permissionMask,
      value,
      descriptors.map { ServerDescriptorSpec(UUID.fromString(it.uuid), it.value) },
    )
  }
}

class ServerDescriptorRecord : Record {
  @Field val uuid: String = ""

  @Field val value: ByteArray = ByteArray(0)
}
