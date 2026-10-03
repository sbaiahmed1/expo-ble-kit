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

/** P3-03: the foreground service runs exactly while a `keepAliveInBackground` connection is open. */
class KeepAliveTest {
  private val testService = UUID.fromString("0c6c1000-b347-4cfa-9827-1c5a13658519")
  private val profile = GattServiceInfo(testService, 0, true, emptyList())

  private val executor = ManualExecutor()
  private val adapter = FakeBluetoothAdapter(state = AdapterStates.ON)
  private val first = "C0:FF:EE:00:00:01"
  private val second = "C0:FF:EE:00:00:02"
  private val devices = listOf(first, second).associateWith { address ->
    FakeRemoteDevice(address).apply { services = listOf(profile) }.also { adapter.devices[address] = it }
  }
  private val port = FakeKeepAlive()
  private val engine = CentralEngine(adapter, Granted, executor, EpochClock(0, 0), keepAlive = port)
  private val warnings = mutableListOf<String>()

  private class FakeKeepAlive : KeepAlivePort {
    val calls = mutableListOf<String>()
    var missing: String? = null
    var refuse = false

    override fun missingDeclaration() = missing

    override fun start(notification: KeepAliveNotification) {
      if (refuse) {
        throw CoreError(CoreError.Code.FOREGROUND_SERVICE_FAILED, "the app is in the background")
      }
      calls += "start ${notification.title}"
    }

    override fun update(notification: KeepAliveNotification) {
      calls += "update ${notification.title}"
    }

    override fun stop() {
      calls += "stop"
    }

    override var onStopped: ((CoreError?) -> Unit)? = null
  }

  private object Granted : PermissionSystem {
    override val sdkInt = 34

    override fun declaredPermissions() = DeclaredPermissions(
      setOf(AndroidPermissions.BLUETOOTH_SCAN, AndroidPermissions.BLUETOOTH_CONNECT),
      scanNeverForLocation = true,
    )

    override fun isGranted(permission: String) = true
  }

  @Before
  fun start() {
    engine.listener = object : CentralEngine.Listener {
      override fun onStateChange(state: BleState) = Unit

      override fun onScanResults(sessionId: Int, results: List<Map<String, Any?>>) = Unit

      override fun onScanError(sessionId: Int, error: CoreError) = Unit

      override fun onWarning(warning: CoreError) {
        warnings += warning.code.value
      }

      override fun onNotification(
        peripheralId: String,
        service: UUID,
        characteristic: UUID,
        value: ByteArray,
        timestamp: Double,
      ) = Unit

      override fun onMtuChange(peripheralId: String, mtu: Int) = Unit

      override fun onSubscriptionEnded(peripheralId: String, subscriptionId: Int, error: CoreError) = Unit

      override fun onNotificationBatch(peripheralId: String, subscriptionId: Int, batch: NotificationBatch) = Unit

      override fun onServicesChanged(peripheralId: String) = Unit

      override fun onConnectionStateChange(peripheralId: String, state: SessionState, error: CoreError?) = Unit
    }
    engine.start()
  }

  private fun client(address: String): FakeGattClient = devices.getValue(address).clients.last()

  private fun connect(
    address: String,
    keepAlive: Boolean = true,
    reconnect: ReconnectPolicy? = null,
    timeoutMs: Long? = 5_000,
  ): () -> CoreError? {
    var result: Result<CoreError?>? = null
    engine.connect(
      address,
      ConnectSpec(timeoutMs, requestMtu = null, reconnect = reconnect, keepAliveInBackground = keepAlive),
    ) { result = Result.success(it) }
    return { result?.getOrNull() }
  }

  private fun linkUp(address: String) {
    client(address).respondsAutomatically = true
    client(address).callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    executor.runUntilIdle()
  }

