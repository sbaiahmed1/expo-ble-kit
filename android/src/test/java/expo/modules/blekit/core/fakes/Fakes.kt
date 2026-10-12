package expo.modules.blekit.core.fakes

import expo.modules.blekit.core.AdapterStates
import expo.modules.blekit.core.BlockingRunner
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
import expo.modules.blekit.core.L2capServerSocketPort
import expo.modules.blekit.core.L2capSocketPort
import expo.modules.blekit.core.LeScanCallback
import expo.modules.blekit.core.LeScannerPort
import expo.modules.blekit.core.RemoteDevicePort
import expo.modules.blekit.core.ScanFilterSpec
import expo.modules.blekit.core.ScanRecordData
import expo.modules.blekit.core.ScanSettingsSpec
import expo.modules.blekit.core.SubmitStatus
import java.io.IOException
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

  var bondListener: ((String, Int) -> Unit)? = null
    private set

  override fun setBondStateListener(listener: ((address: String, state: Int) -> Unit)?) {
    bondListener = listener
  }

  /** Changes a device's bond state and reports it, like the ACTION_BOND_STATE_CHANGED broadcast. */
  fun simulateBond(address: String, newState: Int) {
    (remoteDevice(address) as FakeRemoteDevice).bondState = newState
    bondListener?.invoke(address, newState)
  }

  /** L2CAP servers published (P5-03), and the PSM the next one gets. */
  val l2capServers = mutableListOf<FakeL2capServerSocket>()
  var nextPsm = 0x80

  override fun listenUsingL2capChannel(secure: Boolean): L2capServerSocketPort =
    FakeL2capServerSocket(nextPsm++, secure).also { l2capServers.add(it) }
}

/** Thrown by fake sockets where a real one would block: [ManualRunner] runs the block again later. */
class Parked : RuntimeException("would block")

/** [BlockingRunner] that runs the started blocks when the test says. */
class ManualRunner : BlockingRunner {
  private val blocks = ArrayDeque<Pair<String, () -> Unit>>()

  /** Names of the blocks started and not finished. */
  val waiting: List<String> get() = blocks.map { it.first }

  override fun run(name: String, block: () -> Unit) {
    blocks.addLast(name to block)
  }

  /** Runs each waiting block once; a block that would block ([Parked]) waits for the next call. */
  fun runAll() {
    repeat(blocks.size) {
      val entry = blocks.removeFirst()
      try {
        entry.second()
      } catch (_: Parked) {
        blocks.addLast(entry)
      }
    }
  }
}

/** A scriptable L2CAP socket (P5-03). Calls that would block throw [Parked]. */
class FakeL2capSocket(override val remoteAddress: String, val psm: Int, val secure: Boolean) : L2capSocketPort {
  override var maxTransmitPacketSize = 4
  override var maxReceivePacketSize = 64

  /** connect() parks until false, then fails with [connectFailure] or succeeds. */
  var connectBlocks = false
  var connectFailure: IOException? = null
  var connected = false
    private set
  var closed = false
    private set

  /** What the peer sent; with [peerClosed], read() reports the end once it is empty. */
  val incoming = ArrayDeque<ByteArray>()
  var peerClosed = false

  /** Each write call's bytes. Writes park while [writeBlocks]; [writeFailure] fails them. */
  val writes = mutableListOf<List<Byte>>()
  var writeBlocks = false
  var writeFailure: IOException? = null

  val written: List<Byte> get() = writes.flatten()

  override fun connect() {
    if (closed) throw IOException("socket closed")
    if (connectBlocks) throw Parked()
    connectFailure?.let { throw it }
    connected = true
  }

  override fun read(buffer: ByteArray): Int {
    if (closed) throw IOException("socket closed")
    val next = incoming.removeFirstOrNull() ?: if (peerClosed) return -1 else throw Parked()
    next.copyInto(buffer)
    return next.size
  }

  override fun write(buffer: ByteArray, offset: Int, length: Int) {
    if (closed) throw IOException("socket closed")
    writeFailure?.let { throw it }
    if (writeBlocks) throw Parked()
    writes += buffer.copyOfRange(offset, offset + length).toList()
  }

  override fun close() {
    closed = true
  }
}

/** A scriptable L2CAP server socket: tests queue the channels centrals open in [incoming]. */
class FakeL2capServerSocket(override val psm: Int, val secure: Boolean) : L2capServerSocketPort {
  val incoming = ArrayDeque<FakeL2capSocket>()
  var closed = false
    private set

  override fun accept(): L2capSocketPort {
    if (closed) throw IOException("server socket closed")
    return incoming.removeFirstOrNull() ?: throw Parked()
  }

  override fun close() {
    closed = true
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
  /** What `createBond()` answers, and how often it was called. */
  var acceptsBond = true
  var bondRequests = 0
    private set

  override fun createBond(): Boolean {
    bondRequests++
    if (acceptsBond && bondState == BondStates.NONE) bondState = BondStates.BONDING
    return acceptsBond
  }

  /** L2CAP channel sockets the core created (P5-03); [refuseL2cap] makes creation fail. */
  val l2capSockets = mutableListOf<FakeL2capSocket>()
  var refuseL2cap = false

  override fun createL2capChannel(psm: Int, secure: Boolean): L2capSocketPort {
    if (refuseL2cap) throw IOException("refused")
    return FakeL2capSocket(address, psm, secure).also { l2capSockets.add(it) }
  }

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

    data class ConnectionPriority(val priority: Int) : Call

    data class SetPreferredPhy(val tx: Int, val rx: Int, val options: Int) : Call

    object ReadPhy : Call

    object Disconnect : Call

    object Close : Call

    object RefreshCache : Call
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

  /** What `requestConnectionPriority` answers. */
  var acceptsPriority = true

  override fun requestConnectionPriority(priority: Int): Boolean {
    calls.add(Call.ConnectionPriority(priority))
    return acceptsPriority
  }

  /** The link's PHYs, as [expo.modules.blekit.core.Phys] values; `readPhy` reports them. */
  var phy = 1 to 1

  override fun setPreferredPhy(txPhy: Int, rxPhy: Int, options: Int) {
    calls.add(Call.SetPreferredPhy(txPhy, rxPhy, options))
  }

  override fun readPhy() {
    calls.add(Call.ReadPhy)
    if (respondsAutomatically) callback.onPhyRead(phy.first, phy.second, GATT_SUCCESS)
  }

  override fun disconnect() {
    calls.add(Call.Disconnect)
  }

  override fun close() {
    calls.add(Call.Close)
    closeCount++
  }

  /** What `refresh()` answers: false plays a platform without the hidden API. */
  var refreshSupported = true

  override fun refreshCache(): Boolean {
    calls.add(Call.RefreshCache)
    return refreshSupported
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
