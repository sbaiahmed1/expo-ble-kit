package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import expo.modules.blekit.core.fakes.service
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P1-05: connect, timeouts, the 133 retry, disconnect, link loss, and close() on every path.
 * P1-06: discovery, autoDiscover and the cache.
 */
class PeripheralSessionTest {
  private val executor = ManualExecutor()
  private val device = FakeRemoteDevice("C0:FF:EE:00:00:01")

  /** State changes and settled calls, in order. */
  private val log = mutableListOf<String>()
  private val session = PeripheralSession(device.address, { device }, executor) { state, error ->
    log += "state ${state.js}${error?.let { " ${it.code}" } ?: ""}"
  }
  private var connectError: CoreError? = null

  private fun connect(timeoutMs: Long? = 15_000, autoDiscover: Boolean = false) {
    session.connect(ConnectSpec(timeoutMs, autoDiscover = autoDiscover, requestMtu = null)) { error ->
      connectError = error
      log += "connect ${error?.code ?: "ok"}"
    }
  }

  private fun disconnect() = session.disconnect { log += "disconnect ok" }

  private val client: FakeGattClient get() = device.clients.last()

  private fun linkUp(client: FakeGattClient = this.client) =
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)

  private fun linkDown(status: Int, client: FakeGattClient = this.client) =
    client.callback.onConnectionStateChange(status, ConnectionStates.DISCONNECTED)

  private fun assertClosedOnce(vararg clients: FakeGattClient) =
    clients.forEach { assertEquals("close() exactly once", 1, it.closeCount) }

  @Test
  fun `the state listener sees connected before connect resolves`() {
    connect()
    assertFalse(client.autoConnect)
    linkUp()
    assertEquals(listOf("state connecting", "state connected", "connect ok"), log)
    assertEquals(SessionState.READY, session.state)
    assertTrue(session.hasOpenClient)

    connect()
    assertEquals("already connected resolves at once", "connect ok", log.last())
    assertEquals(1, device.clients.size)
  }

  @Test
  fun `a connect that never succeeds times out, and the client is closed`() {
    connect(timeoutMs = 5_000)
    executor.advanceBy(4_999)
    assertNull(connectError)
    executor.advanceBy(1)
    assertEquals(CoreError.Code.CONNECTION_TIMEOUT, connectError?.code)
    assertEquals(listOf(FakeGattClient.Call.Disconnect, FakeGattClient.Call.Close), client.calls)
    assertClosedOnce(client)
    assertFalse(session.hasOpenClient)

    // The stack connects late: ignored, nothing is reopened or closed twice.
    linkUp()
    assertEquals(SessionState.DISCONNECTED, session.state)
    assertClosedOnce(client)
  }

  @Test
  fun `status 133 is retried with backoff, up to three attempts`() {
    connect()
    linkDown(PeripheralSession.GATT_ERROR)
    val first = client
    executor.advanceBy(PeripheralSession.RETRY_BASE_DELAY_MS - 1)
    assertEquals(1, device.clients.size)
    executor.advanceBy(1)
    assertEquals(2, device.clients.size)
    linkDown(PeripheralSession.GATT_ERROR)
    executor.advanceBy(2 * PeripheralSession.RETRY_BASE_DELAY_MS)
    assertEquals(3, device.clients.size)
    linkDown(PeripheralSession.GATT_ERROR)

    assertEquals(CoreError.Code.CONNECTION_FAILED, connectError?.code)
    assertEquals(133, connectError?.gattStatus)
    assertEquals(3, device.clients.size)
    assertClosedOnce(first, device.clients[1], device.clients[2])
    assertEquals(listOf("state connecting", "state disconnected CONNECTION_FAILED", "connect CONNECTION_FAILED"), log)
  }

  @Test
  fun `a retry that succeeds resolves the connect`() {
    connect()
    linkDown(PeripheralSession.GATT_ERROR)
    executor.advanceBy(PeripheralSession.RETRY_BASE_DELAY_MS)
    linkUp()
    assertEquals("connect ok", log.last())
    assertClosedOnce(device.clients[0])
    assertEquals(0, device.clients[1].closeCount)
  }

  @Test
  fun `other connect failures are not retried`() {
    connect()
    linkDown(147)
    executor.advanceBy(10_000)
    assertEquals(1, device.clients.size)
    assertEquals(CoreError.Code.CONNECTION_FAILED, connectError?.code)
    assertClosedOnce(client)
  }

  @Test
  fun `without a timeout the connect waits until disconnect cancels it`() {
    connect(timeoutMs = null)
    assertTrue("a background connect", client.autoConnect)
    executor.advanceBy(60 * 60 * 1000)
    assertNull(connectError)

    disconnect()
    assertEquals(CoreError.Code.OPERATION_CANCELLED, connectError?.code)
    assertEquals(listOf(FakeGattClient.Call.Disconnect, FakeGattClient.Call.Close), client.calls)
    assertClosedOnce(client)
    // A cancel isn't an error for the state listener.
    assertEquals(
      listOf("state connecting", "state disconnected", "connect OPERATION_CANCELLED", "disconnect ok"),
      log,
    )
  }

  @Test
  fun `disconnect waits for the link to go down, then closes`() {
    connect()
    linkUp()
    log.clear()
    disconnect()
    assertEquals(listOf("state disconnecting"), log)
    assertEquals(listOf(FakeGattClient.Call.Disconnect), client.calls)
    linkDown(0x16)
    assertEquals(listOf("state disconnecting", "state disconnected", "disconnect ok"), log)
    assertClosedOnce(client)
    disconnect()
    assertEquals("already disconnected resolves at once", "disconnect ok", log.last())
  }

  @Test
  fun `disconnect closes anyway when the stack never confirms`() {
    connect()
    linkUp()
    disconnect()
    executor.advanceBy(PeripheralSession.DISCONNECT_TIMEOUT_MS)
    assertEquals("disconnect ok", log.last())
    assertClosedOnce(client)
    linkDown(0)
    assertClosedOnce(client)
  }

  @Test
  fun `link loss reports DISCONNECTED with the status and fails queued operations`() {
    connect()
    linkUp()
    var opError: CoreError? = null
    session.queue.enqueue(GattOperation.Kind.READ, "op", start = {}, completion = {
      opError =
        (it as? GattResult.Failure)?.error
    })
    linkDown(0x08)
    assertEquals("state disconnected DISCONNECTED", log.last())
    assertEquals(CoreError.Code.DISCONNECTED, opError?.code)
    assertClosedOnce(client)
  }

  @Test
  fun `a second connect joins the pending one, and connect after disconnecting reconnects`() {
    connect()
    connect()
    linkUp()
    assertEquals(2, log.count { it == "connect ok" })
    assertEquals(1, device.clients.size)

    disconnect()
    connect()
    linkDown(0x16)
    assertEquals(2, device.clients.size)
    linkUp()
    assertEquals(3, log.count { it == "connect ok" })
  }

  @Test
  fun `a refused connectGatt fails without a client`() {
    device.refuseConnections = true
    connect()
    assertEquals(CoreError.Code.CONNECTION_FAILED, connectError?.code)
    assertTrue(device.clients.isEmpty())
    assertFalse(session.hasOpenClient)
  }

  @Test
  fun `forceDisconnected drops a pending connect and closes`() {
    connect()
    session.forceDisconnected(CoreError(CoreError.Code.BLUETOOTH_POWERED_OFF, "Bluetooth is off"))
    assertEquals(CoreError.Code.BLUETOOTH_POWERED_OFF, connectError?.code)
    assertEquals("state disconnected BLUETOOTH_POWERED_OFF", log[1])
    assertClosedOnce(client)
  }

  // ---------------------------------------------------------------- P1-06 discovery

  private val heartRate = service("180d", "2a37" to CharacteristicProperties.NOTIFY)
  private val battery = service("180f", "2a19" to (CharacteristicProperties.READ or CharacteristicProperties.NOTIFY))

  private fun discoverResult(filter: List<java.util.UUID>? = null): MutableList<Result<List<GattServiceInfo>>> {
    val results = mutableListOf<Result<List<GattServiceInfo>>>()
    session.discover(filter, timeoutMs = null) { results += it }
    executor.runUntilIdle()
    return results
  }

  @Test
  fun `autoDiscover runs before the connection is ready`() {
    device.services = listOf(heartRate, battery)
    connect(autoDiscover = true)
    linkUp()
    assertEquals("still connecting while discovering", listOf("state connecting"), log)
    executor.runUntilIdle()
    assertEquals(listOf(FakeGattClient.Call.DiscoverServices), client.calls)
    client.completeServiceDiscovery()
    assertEquals(listOf("state connecting", "state connected", "connect ok"), log)
    assertEquals(listOf(heartRate, battery), session.services)
  }

  @Test
  fun `a failed autoDiscover fails the connect and closes`() {
    connect(autoDiscover = true)
    linkUp()
    executor.runUntilIdle()
    client.completeServiceDiscovery(status = 0x101)
    assertEquals(CoreError.Code.GATT_ERROR, connectError?.code)
    assertEquals("state disconnected GATT_ERROR", log[1])
    assertClosedOnce(client)
  }

  @Test
  fun `the connect timeout covers discovery`() {
    connect(timeoutMs = 5_000, autoDiscover = true)
    executor.advanceBy(1_000)
    linkUp()
    executor.advanceBy(4_000)
    assertEquals(CoreError.Code.CONNECTION_TIMEOUT, connectError?.code)
    assertClosedOnce(client)
    client.completeServiceDiscovery()
    assertEquals(SessionState.DISCONNECTED, session.state)
  }

  @Test
  fun `a link drop during discovery fails the connect`() {
    connect(autoDiscover = true)
    linkUp()
    executor.runUntilIdle()
    linkDown(0x08)
    assertEquals(CoreError.Code.CONNECTION_FAILED, connectError?.code)
    assertClosedOnce(client)
  }

  @Test
  fun `filtered discovery returns the requested services and caches all`() {
    device.services = listOf(heartRate, battery)
    connect()
    linkUp()
    val results = discoverResult(filter = listOf(battery.uuid))
    client.completeServiceDiscovery()
    assertEquals(listOf(battery), results.single().getOrThrow())
    assertEquals(listOf(heartRate, battery), session.services)
  }

  @Test
  fun `discovery needs a connection, and disconnecting clears the cache`() {
    val early = discoverResult()
    assertEquals(CoreError.Code.DISCONNECTED, (early.single().exceptionOrNull() as CoreError).code)

    device.services = listOf(heartRate)
    connect()
    linkUp()
    discoverResult()
    client.completeServiceDiscovery()
    assertEquals(listOf(heartRate), session.services)
    linkDown(0x13)
    assertEquals(emptyList<GattServiceInfo>(), session.services)
  }

  @Test
  fun `two operations in a row that time out reset the connection`() {
    connect()
    linkUp()
    discoverResult()
    executor.advanceBy(PeripheralSession.DISCOVERY_TIMEOUT_MS)
    assertEquals(SessionState.READY, session.state)
    discoverResult()
    executor.advanceBy(PeripheralSession.DISCOVERY_TIMEOUT_MS)
    assertEquals(SessionState.DISCONNECTED, session.state)
    assertEquals("state disconnected DISCONNECTED", log.last())
    assertClosedOnce(client)
  }
}
