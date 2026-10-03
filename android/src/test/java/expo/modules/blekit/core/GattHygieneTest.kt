package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID
import kotlin.random.Random

/** P2-06: service changes, the opt-in cache refresh, the stuck-stack reset and close() on Android. */
class GattHygieneTest {
  private val testService = UUID.fromString("0c6c1000-b347-4cfa-9827-1c5a13658519")
  private val secondary = UUID.fromString("0c6c2000-b347-4cfa-9827-1c5a13658519")
  private val staticRead = UUID.fromString("0c6c1001-b347-4cfa-9827-1c5a13658519")
  private val stream = UUID.fromString("0c6c1007-b347-4cfa-9827-1c5a13658519")
  private val secondaryValue = UUID.fromString("0c6c2001-b347-4cfa-9827-1c5a13658519")
  private val cccd = PeripheralSession.CCCD

  private fun profile(withSecondary: Boolean, instance: Int = 0): List<GattServiceInfo> {
    val test = GattServiceInfo(
      testService,
      instance,
      true,
      listOf(
        GattCharacteristicInfo(
          GattCharacteristicRef(testService, instance, staticRead, 0),
          CharacteristicProperties.READ,
          emptyList(),
        ),
        GattCharacteristicInfo(
          GattCharacteristicRef(testService, instance, stream, 1),
          CharacteristicProperties.NOTIFY,
          listOf(cccd),
        ),
      ),
    )
    val extra = GattServiceInfo(
      secondary,
      instance + 10,
      true,
      listOf(
        GattCharacteristicInfo(
          GattCharacteristicRef(secondary, instance + 10, secondaryValue, 0),
          CharacteristicProperties.NOTIFY,
          listOf(cccd),
        ),
      ),
    )
    return if (withSecondary) listOf(test, extra) else listOf(test)
  }

  private val executor = ManualExecutor()
  private val device = FakeRemoteDevice("C0:FF:EE:00:00:01").apply { services = profile(withSecondary = true) }
  private val log = mutableListOf<String>()
  private val session = PeripheralSession(device.address, { device }, executor) { state, error ->
    log += state.js + (error?.let { " ${it.code}" } ?: "")
  }.apply {
    onServicesChanged = { log += "servicesChanged ${services.map { it.uuid }}" }
    onSubscriptionEnded = { id, error -> log += "ended $id ${error.code}" }
    onNotification = { ref, _, _ -> log += "value ${ref.uuid}" }
  }
  private val client: FakeGattClient get() = device.clients.last()

  private fun connect(spec: ConnectSpec = ConnectSpec(15_000, requestMtu = null)) {
    session.connect(spec) {}
    client.respondsAutomatically = true
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    executor.runUntilIdle()
    assertEquals(SessionState.READY, session.state)
  }

  private fun subscribe(id: Int, service: UUID, characteristic: UUID) {
    var result: Result<Unit>? = null
    session.subscribe(service, characteristic, SubscribeMode.AUTO, id, null) { result = it }
    executor.runUntilIdle()
    assertTrue(result!!.isSuccess)
  }

  private fun cccdWrites() = client.calls.count { it is FakeGattClient.Call.WriteDescriptor }

  @Test
  fun `a service change discovers again, restores what is still there, then reports it`() {
    connect()
    subscribe(1, testService, stream)
    subscribe(2, secondary, secondaryValue)
    client.calls.clear()

    // The peripheral drops the secondary service; its handles shift.
    device.services = profile(withSecondary = false, instance = 1)
    client.callback.onServiceChanged()
    executor.runUntilIdle()
    assertEquals(1, client.calls.count { it == FakeGattClient.Call.DiscoverServices })
    assertEquals("the remaining subscription's CCCD is written again", 1, cccdWrites())
    assertEquals(
      listOf("ended 2 CHARACTERISTIC_NOT_FOUND", "servicesChanged [$testService]"),
      log.takeLast(2),
    )
    assertEquals(listOf(testService), session.services.map { it.uuid })

    client.notify(GattCharacteristicRef(testService, 1, stream, 1), byteArrayOf(1))
    assertEquals("value $stream", log.last())
    assertEquals(1, session.subscriptionCount)
  }

  @Test
  fun `the new discovery runs ahead of queued operations`() {
    connect()
    client.respondsAutomatically = false
    var read: Result<ByteArray>? = null
    session.read(testService, staticRead, null, { read = it })
    session.read(testService, staticRead, null, {})
    executor.runUntilIdle()
    client.callback.onServiceChanged()
    client.callback.onCharacteristicRead(
      GattCharacteristicRef(testService, 0, staticRead, 0),
      byteArrayOf(1),
      GATT_SUCCESS,
    )
    executor.runUntilIdle()
    assertTrue(read!!.isSuccess)
    assertEquals("discovery before the second read", FakeGattClient.Call.DiscoverServices, client.calls.last())
  }

  @Test
  fun `a service change during setup is left to the discovery under way`() {
    session.connect(ConnectSpec(15_000, requestMtu = null)) {}
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    executor.runUntilIdle()
    client.callback.onServiceChanged()
    executor.runUntilIdle()
    assertEquals(1, client.calls.count { it == FakeGattClient.Call.DiscoverServices })
    assertFalse(log.any { it.startsWith("servicesChanged") })
  }

