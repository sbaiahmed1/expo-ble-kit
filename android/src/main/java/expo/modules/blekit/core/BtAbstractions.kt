package expo.modules.blekit.core

import java.util.UUID

// Interfaces over the Android Bluetooth APIs the core uses (plan §4.4, BtAbstractions), so JVM unit
// tests can drive the core with fakes. Android's own Bluetooth classes can't be created in JVM
// tests, so these interfaces use the plain types below. Real implementations: AndroidBtAdapters.kt.
//
// Threading (plan §4.7): every call and callback happens on the BLE thread (SerialExecutor).

/** Same values as `BluetoothAdapter.STATE_*`. */
object AdapterStates {
  const val OFF = 10
  const val TURNING_ON = 11
  const val ON = 12
  const val TURNING_OFF = 13
}

/** Same values as `BluetoothProfile.STATE_*`. */
object ConnectionStates {
  const val DISCONNECTED = 0
  const val CONNECTING = 1
  const val CONNECTED = 2
  const val DISCONNECTING = 3
}

/** Same values as `BluetoothDevice.BOND_*`. */
object BondStates {
  const val NONE = 10
  const val BONDING = 11
  const val BONDED = 12
}

/** Same values as `BluetoothGattCharacteristic.WRITE_TYPE_*`. */
object WriteTypes {
  const val NO_RESPONSE = 1
  const val DEFAULT = 2
  const val SIGNED = 4
}

/** Same values as `BluetoothGattCharacteristic.PROPERTY_*`. */
object CharacteristicProperties {
  const val BROADCAST = 0x01
  const val READ = 0x02
  const val WRITE_NO_RESPONSE = 0x04
  const val WRITE = 0x08
  const val NOTIFY = 0x10
  const val INDICATE = 0x20
  const val SIGNED_WRITE = 0x40
  const val EXTENDED_PROPS = 0x80
}

/** Same values as `ScanSettings.SCAN_MODE_*`. */
object ScanModes {
  const val OPPORTUNISTIC = -1
  const val LOW_POWER = 0
  const val BALANCED = 1
  const val LOW_LATENCY = 2
}

/** `BluetoothGatt.GATT_SUCCESS`. Other GATT statuses are mapped by the error model (P1-10). */
const val GATT_SUCCESS = 0

/**
 * Write-callback statuses that mean something else for a write without response (plan §4.9, P2-02;
 * AOSP `att_protocol.cc` `attp_cl_send_cmd` and `l2c_api.cc` `L2CA_SendFixedChnlData`).
 */
object WriteStatuses {
  /** `BluetoothGatt.GATT_CONNECTION_CONGESTED`: the stack took the packet, and the link is now congested. */
  const val CONGESTED = 0x8F

  /** The stack's `GATT_INTERNAL_ERROR` (no public constant): L2CAP refused the packet while congested. */
  const val INTERNAL_ERROR = 0x81
}

/** Result of submitting a write. Same values as `BluetoothStatusCodes` (API 33). */
object SubmitStatus {
  const val SUCCESS = 0
  const val ERROR_GATT_WRITE_REQUEST_BUSY = 201
  const val ERROR_UNKNOWN = Int.MAX_VALUE
}

// ---------------------------------------------------------------- GATT attributes

/** Identifies a characteristic for the lifetime of one service discovery. */
data class GattCharacteristicRef(
  val serviceUuid: UUID,
  val serviceInstanceId: Int,
  val uuid: UUID,
  val instanceId: Int,
)

data class GattDescriptorRef(val characteristic: GattCharacteristicRef, val uuid: UUID)

data class GattCharacteristicInfo(
  val ref: GattCharacteristicRef,
  /** Bit field of [CharacteristicProperties]. */
  val properties: Int,
  val descriptors: List<UUID>,
)

data class GattServiceInfo(
  val uuid: UUID,
  val instanceId: Int,
  val isPrimary: Boolean,
  val characteristics: List<GattCharacteristicInfo>,
)

// ---------------------------------------------------------------- Scanning

class ScanFilterSpec(
  val serviceUuid: UUID? = null,
  val deviceName: String? = null,
  val deviceAddress: String? = null,
  val manufacturerId: Int? = null,
  val manufacturerData: ByteArray? = null,
  val manufacturerDataMask: ByteArray? = null,
)

data class ScanSettingsSpec(
  val scanMode: Int = ScanModes.BALANCED,
  /** `ScanSettings.CALLBACK_TYPE_*`; 1 = all matches. */
  val callbackType: Int = 1,
  /** `ScanSettings.MATCH_MODE_*`; 1 = aggressive. */
  val matchMode: Int = 1,
  val legacy: Boolean = true,
  /** `ScanSettings.PHY_LE_ALL_SUPPORTED` = 255. */
  val phy: Int = 255,
  val reportDelayMs: Long = 0,
)

