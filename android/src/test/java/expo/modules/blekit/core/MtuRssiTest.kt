package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import expo.modules.blekit.core.fakes.service
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** P1-09: the MTU request during setup, requestMtu(), mtuChange and readRssi() on Android. */
class MtuRssiTest {
  private val executor = ManualExecutor()
  private val device = FakeRemoteDevice("C0:FF:EE:00:00:01").apply { services = listOf(service("180d")) }
  private val log = mutableListOf<String>()
  private val session = PeripheralSession(device.address, { device }, executor) { state, _ ->
    log += "state ${state.js}"
  }.apply {
    onMtuChange = { log += "mtu $it" }
    onWarning = { log += "warning ${it.code}" }
  }

  private val client: FakeGattClient get() = device.clients.last()

  private fun connect(requestMtu: Int? = ConnectSpec.DEFAULT_REQUESTED_MTU, autoDiscover: Boolean = true) {
    session.connect(ConnectSpec(15_000, autoDiscover = autoDiscover, requestMtu = requestMtu)) { error ->
      log += "connect ${error?.code ?: "ok"}"
    }
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    executor.runUntilIdle()
  }

  private fun mtuRequests() = client.calls.filterIsInstance<FakeGattClient.Call.RequestMtu>().map { it.mtu }

  private fun <T> outcome(start: ((Result<T>) -> Unit) -> Unit): () -> Result<T>? {
    var result: Result<T>? = null
    start { result = it }
    executor.runUntilIdle()
    return { result }
  }

  private fun code(result: Result<*>?) = (result?.exceptionOrNull() as? CoreError)?.code

  @Test
  fun `the MTU is requested after discovery and is set when connected`() {
    device.negotiatedMtu = 247
    connect()
    client.completeServiceDiscovery()
    executor.runUntilIdle()
    assertEquals("the request waits for discovery", listOf(517), mtuRequests())
    assertEquals(listOf("state connecting"), log)

    client.callback.onMtuChanged(247, GATT_SUCCESS)
    executor.runUntilIdle()
    assertEquals(SessionState.READY, session.state)
    assertEquals(247, session.mtu)
    assertEquals("no mtuChange before connected", listOf("state connecting", "state connected", "connect ok"), log)
  }

  @Test
  fun `without autoDiscover the MTU request follows link-up`() {
    connect(requestMtu = 185, autoDiscover = false)
    assertEquals(listOf(185), mtuRequests())
    client.callback.onMtuChanged(185, GATT_SUCCESS)
    executor.runUntilIdle()
    assertEquals(SessionState.READY, session.state)
    assertEquals(185, session.mtu)
  }

  @Test
  fun `requestMtu null skips the exchange`() {
    connect(requestMtu = null, autoDiscover = false)
    assertEquals(SessionState.READY, session.state)
    assertTrue(mtuRequests().isEmpty())
    assertEquals(PeripheralSession.DEFAULT_MTU, session.mtu)
  }

  @Test
  fun `a failed setup exchange is a warning, not a failed connect`() {
    connect(autoDiscover = false)
    client.callback.onMtuChanged(PeripheralSession.DEFAULT_MTU, 0x06)
    executor.runUntilIdle()
    assertEquals(SessionState.READY, session.state)
    assertEquals(PeripheralSession.DEFAULT_MTU, session.mtu)
    assertEquals(listOf("state connecting", "warning NOT_SUPPORTED", "state connected", "connect ok"), log)
  }

  @Test
  fun `a stuck setup exchange times out into a warning`() {
    connect(autoDiscover = false)
    executor.advanceBy(GattQueue.DEFAULT_TIMEOUT_MS)
    assertEquals(SessionState.READY, session.state)
    assertEquals("warning OPERATION_TIMEOUT", log[1])
  }

  @Test
  fun `a link loss during the exchange fails the connect`() {
    connect(autoDiscover = false)
    client.callback.onConnectionStateChange(0x08, ConnectionStates.DISCONNECTED)
    executor.runUntilIdle()
    assertEquals(SessionState.DISCONNECTED, session.state)
    assertTrue("the connect failed", log.last { it.startsWith("connect") } != "connect ok")
    assertTrue(log.none { it.startsWith("warning") })
  }

  @Test
  fun `requestMtu negotiates and fires mtuChange`() {
    connect(requestMtu = null, autoDiscover = false)
    client.respondsAutomatically = true
    device.negotiatedMtu = 247
    val result = outcome { session.requestMtu(512, null, it) }
    assertEquals(247, result()?.getOrThrow())
    assertEquals(247, session.mtu)
    assertEquals("mtu 247", log.last())

    val same = outcome { session.requestMtu(512, null, it) }
    assertEquals(247, same()?.getOrThrow())
    assertEquals("no event without a change", 1, log.count { it.startsWith("mtu") })
  }

  @Test
  fun `requestMtu checks its range before the radio`() {
    connect(requestMtu = null, autoDiscover = false)
    assertEquals(CoreError.Code.INVALID_ARGUMENT, code(outcome { session.requestMtu(22, null, it) }()))
    assertEquals(CoreError.Code.INVALID_ARGUMENT, code(outcome { session.requestMtu(518, null, it) }()))
    assertTrue(mtuRequests().isEmpty())
  }

  @Test
  fun `an MTU change the peer starts is reported`() {
    connect(requestMtu = null, autoDiscover = false)
    client.callback.onMtuChanged(100, GATT_SUCCESS)
    assertEquals(100, session.mtu)
    assertEquals("mtu 100", log.last())
  }

  @Test
  fun `the MTU goes back to 23 after a disconnect`() {
    connect(autoDiscover = false)
    client.callback.onMtuChanged(517, GATT_SUCCESS)
    executor.runUntilIdle()
    assertEquals(517, session.mtu)
    client.callback.onConnectionStateChange(0x08, ConnectionStates.DISCONNECTED)
    assertEquals(PeripheralSession.DEFAULT_MTU, session.mtu)
  }

  @Test
  fun `readRssi reads the link RSSI`() {
    connect(requestMtu = null, autoDiscover = false)
    client.respondsAutomatically = true
    device.rssi = -71
    assertEquals(-71, outcome { session.readRssi(null, it) }()?.getOrThrow())

    client.respondsAutomatically = false
    val failed = outcome { session.readRssi(null, it) }
    client.callback.onReadRemoteRssi(0, PeripheralSession.GATT_ERROR)
    executor.runUntilIdle()
    assertEquals(CoreError.Code.GATT_ERROR, code(failed()))
  }

  @Test
  fun `MTU and RSSI need a connection`() {
    assertEquals(CoreError.Code.DISCONNECTED, code(outcome { session.requestMtu(185, null, it) }()))
    assertEquals(CoreError.Code.DISCONNECTED, code(outcome { session.readRssi(null, it) }()))
  }
}
