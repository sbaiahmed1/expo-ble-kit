package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeBluetoothAdapter
import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeL2capSocket
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import expo.modules.blekit.core.fakes.ManualRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/** P5-03: L2CAP channels and servers (plan §5.5 L2CAP rules). */
class L2capTest {
  private val executor = ManualExecutor()
  private val runner = ManualRunner()
  private val device = FakeRemoteDevice("C0:FF:EE:00:00:01")
  private val session = PeripheralSession(device.address, { device }, executor) { _, _ -> }.also {
    it.runner = runner
  }

  private val client: FakeGattClient get() = device.clients.last()
  private val socket: FakeL2capSocket get() = device.l2capSockets.last()

  private fun connect() {
    session.connect(ConnectSpec(15_000, autoDiscover = false, requestMtu = null)) {}
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    executor.runUntilIdle()
  }

  private fun code(result: Result<*>?) = result?.let { (it.exceptionOrNull() as? CoreError)?.code?.value ?: "ok" }

  private fun open(psm: Int = 0x81, timeoutMs: Long? = null, operationId: Int? = null): () -> Result<L2capChannel>? {
    var result: Result<L2capChannel>? = null
    session.openL2capChannel(psm, secure = false, timeoutMs, { result = it }, operationId)
    executor.runUntilIdle()
    return { result }
  }

  private fun openChannel(): L2capChannel {
    val pending = open()
    runner.runAll()
    executor.runUntilIdle()
    return pending()!!.getOrThrow()
  }

  /** What a channel's listener heard. */
  private class Heard : L2capChannel.Listener {
    val data = mutableListOf<List<Byte>>()
    val closes = mutableListOf<String>()

    override fun onData(data: ByteArray) {
      this.data += data.toList()
    }

    override fun onClosed(error: CoreError?) {
      closes += error?.code?.value ?: "none"
    }
  }

  private fun write(channel: L2capChannel, vararg bytes: Int): () -> String? {
    var result: String? = null
    channel.write(ByteArray(bytes.size) { bytes[it].toByte() }) { result = code(it) }
    return { result }
  }

  private fun bytes(vararg values: Int) = values.map { it.toByte() }

  @Test
  fun `a channel opens on a ready connection, and a refusal or a failed connect is L2CAP_FAILED`() {
    assertEquals("DISCONNECTED", code(open()()))
    connect()
    val pending = open(0x81)
    assertEquals(listOf("blekit-l2cap-connect"), runner.waiting)
    assertFalse(socket.secure)
    assertNull(pending())
    runner.runAll()
    executor.runUntilIdle()
    val channel = pending()!!.getOrThrow()
    assertEquals(0x81, channel.psm)
    assertEquals(device.address, channel.peerId)
    assertTrue(socket.connected)

    device.refuseL2cap = true
    assertEquals("L2CAP_FAILED", code(open()()))
    device.refuseL2cap = false
    val failing = open()
    socket.connectFailure = IOException("refused by the peer")
    runner.runAll()
    executor.runUntilIdle()
    assertEquals("L2CAP_FAILED", code(failing()))
    assertTrue(socket.closed)
  }

  @Test
  fun `an open that times out or is cancelled closes its socket, which aborts the connect`() {
    connect()
    val slow = open(timeoutMs = 1_000)
    val slowSocket = socket
    slowSocket.connectBlocks = true
    runner.runAll()
    executor.advanceBy(999)
    assertNull(slow())
    executor.advanceBy(1)
    assertEquals("OPERATION_TIMEOUT", code(slow()))
    assertTrue(slowSocket.closed)

    val cancelled = open(operationId = 7)
    session.cancel(7)
    assertEquals("OPERATION_CANCELLED", code(cancelled()))
    assertTrue(socket.closed)
    // The aborted connects report back and change nothing.
    slowSocket.connectBlocks = false
    runner.runAll()
    executor.runUntilIdle()
    assertEquals("OPERATION_TIMEOUT", code(slow()))
  }

