package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeBluetoothAdapter
import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.UUID

/** P2-05: several connections at once, each with its own queue; one dropping leaves the others. */
class MultipleDevicesTest {
  private val testService = UUID.fromString("0c6c1000-b347-4cfa-9827-1c5a13658519")
  private val staticRead = UUID.fromString("0c6c1001-b347-4cfa-9827-1c5a13658519")
  private val stream = UUID.fromString("0c6c1007-b347-4cfa-9827-1c5a13658519")
  private val readRef = GattCharacteristicRef(testService, 0, staticRead, 0)
  private val streamRef = GattCharacteristicRef(testService, 0, stream, 0)
  private val profile = GattServiceInfo(
    testService,
    0,
    true,
    listOf(
      GattCharacteristicInfo(readRef, CharacteristicProperties.READ, emptyList()),
      GattCharacteristicInfo(streamRef, CharacteristicProperties.NOTIFY, listOf(PeripheralSession.CCCD)),
    ),
  )

  private val executor = ManualExecutor()
  private val adapter = FakeBluetoothAdapter(state = AdapterStates.ON)
  private val addresses = (1..6).map { "C0:FF:EE:00:00:0$it" }
  private val devices = addresses.associateWith { address ->
    FakeRemoteDevice(address).apply { services = listOf(profile) }.also { adapter.devices[address] = it }
  }
  private val states = mutableMapOf<String, MutableList<String>>()
  private val received = mutableMapOf<String, Int>()
  private val engine = CentralEngine(adapter, Granted, executor, EpochClock(0, 0))

  private object Granted : PermissionSystem {
    override val sdkInt = 34

    override fun declaredPermissions() = DeclaredPermissions(
      setOf(AndroidPermissions.BLUETOOTH_SCAN, AndroidPermissions.BLUETOOTH_CONNECT),
      scanNeverForLocation = true,
    )

    override fun isGranted(permission: String) = true
  }

  private fun client(address: String): FakeGattClient = devices.getValue(address).clients.last()

  @Before
  fun connectAll() {
    engine.listener = object : CentralEngine.Listener {
      override fun onStateChange(state: BleState) = Unit

      override fun onScanResults(sessionId: Int, results: List<Map<String, Any?>>) = Unit

      override fun onScanError(sessionId: Int, error: CoreError) = Unit

      override fun onWarning(warning: CoreError) = Unit

      override fun onNotification(
        peripheralId: String,
        service: UUID,
        characteristic: UUID,
        value: ByteArray,
        timestamp: Double,
      ) {
        received.merge(peripheralId, 1, Int::plus)
      }

      override fun onMtuChange(peripheralId: String, mtu: Int) = Unit

      override fun onSubscriptionEnded(peripheralId: String, subscriptionId: Int, error: CoreError) = Unit

      override fun onNotificationBatch(peripheralId: String, subscriptionId: Int, batch: NotificationBatch) = Unit

      override fun onServicesChanged(peripheralId: String) = Unit

      override fun onConnectionStateChange(peripheralId: String, state: SessionState, error: CoreError?) {
        states.getOrPut(peripheralId) { mutableListOf() } += state.js + (error?.let { " ${it.code}" } ?: "")
      }
    }
    engine.start()
    val connected = mutableListOf<String>()
    addresses.forEach { address ->
      engine.connect(address, ConnectSpec(15_000, requestMtu = null)) { if (it == null) connected += address }
    }
    executor.runUntilIdle()
    // The links come up in another order than they were asked for.
    addresses.reversed().forEach { address ->
      client(address).respondsAutomatically = true
      client(address).callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
      executor.runUntilIdle()
    }
    assertEquals(addresses.reversed(), connected)
    addresses.forEach { address ->
      var subscribed = false
      engine.subscribe(address, testService, stream, SubscribeMode.AUTO, 1, null, null) { subscribed = it.isSuccess }
      executor.runUntilIdle()
      assertTrue(subscribed)
    }
  }

  @Test
  fun `six connections at once, each ready with its own GATT client`() {
    assertTrue(addresses.all { engine.connectionState(it) == "connected" })
    @Suppress("UNCHECKED_CAST")
    val diagnostics = engine.diagnostics()
    assertEquals(mapOf("openGattClients" to 6), diagnostics["android"])
    val sessions = diagnostics["sessions"] as List<Map<String, Any?>>
    assertEquals(6, sessions.size)
    assertTrue(sessions.all { it["subscriptions"] == 1 && it["queueDepth"] == 0 })
  }

  @Test
  fun `an operation stuck on one device doesn't hold up the others`() {
    val first = addresses.first()
    client(first).respondsAutomatically = false
    var stuck: Result<ByteArray>? = null
    engine.read(first, testService, staticRead, 5_000, { stuck = it })
    val reads = mutableMapOf<String, Result<ByteArray>>()
    for (address in addresses.drop(1)) {
      engine.read(address, testService, staticRead, 5_000, { reads[address] = it })
    }
    executor.runUntilIdle()
    assertNull(stuck)
    assertEquals(addresses.drop(1).toSet(), reads.filterValues { it.isSuccess }.keys)
    executor.advanceBy(5_000)
    assertEquals(CoreError.Code.OPERATION_TIMEOUT, (stuck?.exceptionOrNull() as CoreError).code)
  }

  @Test
  fun `one device dropping leaves the others connected and delivering`() {
    val (dropped, others) = addresses.first() to addresses.drop(1)
    client(dropped).respondsAutomatically = false
    var pending: Result<ByteArray>? = null
    engine.read(dropped, testService, staticRead, null, { pending = it })
    executor.runUntilIdle()

    client(dropped).callback.onConnectionStateChange(0x08, ConnectionStates.DISCONNECTED)
    executor.runUntilIdle()
    assertEquals("disconnected DISCONNECTED", states.getValue(dropped).last())
    assertEquals(CoreError.Code.DISCONNECTED, (pending?.exceptionOrNull() as CoreError).code)
    assertEquals(1, client(dropped).closeCount)

    others.forEach { client(it).notify(streamRef, byteArrayOf(1)) }
    executor.runUntilIdle()
    assertEquals(others.associateWith { 1 }, received)
    assertTrue(others.all { engine.connectionState(it) == "connected" && client(it).closeCount == 0 })
    assertTrue("their states didn't move", others.all { states.getValue(it) == listOf("connecting", "connected") })
    val reads = mutableListOf<Boolean>()
    others.forEach { engine.read(it, testService, staticRead, null, { result -> reads += result.isSuccess }) }
    executor.runUntilIdle()
    assertEquals(List(5) { true }, reads)
  }

  @Test
  fun `a 133 retry on one device doesn't touch the others`() {
    val address = addresses.first()
    engine.disconnect(address) {}
    client(address).callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.DISCONNECTED)
    executor.runUntilIdle()
    engine.connect(address, ConnectSpec(15_000, requestMtu = null)) {}
    executor.runUntilIdle()
    client(address).callback.onConnectionStateChange(PeripheralSession.GATT_ERROR, ConnectionStates.DISCONNECTED)
    executor.advanceBy(1_000)
    assertTrue("a new client after the retry delay", devices.getValue(address).clients.size >= 3)
    assertTrue(addresses.drop(1).all { engine.connectionState(it) == "connected" && client(it).closeCount == 0 })
  }
}
