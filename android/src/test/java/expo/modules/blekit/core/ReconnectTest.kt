package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

/** P2-01: reconnection policies, the `reconnecting` state and subscription restore on Android. */
class ReconnectTest {
  private val testService = UUID.fromString("0c6c1000-b347-4cfa-9827-1c5a13658519")
  private val stream = UUID.fromString("0c6c1007-b347-4cfa-9827-1c5a13658519")
  private val cccd = PeripheralSession.CCCD
  private val streamInfo = GattCharacteristicInfo(
    GattCharacteristicRef(testService, 0, stream, 0),
    CharacteristicProperties.NOTIFY,
    listOf(cccd),
  )
  private val profile = GattServiceInfo(testService, 0, true, listOf(streamInfo))

  private val executor = ManualExecutor()
  private val device = FakeRemoteDevice("C0:FF:EE:00:00:01").apply { services = listOf(profile) }
  private val log = mutableListOf<String>()
  private val ended = mutableListOf<String>()
  private val received = mutableListOf<List<Byte>>()
  private val session = PeripheralSession(device.address, { device }, executor) { state, error ->
    log += "${state.js}${error?.let { " ${it.code}" } ?: ""}"
  }.apply {
    onSubscriptionEnded = { id, error -> ended += "$id ${error.code}" }
    onNotification = { _, value -> received += value.toList() }
  }
  private val client: FakeGattClient get() = device.clients.last()

  private fun connect(
    policy: ReconnectPolicy? = ReconnectPolicy(maxAttempts = 3),
    restore: Boolean = true,
    timeoutMs: Long? = 5_000,
  ) {
    session.connect(
      ConnectSpec(
        timeoutMs,
        autoDiscover = true,
        requestMtu = null,
        reconnect = policy,
        restoreSubscriptions = restore,
      ),
    ) { log += "connect ${it?.code ?: "ok"}" }
    answer(client)
  }

  /** The device is in range: the link comes up and discovery answers at once. */
  private fun answer(client: FakeGattClient) {
    client.respondsAutomatically = true
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    executor.runUntilIdle()
  }

  private fun loseLink(client: FakeGattClient = this.client) {
    client.callback.onConnectionStateChange(0x08, ConnectionStates.DISCONNECTED)
    executor.runUntilIdle()
  }

  private fun subscribe(id: Int): Result<Unit>? {
    var result: Result<Unit>? = null
    session.subscribe(testService, stream, SubscribeMode.AUTO, id, null) { result = it }
    executor.runUntilIdle()
    return result
  }

  private fun cccdWrites(client: FakeGattClient) =
    client.calls.filterIsInstance<FakeGattClient.Call.WriteDescriptor>().map { it.value }

  @Test
  fun `a lost link reconnects after the first delay, and JS sees reconnecting then connected`() {
    connect()
    assertEquals(listOf("connecting", "connected", "connect ok"), log)
    loseLink()
    assertEquals("reconnecting DISCONNECTED", log.last())
    assertEquals(SessionState.RECONNECTING, session.visibleState)
    assertEquals("nothing before the delay", 1, device.clients.size)

    executor.advanceBy(1_000)
    assertEquals(2, device.clients.size)
    assertFalse("the first attempt connects directly", client.autoConnect)
    assertEquals("attempts read as reconnecting", SessionState.RECONNECTING, session.visibleState)
    answer(client)
    assertEquals(listOf("connecting", "connected", "connect ok", "reconnecting DISCONNECTED", "connected"), log)
    assertEquals(SessionState.READY, session.state)
    assertEquals("discovered again", listOf(testService), session.services.map { it.uuid })
    assertEquals("every client closed once", 1, device.clients[0].closeCount)
  }

  @Test
  fun `later attempts use autoConnect and wait longer, then give up with the last error`() {
    connect(ReconnectPolicy(maxAttempts = 2, initialDelayMs = 1_000, maxDelayMs = 30_000))
    loseLink()
    executor.advanceBy(1_000)
    executor.advanceBy(5_000) // attempt 1 times out
    assertEquals(2, device.clients.size)
    executor.advanceBy(1_999)
    assertEquals("the second wait is 2 s", 2, device.clients.size)
    executor.advanceBy(1)
    assertEquals(3, device.clients.size)
    assertTrue("then autoConnect", client.autoConnect)
    executor.advanceBy(5_000) // attempt 2 times out: no attempts left
    assertEquals("disconnected CONNECTION_TIMEOUT", log.last())
    assertEquals(SessionState.DISCONNECTED, session.state)
    executor.advanceBy(60_000)
    assertEquals("no more attempts", 3, device.clients.size)
    assertTrue("every client closed once", device.clients.all { it.closeCount == 1 })
  }

