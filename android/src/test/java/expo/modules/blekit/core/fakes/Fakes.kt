package expo.modules.blekit.core.fakes

import expo.modules.blekit.core.AdapterStates
import expo.modules.blekit.core.BluetoothAdapterPort
import expo.modules.blekit.core.BondStates
import expo.modules.blekit.core.ConnectionStates
import expo.modules.blekit.core.GATT_SUCCESS
import expo.modules.blekit.core.GattCharacteristicInfo
import expo.modules.blekit.core.GattCharacteristicRef
import expo.modules.blekit.core.GattClientCallback
import expo.modules.blekit.core.GattClientPort
import expo.modules.blekit.core.GattDescriptorRef
import expo.modules.blekit.core.GattServiceInfo
import expo.modules.blekit.core.LeScanCallback
import expo.modules.blekit.core.LeScannerPort
import expo.modules.blekit.core.RemoteDevicePort
import expo.modules.blekit.core.ScanFilterSpec
import expo.modules.blekit.core.ScanRecordData
import expo.modules.blekit.core.ScanSettingsSpec
import expo.modules.blekit.core.SubmitStatus
import java.util.UUID

class FakeBluetoothAdapter(override var isAvailable: Boolean = true, override var state: Int = AdapterStates.ON) :
  BluetoothAdapterPort {
  val scanner = FakeLeScanner()
  val devices = mutableMapOf<String, FakeRemoteDevice>()

  override val leScanner: LeScannerPort?
    get() = scanner.takeIf { state == AdapterStates.ON }

  override fun remoteDevice(address: String): RemoteDevicePort = devices.getOrPut(address) { FakeRemoteDevice(address) }

  /** What `connectedGattDevices()` reports. */
  val connectedDevices = mutableListOf<String>()

  override fun connectedGattDevices(): List<String> = connectedDevices.toList()

  var stateListener: ((Int) -> Unit)? = null
    private set

  override fun setStateListener(listener: ((Int) -> Unit)?) {
    stateListener = listener
  }

  /** Changes the adapter state and reports it, like the ACTION_STATE_CHANGED broadcast. */
  fun simulateState(newState: Int) {
    state = newState
    stateListener?.invoke(newState)
  }
}

class FakeLeScanner : LeScannerPort {
  data class Session(val filters: List<ScanFilterSpec>, val settings: ScanSettingsSpec, val callback: LeScanCallback)

  val active = mutableListOf<Session>()
  var startCount = 0
    private set

  override fun startScan(filters: List<ScanFilterSpec>, settings: ScanSettingsSpec, callback: LeScanCallback) {
    startCount++
    active.add(Session(filters, settings, callback))
  }

  override fun stopScan(callback: LeScanCallback) {
    active.removeAll { it.callback === callback }
  }

  /** Delivers results to every active session (filtering is the core's job in these tests). */
  fun emit(vararg results: ScanRecordData) {
    active.toList().forEach { it.callback.onScanResults(results.toList()) }
  }
}

class FakeRemoteDevice(
  override val address: String,
  override var name: String? = null,
  override var bondState: Int = BondStates.NONE,
) : RemoteDevicePort {
  /** The GATT database the device exposes. */
  var services: List<GattServiceInfo> = emptyList()
  val values = mutableMapOf<GattCharacteristicRef, ByteArray>()
  val clients = mutableListOf<FakeGattClient>()
  var refuseConnections = false

  /** What an MTU exchange settles on, whatever is requested (null: the requested value). */
  var negotiatedMtu: Int? = null
  var rssi = -55

  override fun connectGatt(autoConnect: Boolean, callback: GattClientCallback): GattClientPort? {
    if (refuseConnections) return null
    return FakeGattClient(this, autoConnect, callback).also { clients.add(it) }
  }
}

/**
 * Scriptable [GattClientPort]. Calls are recorded in [calls]. With [respondsAutomatically],
 * operations complete immediately; otherwise tests complete them through [callback].
 */
