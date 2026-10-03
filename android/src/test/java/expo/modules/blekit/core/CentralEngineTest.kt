package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeBluetoothAdapter
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import expo.modules.blekit.core.fakes.scanRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

/** P1-03: adapter state as JS sees it. */
class CentralEngineTest {
  private class FakePermissionSystem(override val sdkInt: Int) : PermissionSystem {
    val granted = mutableSetOf<String>()
    var declared = setOf(AndroidPermissions.BLUETOOTH_SCAN, AndroidPermissions.BLUETOOTH_CONNECT)

    override fun declaredPermissions() = DeclaredPermissions(declared, scanNeverForLocation = true)

    override fun isGranted(permission: String) = permission in granted
  }

  private val adapter = FakeBluetoothAdapter(state = AdapterStates.ON)
  private val permissions = FakePermissionSystem(sdkInt = 34)
  private val events = mutableListOf<BleState>()
  private val connections = mutableListOf<String>()

  private fun engine() = CentralEngine(adapter, permissions, ManualExecutor(), EpochClock(0, 0)).also { engine ->
    engine.listener =
      object : CentralEngine.Listener {
        override fun onStateChange(state: BleState) {
          events.add(state)
        }

        override fun onScanResults(sessionId: Int, results: List<Map<String, Any?>>) = Unit

        override fun onScanError(sessionId: Int, error: CoreError) = Unit

        override fun onWarning(warning: CoreError) = Unit

        override fun onNotification(
          peripheralId: String,
          service: UUID,
          characteristic: UUID,
          value: ByteArray,
          timestamp: Double,
        ) = Unit

        override fun onMtuChange(peripheralId: String, mtu: Int) = Unit

        override fun onSubscriptionEnded(peripheralId: String, subscriptionId: Int, error: CoreError) = Unit

        override fun onConnectionStateChange(peripheralId: String, state: SessionState, error: CoreError?) {
          connections += "$peripheralId ${state.js}${error?.let { " ${it.code}" } ?: ""}"
        }
      }
    engine.start()
  }

  @Test
  fun `maps every adapter state`() {
    val on = { state: Int -> BleState.of(isAvailable = true, isAuthorized = true, adapterState = state) }
    assertEquals(BleState.POWERED_OFF, on(AdapterStates.OFF))
    assertEquals(BleState.RESETTING, on(AdapterStates.TURNING_ON))
    assertEquals(BleState.POWERED_ON, on(AdapterStates.ON))
    assertEquals(BleState.RESETTING, on(AdapterStates.TURNING_OFF))
    assertEquals(BleState.UNKNOWN, on(-1))
    assertEquals(BleState.UNSUPPORTED, BleState.of(isAvailable = false, isAuthorized = false, adapterState = 12))
    assertEquals(BleState.UNAUTHORIZED, BleState.of(isAvailable = true, isAuthorized = false, adapterState = 12))
  }

  @Test
  fun `follows the adapter while authorized`() {
    permissions.granted += AndroidPermissions.BLUETOOTH_CONNECT
    val engine = engine()
    assertEquals(BleState.POWERED_ON, engine.state)
    adapter.simulateState(AdapterStates.TURNING_OFF)
    adapter.simulateState(AdapterStates.OFF)
    adapter.simulateState(AdapterStates.OFF)
    adapter.simulateState(AdapterStates.TURNING_ON)
    adapter.simulateState(AdapterStates.ON)
    assertEquals(
      listOf(BleState.RESETTING, BleState.POWERED_OFF, BleState.RESETTING, BleState.POWERED_ON),
      events,
    )
  }

  @Test
  fun `unauthorized until BLUETOOTH_CONNECT is granted, then refresh picks it up`() {
    val engine = engine()
    assertEquals(BleState.UNAUTHORIZED, engine.state)
    adapter.simulateState(AdapterStates.OFF)
    assertEquals(emptyList<BleState>(), events)

    permissions.granted += AndroidPermissions.BLUETOOTH_CONNECT
    engine.refresh()
    assertEquals(listOf(BleState.POWERED_OFF), events)
  }

  @Test
  fun `no runtime permission gates the adapter up to API 30`() {
    val legacy = FakePermissionSystem(sdkInt = 30)
    assertEquals(BleState.POWERED_ON, CentralEngine(adapter, legacy, ManualExecutor(), EpochClock(0, 0)).state)
  }

  @Test
  fun `unsupported without an LE adapter`() {
    adapter.isAvailable = false
    permissions.granted += AndroidPermissions.BLUETOOTH_CONNECT
    assertEquals(BleState.UNSUPPORTED, engine().state)
  }

  @Test
  fun `close stops listening`() {
    val engine = engine()
    engine.close()
    assertNull(adapter.stateListener)
  }