  @Test
  fun `a connect during reconnection joins it, and disconnect stops it`() {
    connect()
    loseLink()
    session.connect(ConnectSpec(5_000)) { log += "join ${it?.code ?: "ok"}" }
    var disconnected = false
    session.disconnect { disconnected = true }
    assertTrue(disconnected)
    assertEquals(listOf("disconnected", "join OPERATION_CANCELLED"), log.takeLast(2))
    executor.advanceBy(60_000)
    assertEquals("no attempts after disconnect()", 1, device.clients.size)
  }

  @Test
  fun `disconnect during an attempt cancels it and closes its client`() {
    connect()
    loseLink()
    executor.advanceBy(1_000)
    session.disconnect {}
    assertEquals("disconnected", log.last())
    assertEquals(1, client.closeCount)
    executor.advanceBy(60_000)
    assertEquals(2, device.clients.size)
  }

  @Test
  fun `operations wait for nothing while reconnecting`() {
    connect()
    loseLink()
    var result: Result<ByteArray>? = null
    session.read(testService, stream, null, { result = it })
    assertEquals(CoreError.Code.DISCONNECTED, (result?.exceptionOrNull() as CoreError).code)
  }

  @Test
  fun `subscriptions are enabled again before connected, and keep delivering`() {
    connect()
    assertTrue(subscribe(1)!!.isSuccess)
    loseLink()
    assertTrue("nothing ended", ended.isEmpty())
    executor.advanceBy(1_000)
    answer(client)
    assertEquals("the CCCD written again", listOf(listOf<Byte>(1, 0)), cccdWrites(client))
    assertEquals("connected", log.last())
    client.notify(streamInfo.ref, byteArrayOf(7))
    assertEquals(listOf(listOf<Byte>(7)), received)
  }

  @Test
  fun `a subscription that can't be restored ends alone`() {
    connect()
    assertTrue(subscribe(1)!!.isSuccess)
    loseLink()
    device.services = listOf(GattServiceInfo(testService, 0, true, emptyList()))
    executor.advanceBy(1_000)
    answer(client)
    assertEquals(listOf("1 CHARACTERISTIC_NOT_FOUND"), ended)
    assertEquals("the connection still comes back", "connected", log.last())
  }

  @Test
  fun `without restore, subscriptions end when the link is lost`() {
    connect(restore = false)
    assertTrue(subscribe(1)!!.isSuccess)
    assertTrue(subscribe(2)!!.isSuccess)
    loseLink()
    assertEquals(listOf("1 DISCONNECTED", "2 DISCONNECTED"), ended)
    executor.advanceBy(1_000)
    answer(client)
    assertTrue("nothing to restore", cccdWrites(client).isEmpty())
  }

  @Test
  fun `Bluetooth turning off ends the reconnection`() {
    connect()
    loseLink()
    session.forceDisconnected(CoreError(CoreError.Code.BLUETOOTH_POWERED_OFF, "Bluetooth is off"))
    assertEquals("disconnected BLUETOOTH_POWERED_OFF", log.last())
    executor.advanceBy(60_000)
    assertEquals(1, device.clients.size)
  }

  @Test
  fun `without a policy a lost link just disconnects`() {
    connect(policy = null)
    loseLink()
    assertEquals("disconnected DISCONNECTED", log.last())
    executor.advanceBy(60_000)
    assertEquals(1, device.clients.size)
  }

  @Test
  fun `the policy's waits`() {
    val exponential = ReconnectPolicy(initialDelayMs = 500, maxDelayMs = 3_000)
    assertEquals(listOf(500L, 1_000L, 2_000L, 3_000L, 3_000L), (1..5).map(exponential::delayMs))
    assertEquals(30_000L, ReconnectPolicy().delayMs(1_000))
    val fixed = ReconnectPolicy(initialDelayMs = 700, exponential = false)
    assertEquals(listOf(700L, 700L, 700L), (1..3).map(fixed::delayMs))
    assertTrue(ReconnectPolicy().allows(1_000_000))
    assertFalse(ReconnectPolicy(maxAttempts = 2).allows(3))
  }
}