  @Test
  fun `refreshGattCache clears the cache and discovers again, or answers false without the API`() {
    connect()
    subscribe(1, testService, stream)
    client.calls.clear()
    var refreshed: Result<Boolean>? = null
    session.refreshGattCache { refreshed = it }
    executor.runUntilIdle()
    assertEquals(true, refreshed?.getOrNull())
    assertEquals(
      listOf(FakeGattClient.Call.RefreshCache, FakeGattClient.Call.DiscoverServices),
      client.calls.take(2),
    )
    assertTrue(log.last().startsWith("servicesChanged"))

    client.refreshSupported = false
    client.calls.clear()
    session.refreshGattCache { refreshed = it }
    executor.runUntilIdle()
    assertEquals(false, refreshed?.getOrNull())
    assertEquals(listOf(FakeGattClient.Call.RefreshCache), client.calls)

    session.disconnect {}
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.DISCONNECTED)
    executor.runUntilIdle()
    session.refreshGattCache { refreshed = it }
    assertEquals(CoreError.Code.DISCONNECTED, (refreshed?.exceptionOrNull() as CoreError).code)
  }

  private fun timeOutReads(count: Int) {
    client.respondsAutomatically = false
    repeat(count) { session.read(testService, staticRead, 1_000, {}) }
    executor.advanceBy(1_000L * count)
  }

  @Test
  fun `two timeouts in a row reset the connection by default`() {
    connect()
    timeOutReads(2)
    assertEquals("disconnected DISCONNECTED", log.last())
    assertEquals(1, client.closeCount)
  }

  @Test
  fun `resetAfterTimeouts sets how many, or turns the reset off`() {
    connect(ConnectSpec(15_000, requestMtu = null, resetAfterTimeouts = 3))
    timeOutReads(2)
    assertEquals(SessionState.READY, session.state)
    timeOutReads(1)
    assertEquals(SessionState.DISCONNECTED, session.state)

    connect(ConnectSpec(15_000, requestMtu = null, resetAfterTimeouts = null))
    timeOutReads(5)
    assertEquals(SessionState.READY, session.state)
  }

  @Test
  fun `a reset with a reconnection policy reconnects`() {
    connect(ConnectSpec(15_000, requestMtu = null, reconnect = ReconnectPolicy(maxAttempts = 1)))
    timeOutReads(2)
    assertEquals("reconnecting DISCONNECTED", log.last())
  }

  @Test
  fun `the timeout count starts again with each connection`() {
    connect()
    timeOutReads(1)
    session.disconnect {}
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.DISCONNECTED)
    executor.runUntilIdle()
    connect()
    timeOutReads(1)
    assertEquals(SessionState.READY, session.state)
  }

  /**
   * 500 connections ending every way a connection can end; every GATT client is closed exactly once
   * and none stays open.
   */
  @Test
  fun `close() soak over 500 cycles`() {
    val random = Random(26)
    repeat(500) { cycle ->
      val scenario = random.nextInt(7)
      var answered = false
      session.connect(ConnectSpec(5_000, requestMtu = null, reconnect = ReconnectPolicy(maxAttempts = 1))) {
        answered = true
      }
      executor.runUntilIdle()
      when (scenario) {
        0 -> {
          // Connects, then disconnects cleanly.
          client.respondsAutomatically = true
          client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
          executor.runUntilIdle()
          session.disconnect {}
          client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.DISCONNECTED)
        }

        1 -> executor.advanceBy(5_000)

        // times out

        2 -> {
          // 133 twice, then the link comes up and drops during discovery.
          client.callback.onConnectionStateChange(PeripheralSession.GATT_ERROR, ConnectionStates.DISCONNECTED)
          executor.advanceBy(250)
          client.callback.onConnectionStateChange(PeripheralSession.GATT_ERROR, ConnectionStates.DISCONNECTED)
          executor.advanceBy(500)
          client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
          executor.runUntilIdle()
          client.callback.onConnectionStateChange(0x08, ConnectionStates.DISCONNECTED)
        }

        3 -> session.disconnect {}

        // cancelled while connecting

        4 -> {
          // Ready, loses the link, the one reconnection attempt times out.
          client.respondsAutomatically = true
          client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
          executor.runUntilIdle()
          client.callback.onConnectionStateChange(0x08, ConnectionStates.DISCONNECTED)
          executor.advanceBy(1_000 + 5_000)
        }

        5 -> {
          // Ready, then the stack gets stuck: two timeouts reset it, and the reconnection fails.
          client.respondsAutomatically = true
          client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
          executor.runUntilIdle()
          client.respondsAutomatically = false
          repeat(2) { session.read(testService, staticRead, 1_000, {}) }
          executor.advanceBy(2_000)
          executor.advanceBy(1_000)
          client.callback.onConnectionStateChange(PeripheralSession.GATT_ERROR, ConnectionStates.DISCONNECTED)
          executor.advanceBy(10_000)
        }

        else -> {
          // Bluetooth goes off while ready.
          client.respondsAutomatically = true
          client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
          executor.runUntilIdle()
          session.forceDisconnected(CoreError(CoreError.Code.BLUETOOTH_POWERED_OFF, "Bluetooth is off"))
        }
      }
      executor.advanceBy(10_000)
      assertEquals("cycle $cycle (scenario $scenario)", SessionState.DISCONNECTED, session.state)
      assertFalse("cycle $cycle: a client stayed open", session.hasOpenClient)
      assertTrue("cycle $cycle (scenario $scenario): the connect was answered", answered)
    }
    val counts = device.clients.groupBy { it.closeCount }.mapValues { it.value.size }
    assertEquals("every client closed exactly once", mapOf(1 to device.clients.size), counts)
    assertTrue(device.clients.size >= 500)
  }
}