  @Test
  fun `connect checks the id, the permission and the adapter first`() {
    val engine = engine()
    fun codeOf(id: String) =
      runCatching { engine.connect(id, ConnectSpec(15_000)) {} }.exceptionOrNull()?.let { (it as CoreError).code }

    assertEquals(CoreError.Code.INVALID_ARGUMENT, codeOf("not-an-address"))
    assertEquals(CoreError.Code.PERMISSION_DENIED, codeOf("C0:FF:EE:00:00:01"))
    permissions.granted += AndroidPermissions.BLUETOOTH_CONNECT
    adapter.simulateState(AdapterStates.OFF)
    assertEquals(CoreError.Code.BLUETOOTH_POWERED_OFF, codeOf("C0:FF:EE:00:00:01"))
    permissions.declared = setOf(AndroidPermissions.BLUETOOTH_SCAN)
    assertEquals(CoreError.Code.MISCONFIGURED, codeOf("C0:FF:EE:00:00:01"))
  }

  @Test
  fun `connects through the scanned handle and drops sessions when Bluetooth turns off`() {
    permissions.granted += AndroidPermissions.BLUETOOTH_CONNECT
    permissions.granted += AndroidPermissions.BLUETOOTH_SCAN
    val engine = engine()
    val scanned = FakeRemoteDevice("C0:FF:EE:00:00:01")
    engine.startScan(1, ScanSpec())
    adapter.scanner.emit(scanRecord(scanned.address, device = scanned))

    var result: CoreError? = CoreError(CoreError.Code.INTERNAL, "pending")
    engine.connect("c0:ff:ee:00:00:01", ConnectSpec(15_000, autoDiscover = false, requestMtu = null)) { result = it }
    assertEquals("the scanned handle, not getRemoteDevice", 1, scanned.clients.size)
    assertTrue(adapter.devices.isEmpty())
    scanned.clients[0].callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    assertNull(result)
    assertEquals("connected", engine.connectionState("C0:FF:EE:00:00:01"))
    assertEquals(mapOf("openGattClients" to 1), engine.diagnostics()["android"])

    // Not scanned: getRemoteDevice.
    engine.connect("C0:FF:EE:00:00:02", ConnectSpec(15_000)) {}
    assertEquals(1, adapter.devices["C0:FF:EE:00:00:02"]!!.clients.size)

    adapter.simulateState(AdapterStates.TURNING_OFF)
    assertEquals("disconnected", engine.connectionState("C0:FF:EE:00:00:01"))
    assertTrue(connections.contains("C0:FF:EE:00:00:01 disconnected BLUETOOTH_POWERED_OFF"))
    assertEquals(mapOf("openGattClients" to 0), engine.diagnostics()["android"])
    assertEquals(1, scanned.clients[0].closeCount)

    var disconnected = false
    engine.disconnect("C0:FF:EE:00:00:03") { disconnected = true }
    assertTrue("unknown peripherals are already disconnected", disconnected)
  }

  @Test
  fun `names come from scans, then from the device once connected`() {
    permissions.granted += setOf(AndroidPermissions.BLUETOOTH_CONNECT, AndroidPermissions.BLUETOOTH_SCAN)
    val engine = engine()
    val scanned = FakeRemoteDevice("C0:FF:EE:00:00:01", name = "GAP name")
    assertNull(engine.name("C0:FF:EE:00:00:01"))
    engine.startScan(1, ScanSpec())
    adapter.scanner.emit(scanRecord(scanned.address, name = "Advertised", device = scanned))
    assertEquals("Advertised", engine.name("c0:ff:ee:00:00:01"))
    adapter.scanner.emit(scanRecord(scanned.address, name = null, device = scanned))
    assertEquals("a result without a name keeps the last one", "Advertised", engine.name("C0:FF:EE:00:00:01"))

    engine.connect(scanned.address, ConnectSpec(15_000, autoDiscover = false, requestMtu = null)) {}
    scanned.clients[0].callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    assertEquals("GAP name", engine.name(scanned.address))
    assertNull(engine.name("not-an-address"))
  }

  @Test
  fun `known peripherals keep every valid address`() {
    val engine = engine()
    assertEquals(
      listOf("C0:FF:EE:00:00:01", "C0:FF:EE:00:00:02"),
      engine.knownPeripherals(listOf("c0:ff:ee:00:00:01", "nope", "C0:FF:EE:00:00:02", "C0:FF:EE:00:00:01")),
    )
  }

  @Test
  fun `system-connected peripherals need the connect permission`() {
    val engine = engine()
    adapter.connectedDevices += listOf("aa:bb:cc:dd:ee:ff", "C0:FF:EE:00:00:01")
    val services = listOf(UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb"))
    val denied = runCatching { engine.systemConnectedPeripherals(services) }.exceptionOrNull() as CoreError
    assertEquals(CoreError.Code.PERMISSION_DENIED, denied.code)
    permissions.granted += AndroidPermissions.BLUETOOTH_CONNECT
    assertEquals(listOf("AA:BB:CC:DD:EE:FF", "C0:FF:EE:00:00:01"), engine.systemConnectedPeripherals(services))
  }
}
