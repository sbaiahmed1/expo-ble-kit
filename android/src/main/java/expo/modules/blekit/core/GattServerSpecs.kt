package expo.modules.blekit.core

import java.util.UUID

// The peripheral role's GATT server (plan §4.4, §5.5, P4-01): definitions, the port over Android's
// BluetoothGattServer for JVM tests, ATT error codes and the long-read cache.

/** JS `ServiceDefinition` after the TS layer validated it (plan §5.5). */
class ServerServiceSpec(val uuid: UUID, val primary: Boolean, val characteristics: List<ServerCharacteristicSpec>)

/**
 * JS `CharacteristicDefinition`: [properties] as [CharacteristicProperties], [permissions] as
 * [AttributePermissions]. A [value] makes it static: read-only, answered by the core.
 */
class ServerCharacteristicSpec(
  val uuid: UUID,
  val properties: Int,
  val permissions: Int,
  val value: ByteArray?,
  val descriptors: List<ServerDescriptorSpec>,
) {
  val notifiable: Boolean
    get() = properties and (CharacteristicProperties.NOTIFY or CharacteristicProperties.INDICATE) != 0
}

/** A static descriptor (user description 0x2901 or presentation format 0x2904). */
class ServerDescriptorSpec(val uuid: UUID, val value: ByteArray)

/** Same values as `BluetoothGattCharacteristic.PERMISSION_*`. */
object AttributePermissions {
  const val READ = 0x01
  const val READ_ENCRYPTED = 0x02
  const val WRITE = 0x10
  const val WRITE_ENCRYPTED = 0x20

  /** JS `AttributePermission`s to the platform mask; null for an unknown name. */
  fun of(names: List<String>): Int? = names.fold(0) { mask, name ->
    mask or (
      when (name) {
        "readable" -> READ
        "readEncryptionRequired" -> READ_ENCRYPTED
        "writeable" -> WRITE
        "writeEncryptionRequired" -> WRITE_ENCRYPTED
        else -> return null
      }
      )
  }
}

/** The ATT error codes a server answers with (Core spec Vol 3 Part F 3.4.1.1); iOS `CBATTError` uses the same values. */
object AttErrors {
  const val SUCCESS = 0
  const val WRITE_NOT_PERMITTED = 0x03
  const val INVALID_OFFSET = 0x07
  const val INVALID_ATTRIBUTE_LENGTH = 0x0D
  const val UNLIKELY_ERROR = 0x0E
  const val CCCD_IMPROPERLY_CONFIGURED = 0xFD
}

/** The port over `BluetoothGattServer`; events arrive on the server thread through [GattServerEvents]. */
interface GattServerPort {
  /** Starts adding one service; [GattServerEvents.onServiceAdded] tells when Android is done. */
  fun addService(service: ServerServiceSpec): Boolean

  fun sendResponse(central: String, requestId: Int, status: Int, offset: Int, value: ByteArray?): Boolean

  /**
   * Sends one notification, or an indication with [confirm] (P4-02). Returns a [SubmitStatus];
   * [GattServerEvents.onNotificationSent] follows a success. Android before 13 answers busy for
   * any refusal.
   */
  fun notify(central: String, characteristic: UUID, value: ByteArray, confirm: Boolean): Int

  fun close()
}

/** `BluetoothGattServerCallback`, by UUID. Characteristic UUIDs are unique within a server (validated in TS). */
interface GattServerEvents {
  fun onConnectionStateChange(central: String, connected: Boolean)

  fun onServiceAdded(status: Int, service: UUID)

  fun onCharacteristicReadRequest(central: String, requestId: Int, offset: Int, characteristic: UUID)

  fun onCharacteristicWriteRequest(
    central: String,
    requestId: Int,
    characteristic: UUID,
    preparedWrite: Boolean,
    responseNeeded: Boolean,
    offset: Int,
    value: ByteArray,
  )

  fun onDescriptorReadRequest(central: String, requestId: Int, offset: Int, characteristic: UUID, descriptor: UUID)

  fun onDescriptorWriteRequest(
    central: String,
    requestId: Int,
    characteristic: UUID,
    descriptor: UUID,
    preparedWrite: Boolean,
    responseNeeded: Boolean,
    offset: Int,
    value: ByteArray,
  )

  fun onExecuteWrite(central: String, requestId: Int, execute: Boolean)

  /** The notification or indication sent to [central] left the stack (indications: confirmed). */
  fun onNotificationSent(central: String, status: Int)

  fun onMtuChanged(central: String, mtu: Int)
}

/**
 * The long-read cache of plan §5.5 (shared contract `test-contracts/gatt-server-reads.json`): one
 * value per central and characteristic, so the continuation reads of a long read (offset > 0) come
 * from the same handler result as its first read. Called on the server thread.
 */
class ServerReadCache(private val nowMs: () -> Long, private val ttlMs: Long = TTL_MS) {
  private class Entry(val value: ByteArray, val atMs: Long)

  private val entries = HashMap<Pair<String, UUID>, Entry>()

  /** The value to answer a read at [offset] with, or null when the handler must be asked. */
  fun lookup(central: String, characteristic: UUID, offset: Int): ByteArray? {
    if (offset == 0) return null
    val entry = entries[central to characteristic] ?: return null
    return entry.value.takeIf { nowMs() - entry.atMs < ttlMs }
  }

  /** Keeps the handler's answer for the rest of the read sequence. */
  fun store(central: String, characteristic: UUID, value: ByteArray) {
    entries[central to characteristic] = Entry(value, nowMs())
  }

  fun drop(central: String) {
    entries.keys.removeAll { it.first == central }
  }

  fun clear() = entries.clear()

  companion object {
    /** As long as ATT's transaction timeout (Core spec Vol 3 Part F 3.3.3). */
    const val TTL_MS = 30_000L

    /** The part of [value] from [offset], or null when [offset] is past the end (INVALID_OFFSET). */
    fun slice(value: ByteArray, offset: Int): ByteArray? =
      if (offset > value.size) null else value.copyOfRange(offset, value.size)
  }
}