class ScanRecordData(
  val address: String,
  val name: String?,
  val rssi: Int,
  val txPowerLevel: Int?,
  val isConnectable: Boolean?,
  val serviceUuids: List<UUID>,
  val serviceData: Map<UUID, ByteArray>,
  /** Keyed by Bluetooth SIG company id. */
  val manufacturerData: Map<Int, ByteArray>,
  /** Raw advertising + scan response bytes. */
  val rawBytes: ByteArray?,
  /** `SystemClock.elapsedRealtimeNanos()` when the result was received. */
  val timestampNanos: Long,
  /**
   * The scanned device. It keeps the address type the scan saw, which a device created from the
   * address alone doesn't (`getRemoteDevice` assumes public; plan §4.12).
   */
  val device: RemoteDevicePort? = null,
)

interface LeScanCallback {
  /** One result, or a batch when `reportDelayMs` > 0. */
  fun onScanResults(results: List<ScanRecordData>)

  /** `ScanCallback.SCAN_FAILED_*` code. */
  fun onScanFailed(errorCode: Int)
}

interface LeScannerPort {
  fun startScan(filters: List<ScanFilterSpec>, settings: ScanSettingsSpec, callback: LeScanCallback)

  fun stopScan(callback: LeScanCallback)
}

// ---------------------------------------------------------------- Adapter and devices

interface BluetoothAdapterPort {
  /** The device has a Bluetooth LE adapter. */
  val isAvailable: Boolean

  /** One of [AdapterStates]. */
  val state: Int

  /** Null while the adapter is off. */
  val leScanner: LeScannerPort?

  /** Reports each adapter state change (one of [AdapterStates]) on the BLE thread. Null stops reporting. */
  fun setStateListener(listener: ((Int) -> Unit)?)

  /** Never fails, even for unknown addresses (plan §4.12). */
  fun remoteDevice(address: String): RemoteDevicePort

  /** Addresses of the LE devices connected at the OS level, by any app. Needs BLUETOOTH_CONNECT (API 31+). */
  fun connectedGattDevices(): List<String>
}

interface RemoteDevicePort {
  val address: String
  val name: String?

  /** One of [BondStates]. */
  val bondState: Int

  /** Starts an LE GATT connection with callbacks on the BLE thread. Null if the platform refused. */
  fun connectGatt(autoConnect: Boolean, callback: GattClientCallback): GattClientPort?
}

/** A GATT client connection. Mirrors `BluetoothGatt`; boolean results mean "submitted". */
interface GattClientPort {
  val address: String

  fun discoverServices(): Boolean

  /** Discovered services; empty before service discovery. */
  fun services(): List<GattServiceInfo>

  fun readCharacteristic(ref: GattCharacteristicRef): Boolean

  /** Returns a [SubmitStatus] value. */
  fun writeCharacteristic(ref: GattCharacteristicRef, value: ByteArray, writeType: Int): Int

  fun readDescriptor(ref: GattDescriptorRef): Boolean

  /** Returns a [SubmitStatus] value. */
  fun writeDescriptor(ref: GattDescriptorRef, value: ByteArray): Int

  fun setCharacteristicNotification(ref: GattCharacteristicRef, enable: Boolean): Boolean

  fun requestMtu(mtu: Int): Boolean

  fun readRemoteRssi(): Boolean

  fun disconnect()

  /** Releases the platform GATT client. Must be called exactly once per connection (rule 3). */
  fun close()
}

/** Callbacks from a [GattClientPort]. Values arrive with the callback. */
interface GattClientCallback {
  fun onConnectionStateChange(status: Int, newState: Int) {}

  fun onServicesDiscovered(status: Int) {}

  fun onCharacteristicRead(ref: GattCharacteristicRef, value: ByteArray, status: Int) {}

  fun onCharacteristicWrite(ref: GattCharacteristicRef, status: Int) {}

  fun onCharacteristicChanged(ref: GattCharacteristicRef, value: ByteArray) {}

  fun onDescriptorRead(ref: GattDescriptorRef, value: ByteArray, status: Int) {}

  fun onDescriptorWrite(ref: GattDescriptorRef, status: Int) {}

  fun onMtuChanged(mtu: Int, status: Int) {}

  fun onReadRemoteRssi(rssi: Int, status: Int) {}

  /** API 31+: the peripheral's GATT database changed. */
  fun onServiceChanged() {}
}