class FakeGattClient(
  private val device: FakeRemoteDevice,
  val autoConnect: Boolean,
  val callback: GattClientCallback,
) : GattClientPort {
  sealed interface Call {
    object DiscoverServices : Call

    data class Read(val ref: GattCharacteristicRef) : Call

    data class Write(val ref: GattCharacteristicRef, val value: List<Byte>, val writeType: Int) : Call

    data class ReadDescriptor(val ref: GattDescriptorRef) : Call

    data class WriteDescriptor(val ref: GattDescriptorRef, val value: List<Byte>) : Call

    data class SetNotification(val ref: GattCharacteristicRef, val enable: Boolean) : Call

    data class RequestMtu(val mtu: Int) : Call

    object ReadRssi : Call

    object Disconnect : Call

    object Close : Call
  }

  val calls = mutableListOf<Call>()
  var respondsAutomatically = false
  var nextWriteStatus = SubmitStatus.SUCCESS
  var closeCount = 0
    private set
  private var discovered: List<GattServiceInfo> = emptyList()

  override val address: String = device.address

  override fun discoverServices(): Boolean {
    calls.add(Call.DiscoverServices)
    if (respondsAutomatically) completeServiceDiscovery()
    return true
  }

  override fun services(): List<GattServiceInfo> = discovered

  override fun readCharacteristic(ref: GattCharacteristicRef): Boolean {
    calls.add(Call.Read(ref))
    if (respondsAutomatically) callback.onCharacteristicRead(ref, device.values[ref] ?: ByteArray(0), GATT_SUCCESS)
    return true
  }

  override fun writeCharacteristic(ref: GattCharacteristicRef, value: ByteArray, writeType: Int): Int {
    calls.add(Call.Write(ref, value.toList(), writeType))
    if (nextWriteStatus != SubmitStatus.SUCCESS) return nextWriteStatus
    device.values[ref] = value
    if (respondsAutomatically) callback.onCharacteristicWrite(ref, GATT_SUCCESS)
    return SubmitStatus.SUCCESS
  }

  override fun readDescriptor(ref: GattDescriptorRef): Boolean {
    calls.add(Call.ReadDescriptor(ref))
    if (respondsAutomatically) callback.onDescriptorRead(ref, ByteArray(0), GATT_SUCCESS)
    return true
  }

  override fun writeDescriptor(ref: GattDescriptorRef, value: ByteArray): Int {
    calls.add(Call.WriteDescriptor(ref, value.toList()))
    if (respondsAutomatically) callback.onDescriptorWrite(ref, GATT_SUCCESS)
    return SubmitStatus.SUCCESS
  }

  override fun setCharacteristicNotification(ref: GattCharacteristicRef, enable: Boolean): Boolean {
    calls.add(Call.SetNotification(ref, enable))
    return true
  }

  override fun requestMtu(mtu: Int): Boolean {
    calls.add(Call.RequestMtu(mtu))
    if (respondsAutomatically) callback.onMtuChanged(device.negotiatedMtu ?: mtu, GATT_SUCCESS)
    return true
  }

  override fun readRemoteRssi(): Boolean {
    calls.add(Call.ReadRssi)
    if (respondsAutomatically) callback.onReadRemoteRssi(device.rssi, GATT_SUCCESS)
    return true
  }

  override fun disconnect() {
    calls.add(Call.Disconnect)
  }

  override fun close() {
    calls.add(Call.Close)
    closeCount++
  }

  // ---------------------------------------------------------------- Test drivers

  fun completeConnection(status: Int = GATT_SUCCESS) {
    callback.onConnectionStateChange(status, ConnectionStates.CONNECTED)
  }

  fun completeDisconnection(status: Int = GATT_SUCCESS) {
    callback.onConnectionStateChange(status, ConnectionStates.DISCONNECTED)
  }

  fun completeServiceDiscovery(status: Int = GATT_SUCCESS) {
    if (status == GATT_SUCCESS) discovered = device.services
    callback.onServicesDiscovered(status)
  }

  fun notify(ref: GattCharacteristicRef, value: ByteArray) {
    callback.onCharacteristicChanged(ref, value)
  }
}

/** Builds a primary service with characteristics, each with instance id 0. */
fun service(uuid: String, vararg characteristics: Pair<String, Int>): GattServiceInfo {
  val serviceUuid = uuid(uuid)
  return GattServiceInfo(
    uuid = serviceUuid,
    instanceId = 0,
    isPrimary = true,
    characteristics =
    characteristics.map { (characteristicUuid, properties) ->
      GattCharacteristicInfo(
        GattCharacteristicRef(serviceUuid, 0, uuid(characteristicUuid), 0),
        properties,
        emptyList(),
      )
    },
  )
}

/** 16-bit SIG UUIDs ("180d") or full 128-bit strings. */
fun uuid(value: String): UUID =
  if (value.length == 4) UUID.fromString("0000$value-0000-1000-8000-00805f9b34fb") else UUID.fromString(value)

fun scanRecord(
  address: String,
  name: String? = null,
  rssi: Int = -60,
  services: List<UUID> = emptyList(),
  manufacturerData: Map<Int, ByteArray> = emptyMap(),
  timestampNanos: Long = 0,
  device: RemoteDevicePort? = null,
): ScanRecordData = ScanRecordData(
  address = address,
  name = name,
  rssi = rssi,
  txPowerLevel = null,
  isConnectable = true,
  serviceUuids = services,
  serviceData = emptyMap(),
  manufacturerData = manufacturerData,
  rawBytes = null,
  timestampNanos = timestampNanos,
  device = device,
)