  @Test
  fun `reading starts with receive and ends at the peer's close`() {
    connect()
    val channel = openChannel()
    val heard = Heard().also { channel.listener = it }
    socket.incoming += byteArrayOf(1, 2, 3)
    runner.runAll()
    assertTrue(runner.waiting.isEmpty())

    channel.receive()
    runner.runAll()
    executor.runUntilIdle()
    assertEquals(listOf(bytes(1, 2, 3)), heard.data)
    assertEquals(listOf("blekit-l2cap-read"), runner.waiting)

    socket.incoming += byteArrayOf(4)
    socket.peerClosed = true
    runner.runAll()
    executor.runUntilIdle()
    assertEquals(listOf(bytes(1, 2, 3), bytes(4)), heard.data)
    assertEquals(listOf("none"), heard.closes)
    assertFalse(channel.isOpen)
    assertEquals("L2CAP_FAILED", write(channel, 1)())
  }

  @Test
  fun `writes go out in packet-size pieces, in order, on one writer`() {
    connect()
    val channel = openChannel()
    val first = write(channel, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    val second = write(channel, 11, 12, 13)
    assertEquals(listOf("blekit-l2cap-write"), runner.waiting)
    runner.runAll()
    executor.runUntilIdle()
    assertEquals(listOf(bytes(1, 2, 3, 4), bytes(5, 6, 7, 8), bytes(9, 10), bytes(11, 12, 13)), socket.writes)
    assertEquals("ok", first())
    assertEquals("ok", second())
    assertEquals("ok", write(channel)())
  }

  @Test
  fun `a write the stack takes nothing of for 10 s closes the channel`() {
    connect()
    val channel = openChannel()
    val heard = Heard().also { channel.listener = it }
    socket.writeBlocks = true
    val stalled = write(channel, 1, 2, 3, 4, 5, 6, 7, 8)
    val queued = write(channel, 9)
    runner.runAll()
    executor.advanceBy(L2capChannel.WRITE_STALL_MS - 1)
    assertNull(stalled())
    executor.advanceBy(1)
    assertEquals("OPERATION_TIMEOUT", stalled())
    assertEquals("OPERATION_TIMEOUT", queued())
    assertEquals(listOf("OPERATION_TIMEOUT"), heard.closes)
    assertTrue(socket.closed)
  }

  @Test
  fun `each piece the stack takes restarts the stall timer`() {
    connect()
    val channel = openChannel()
    val socket = socket
    socket.writeBlocks = true
    val slow = write(channel, 1, 2, 3, 4, 5, 6, 7, 8)
    executor.advanceBy(9_000)
    socket.writeBlocks = false
    socket.maxTransmitPacketSize = 4
    runner.runAll()
    executor.runUntilIdle()
    assertEquals("ok", slow())
    assertTrue(channel.isOpen)
    executor.advanceBy(20_000)
    assertTrue(channel.isOpen)
  }

  @Test
  fun `a failed write closes the channel and fails the writes behind it`() {
    connect()
    val channel = openChannel()
    val heard = Heard().also { channel.listener = it }
    socket.writeFailure = IOException("broken pipe")
    val first = write(channel, 1)
    val second = write(channel, 2)
    runner.runAll()
    executor.runUntilIdle()
    assertEquals("L2CAP_FAILED", first())
    assertEquals("L2CAP_FAILED", second())
    assertEquals(listOf("L2CAP_FAILED"), heard.closes)
  }

  @Test
  fun `channels and opens end with the connection, with the adapter's error when Bluetooth went off`() {
    connect()
    val channel = openChannel()
    val heard = Heard().also { channel.listener = it }
    val pending = open()
    session.disconnect {}
    assertEquals(listOf("DISCONNECTED"), heard.closes)
    assertEquals("DISCONNECTED", code(pending()))
    assertTrue(device.l2capSockets.all { it.closed })
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.DISCONNECTED)
    executor.runUntilIdle()

    connect()
    val again = openChannel()
    val heardAgain = Heard().also { again.listener = it }
    session.forceDisconnected(CoreError(CoreError.Code.BLUETOOTH_POWERED_OFF, "Bluetooth is off"))
    assertEquals(listOf("BLUETOOTH_POWERED_OFF"), heardAgain.closes)
  }