  private fun disconnect(address: String) {
    engine.disconnect(address) {}
    client(address).callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.DISCONNECTED)
    executor.runUntilIdle()
  }

  private val running get() = (engine.diagnostics()["android"] as Map<*, *>)["foregroundService"]

  @Test
  fun `the service starts with the first keep-alive connection and stops when the last one ends`() {
    connect(first)
    assertEquals("started while still connecting", listOf("start null"), port.calls)
    linkUp(first)
    connect(second)
    linkUp(second)
    assertEquals("one service for both", listOf("start null"), port.calls)
    assertEquals(true, running)

    disconnect(first)
    assertEquals(listOf("start null"), port.calls)
    disconnect(second)
    assertEquals(listOf("start null", "stop"), port.calls)
    assertEquals(false, running)
  }

  @Test
  fun `a link loss and reconnection keep the service running without a restart`() {
    connect(first, reconnect = ReconnectPolicy(maxAttempts = 3))
    linkUp(first)
    client(first).callback.onConnectionStateChange(0x08, ConnectionStates.DISCONNECTED)
    executor.runUntilIdle()
    assertEquals("reconnecting", engine.connectionState(first))
    executor.advanceBy(1_000)
    linkUp(first)
    assertEquals("connected", engine.connectionState(first))
    assertEquals(listOf("start null"), port.calls)

    // Giving up ends the connection, and with it the service.
    client(first).callback.onConnectionStateChange(0x08, ConnectionStates.DISCONNECTED)
    executor.runUntilIdle()
    repeat(3) {
      executor.advanceBy(30_000)
      executor.advanceBy(5_000)
    }
    assertEquals("disconnected", engine.connectionState(first))
    assertEquals(listOf("start null", "stop"), port.calls)
  }

  @Test
  fun `connections without keep-alive never start it, and a failed connect releases it`() {
    connect(first, keepAlive = false)
    linkUp(first)
    assertEquals(emptyList<String>(), port.calls)

    val failed = connect(second, timeoutMs = 1_000)
    executor.advanceBy(1_000)
    assertEquals(CoreError.Code.CONNECTION_TIMEOUT, failed()?.code)
    assertEquals(listOf("start null", "stop"), port.calls)
  }

  @Test
  fun `a missing declaration rejects with MISCONFIGURED before connecting`() {
    port.missing = "the manifest lacks the ConnectionService"
    val error = runCatching { connect(first) }.exceptionOrNull() as CoreError
    assertEquals(CoreError.Code.MISCONFIGURED, error.code)
    assertTrue(error.message!!.contains("the manifest lacks the ConnectionService"))
    assertTrue(error.message!!.contains("android.foregroundService"))
    assertEquals("no GATT client", 0, devices.getValue(first).clients.size)
    connect(first, keepAlive = false)
    assertEquals("only keep-alive needs it", 1, devices.getValue(first).clients.size)
  }

  @Test
  fun `a refused start is a warning, and the connection goes on without it`() {
    port.refuse = true
    val result = connect(first)
    linkUp(first)
    assertNull(result())
    assertEquals("connected", engine.connectionState(first))
    assertEquals(listOf("FOREGROUND_SERVICE_FAILED"), warnings)
    assertEquals(false, running)

    // The next keep-alive connect tries again.
    port.refuse = false
    connect(second)
    assertEquals(listOf("start null"), port.calls)
  }

  @Test
  fun `a later refusal from Android is a warning too, and the next connect retries`() {
    connect(first)
    port.onStopped?.invoke(CoreError(CoreError.Code.FOREGROUND_SERVICE_FAILED, "SecurityException"))
    assertEquals(listOf("FOREGROUND_SERVICE_FAILED"), warnings)
    assertEquals(false, running)
    connect(second)
    assertEquals(listOf("start null", "start null"), port.calls)
  }

  @Test
  fun `the notification is set before the start and updated while running`() {
    engine.setKeepAliveNotification(KeepAliveNotification(title = "Sensor"))
    connect(first)
    engine.setKeepAliveNotification(KeepAliveNotification(title = "Sensor, 1 device"))
    assertEquals(listOf("start Sensor", "update Sensor, 1 device"), port.calls)
  }

  @Test
  fun `closing the engine stops the service`() {
    connect(first)
    engine.close()
    assertEquals(listOf("start null", "stop"), port.calls)
  }

  @Test
  fun `what the manifest needs, by API level`() {
    val all = setOf(KeepAlivePermissions.FOREGROUND_SERVICE, KeepAlivePermissions.FOREGROUND_SERVICE_CONNECTED_DEVICE)
    assertNull(missingKeepAliveDeclarations(34, all, serviceDeclared = true, serviceIsConnectedDevice = true))
    assertEquals(
      "the manifest lacks the ConnectionService",
      missingKeepAliveDeclarations(34, all, serviceDeclared = false, serviceIsConnectedDevice = false),
    )
    assertEquals(
      "the manifest lacks android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE",
      missingKeepAliveDeclarations(
        34,
        setOf(KeepAlivePermissions.FOREGROUND_SERVICE),
        serviceDeclared = true,
        serviceIsConnectedDevice = true,
      ),
    )
    assertNull(
      "API 33 doesn't know the type permission",
      missingKeepAliveDeclarations(
        33,
        setOf(KeepAlivePermissions.FOREGROUND_SERVICE),
        serviceDeclared = true,
        serviceIsConnectedDevice = true,
      ),
    )
    assertEquals(
      "the manifest lacks foregroundServiceType=\"connectedDevice\" on the ConnectionService",
      missingKeepAliveDeclarations(30, all, serviceDeclared = true, serviceIsConnectedDevice = false),
    )
    assertNull(
      "API 26-27: no FOREGROUND_SERVICE permission, no type",
      missingKeepAliveDeclarations(26, emptySet(), serviceDeclared = true, serviceIsConnectedDevice = false),
    )
  }
}