  private class Permissions(override val sdkInt: Int, connect: Boolean = true) : PermissionSystem {
    private val granted = if (connect) setOf(AndroidPermissions.BLUETOOTH_CONNECT) else emptySet()

    override fun declaredPermissions() = DeclaredPermissions(
      setOf(AndroidPermissions.BLUETOOTH_SCAN, AndroidPermissions.BLUETOOTH_CONNECT),
      scanNeverForLocation = true,
    )

    override fun isGranted(permission: String) = permission in granted
  }

  private fun engine(adapter: FakeBluetoothAdapter, permissions: Permissions) =
    CentralEngine(adapter, permissions, executor, EpochClock(0, 0), runner = runner).apply { start() }

  @Test
  fun `a server accepts channels and closes them with itself or with Bluetooth`() {
    val adapter = FakeBluetoothAdapter()
    val engine = engine(adapter, Permissions(sdkInt = 34))
    val server = engine.publishL2capChannel(secure = true)
    val socket = adapter.l2capServers.single()
    assertEquals(0x80, server.psm)
    assertTrue(socket.secure)
    val accepted = mutableListOf<L2capChannel>()
    server.listener = L2capServer.Listener { accepted += it }
    server.start()
    val central = FakeL2capSocket("aa:bb:cc:dd:ee:ff", 0x80, secure = true)
    socket.incoming += central
    runner.runAll()
    executor.runUntilIdle()
    assertEquals(listOf("AA:BB:CC:DD:EE:FF"), accepted.map { it.peerId })
    val heard = Heard().also { accepted.single().listener = it }

    server.close(null)
    assertEquals(listOf("none"), heard.closes)
    assertTrue(central.closed)
    assertTrue(socket.closed)

    val second = engine.publishL2capChannel(secure = false)
    second.listener = L2capServer.Listener { accepted += it }
    second.start()
    adapter.l2capServers.last().incoming += FakeL2capSocket("aa:bb:cc:dd:ee:01", 0x81, secure = false)
    runner.runAll()
    executor.runUntilIdle()
    val heardSecond = Heard().also { accepted.last().listener = it }
    adapter.simulateState(AdapterStates.OFF)
    assertEquals(listOf("BLUETOOTH_POWERED_OFF"), heardSecond.closes)
    assertFalse(second.isOpen)
  }

  @Test
  fun `a server closes a channel nobody listens for`() {
    val adapter = FakeBluetoothAdapter()
    val server = engine(adapter, Permissions(sdkInt = 34)).publishL2capChannel(secure = false)
    server.start()
    val central = FakeL2capSocket("aa:bb:cc:dd:ee:ff", 0x80, secure = false)
    adapter.l2capServers.single().incoming += central
    runner.runAll()
    executor.runUntilIdle()
    assertTrue(central.closed)
  }

  @Test
  fun `L2CAP needs Android 10, the connect permission and a valid PSM`() {
    fun failure(block: () -> Unit) = try {
      block()
      "ok"
    } catch (error: CoreError) {
      error.code.value
    }

    val adapter = FakeBluetoothAdapter()
    assertEquals("NOT_SUPPORTED", failure { engine(adapter, Permissions(sdkInt = 28)).publishL2capChannel(true) })
    assertEquals(
      "PERMISSION_DENIED",
      failure { engine(adapter, Permissions(sdkInt = 34, connect = false)).publishL2capChannel(true) },
    )

    val engine = engine(adapter, Permissions(sdkInt = 34))
    var result: Result<L2capChannel>? = null
    engine.openL2capChannel("C0:FF:EE:00:00:02", 0, secure = true, timeoutMs = null, completion = { result = it })
    assertEquals("INVALID_ARGUMENT", code(result))
    engine.openL2capChannel("C0:FF:EE:00:00:02", 0x81, secure = true, timeoutMs = null, completion = { result = it })
    assertEquals("DISCONNECTED", code(result))
    engine(adapter, Permissions(sdkInt = 28)).openL2capChannel(
      "C0:FF:EE:00:00:02",
      0x81,
      secure = true,
      timeoutMs = null,
      completion = { result = it },
    )
    assertEquals("NOT_SUPPORTED", code(result))
  }
}
