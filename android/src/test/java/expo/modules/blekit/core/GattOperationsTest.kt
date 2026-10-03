package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.UUID

/** P1-07: reads, writes and descriptors on Android, through the queue. */
class GattOperationsTest {
  private fun uuid(short: String) = UUID.fromString("0000$short-0000-1000-8000-00805f9b34fb")

  private val testService = UUID.fromString("0c6c1000-b347-4cfa-9827-1c5a13658519")
  private val staticRead = UUID.fromString("0c6c1001-b347-4cfa-9827-1c5a13658519")
  private val echoWrite = UUID.fromString("0c6c1003-b347-4cfa-9827-1c5a13658519")
  private val sink = UUID.fromString("0c6c1005-b347-4cfa-9827-1c5a13658519")
  private val stream = UUID.fromString("0c6c1007-b347-4cfa-9827-1c5a13658519")
  private val userDescription = uuid("2901")

  private fun characteristic(uuid: UUID, properties: Int, vararg descriptors: UUID) =
    GattCharacteristicInfo(GattCharacteristicRef(testService, 0, uuid, 0), properties, descriptors.toList())

  private val profile = GattServiceInfo(
    testService,
    0,
    true,
    listOf(
      characteristic(staticRead, CharacteristicProperties.READ),
      characteristic(echoWrite, CharacteristicProperties.WRITE),
      characteristic(sink, CharacteristicProperties.WRITE_NO_RESPONSE),
      characteristic(stream, CharacteristicProperties.NOTIFY, uuid("2902"), userDescription),
    ),
  )

  private val executor = ManualExecutor()
  private val device = FakeRemoteDevice("C0:FF:EE:00:00:01").apply { services = listOf(profile) }
  private val session = PeripheralSession(device.address, { device }, executor) { _, _ -> }
  private lateinit var client: FakeGattClient

  private fun ref(characteristic: UUID) = profile.characteristics.first { it.ref.uuid == characteristic }.ref

  @Before
  fun connectAndDiscover() {
    session.connect(ConnectSpec(15_000, requestMtu = null)) {}
    client = device.clients.single()
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    executor.runUntilIdle()
    client.completeServiceDiscovery()
    assertEquals(SessionState.READY, session.state)
    client.calls.clear()
  }

  private fun <T> outcome(start: ((Result<T>) -> Unit) -> Unit): () -> Result<T>? {
    var result: Result<T>? = null
    start { result = it }
    executor.runUntilIdle()
    return { result }
  }

  private fun code(result: Result<*>?) = (result?.exceptionOrNull() as? CoreError)?.code

  @Test
  fun `reads return the value`() {
    device.values[ref(staticRead)] = ByteArray(20) { it.toByte() }
    client.respondsAutomatically = true
    val read = outcome { session.read(testService, staticRead, null, it) }
    assertArrayEquals(ByteArray(20) { it.toByte() }, read()?.getOrThrow())
    assertEquals(listOf(FakeGattClient.Call.Read(ref(staticRead))), client.calls)
  }

  @Test
  fun `ATT errors map to codes`() {
    val read = outcome { session.read(testService, staticRead, null, it) }
    client.callback.onCharacteristicRead(ref(staticRead), ByteArray(0), 0x05)
    assertEquals(CoreError.Code.INSUFFICIENT_AUTHENTICATION, code(read()))
    assertEquals(5, (read()?.exceptionOrNull() as CoreError).gattStatus)
  }

  @Test
  fun `properties, attributes and the connection are checked before the radio is used`() {
    assertEquals(CoreError.Code.READ_NOT_PERMITTED, code(outcome { session.read(testService, echoWrite, null, it) }()))
    assertEquals(
      CoreError.Code.WRITE_NOT_PERMITTED,
      code(outcome { session.write(testService, staticRead, byteArrayOf(1), true, null, it) }()),
    )
    assertEquals(
      CoreError.Code.WRITE_NOT_PERMITTED,
      code(outcome { session.write(testService, echoWrite, byteArrayOf(1), false, null, it) }()),
    )
    assertEquals(CoreError.Code.SERVICE_NOT_FOUND, code(outcome { session.read(uuid("180d"), staticRead, null, it) }()))
    assertEquals(
      CoreError.Code.CHARACTERISTIC_NOT_FOUND,
      code(
        outcome {
          session.read(testService, uuid("2a37"), null, it)
        }(),
      ),
    )
    assertEquals(
      CoreError.Code.DESCRIPTOR_NOT_FOUND,
      code(outcome { session.readDescriptor(testService, stream, uuid("2904"), null, it) }()),
    )
    assertTrue(client.calls.isEmpty())

    client.callback.onConnectionStateChange(0x08, ConnectionStates.DISCONNECTED)
    assertEquals(CoreError.Code.DISCONNECTED, code(outcome { session.read(testService, staticRead, null, it) }()))
  }

  @Test
  fun `writes with response take up to 512 bytes`() {
    client.respondsAutomatically = true
    val long = ByteArray(512) { (it * 31 + 7).toByte() }
    val write = outcome { session.write(testService, echoWrite, long, true, null, it) }
    assertTrue(write()!!.isSuccess)
    val call = client.calls.single() as FakeGattClient.Call.Write
    assertEquals(WriteTypes.DEFAULT, call.writeType)
    assertEquals(long.toList(), call.value)

    val tooLong = outcome { session.write(testService, echoWrite, ByteArray(513), true, null, it) }
    assertEquals(CoreError.Code.INVALID_ATTRIBUTE_LENGTH, code(tooLong()))
  }

  @Test
  fun `writes without response fit one packet and retry a busy stack`() {
    val tooLong = outcome { session.write(testService, sink, ByteArray(21), false, null, it) }
    assertEquals("MTU 23 leaves 20 bytes", CoreError.Code.INVALID_ATTRIBUTE_LENGTH, code(tooLong()))

    client.nextWriteStatus = SubmitStatus.ERROR_GATT_WRITE_REQUEST_BUSY
    val write = outcome { session.write(testService, sink, ByteArray(20), false, null, it) }
    executor.advanceBy(PeripheralSession.BUSY_RETRY_DELAY_MS)
    client.nextWriteStatus = SubmitStatus.SUCCESS
    executor.advanceBy(PeripheralSession.BUSY_RETRY_DELAY_MS)
    assertEquals(3, client.calls.size)
    assertEquals(WriteTypes.NO_RESPONSE, (client.calls.last() as FakeGattClient.Call.Write).writeType)
    client.callback.onCharacteristicWrite(ref(sink), GATT_SUCCESS)
    assertTrue(write()!!.isSuccess)
  }

  @Test
  fun `a congested write without response succeeded, and the next packet waits`() {
    val first = outcome { session.write(testService, sink, ByteArray(20), false, null, it) }
    client.callback.onCharacteristicWrite(ref(sink), WriteStatuses.CONGESTED)
    assertTrue("the stack took the packet", first()!!.isSuccess)

    val second = outcome { session.write(testService, sink, ByteArray(20), false, null, it) }
    assertEquals("nothing sent on a congested link yet", 1, client.calls.size)
    executor.advanceBy(PeripheralSession.CONGESTION_RETRY_DELAY_MS)
    assertEquals(2, client.calls.size)
    client.callback.onCharacteristicWrite(ref(sink), GATT_SUCCESS)
    assertTrue(second()!!.isSuccess)

    outcome<Unit> { session.write(testService, sink, ByteArray(20), false, null, it) }
    assertEquals("no pause once the link took a packet normally", 3, client.calls.size)
  }

  @Test
  fun `a packet refused on a congested link is sent again until the timeout`() {
    val write = outcome { session.write(testService, sink, byteArrayOf(1, 2, 3), false, 100, it) }
    client.callback.onCharacteristicWrite(ref(sink), WriteStatuses.INTERNAL_ERROR)
    assertEquals("not failed: nothing was sent", null, write())
    executor.advanceBy(PeripheralSession.CONGESTION_RETRY_DELAY_MS)
    assertEquals(2, client.calls.size)
    assertEquals(listOf<Byte>(1, 2, 3), (client.calls.last() as FakeGattClient.Call.Write).value)
    client.callback.onCharacteristicWrite(ref(sink), WriteStatuses.INTERNAL_ERROR)
    executor.advanceBy(PeripheralSession.CONGESTION_RETRY_DELAY_MS)
    assertEquals(3, client.calls.size)

    executor.advanceBy(100)
    assertEquals(CoreError.Code.OPERATION_TIMEOUT, code(write()))
    client.callback.onCharacteristicWrite(ref(sink), WriteStatuses.INTERNAL_ERROR)
    executor.advanceBy(1_000)
    assertEquals("nothing sent after the timeout", 3, client.calls.size)
  }

  @Test
  fun `a write with response still fails on those statuses`() {
    val write = outcome { session.write(testService, echoWrite, byteArrayOf(1), true, null, it) }
    client.callback.onCharacteristicWrite(ref(echoWrite), WriteStatuses.INTERNAL_ERROR)
    assertEquals(CoreError.Code.GATT_ERROR, code(write()))
  }

  @Test
  fun `64 KB through a congested link arrive complete and in order`() {
    val packets = (0 until 65_536 / 16).map { n -> ByteArray(16) { (n * 16 + it).toByte() } }
    val results = packets.map { packet -> outcome { session.write(testService, sink, packet, false, null, it) } }
    val received = mutableListOf<Byte>()
    var answered = 0
    while (answered < client.calls.size || results.any { it() == null }) {
      executor.advanceBy(PeripheralSession.CONGESTION_RETRY_DELAY_MS)
      while (answered < client.calls.size) {
        val call = client.calls[answered++] as FakeGattClient.Call.Write
        // Every 7th packet congests the link; the packet after it is refused once.
        val status = when {
          answered % 7 == 0 -> WriteStatuses.CONGESTED
          answered % 7 == 1 && answered > 1 -> WriteStatuses.INTERNAL_ERROR
          else -> GATT_SUCCESS
        }
        if (status != WriteStatuses.INTERNAL_ERROR) received += call.value
        client.callback.onCharacteristicWrite(ref(sink), status)
        executor.runUntilIdle()
      }
    }
    assertTrue(results.all { it()!!.isSuccess })
    assertEquals(packets.flatMap { it.toList() }, received)
  }

  @Test
  fun `a refused write fails with the mapped status`() {
    client.nextWriteStatus = 200 // BluetoothStatusCodes.ERROR_GATT_WRITE_NOT_ALLOWED
    val write = outcome { session.write(testService, echoWrite, byteArrayOf(1), true, null, it) }
    assertEquals(CoreError.Code.WRITE_NOT_PERMITTED, code(write()))
  }

  @Test
  fun `descriptors are read and written, but not the CCCD`() {
    client.respondsAutomatically = true
    val read = outcome { session.readDescriptor(testService, stream, userDescription, null, it) }
    assertTrue(read()!!.isSuccess)
    val write =
      outcome { session.writeDescriptor(testService, stream, userDescription, "Stream".toByteArray(), null, it) }
    assertTrue(write()!!.isSuccess)
    assertEquals(
      FakeGattClient.Call.WriteDescriptor(
        GattDescriptorRef(ref(stream), userDescription),
        "Stream".toByteArray().toList(),
      ),
      client.calls.last(),
    )

    val cccd = outcome { session.writeDescriptor(testService, stream, uuid("2902"), byteArrayOf(1, 0), null, it) }
    assertEquals(CoreError.Code.INVALID_ARGUMENT, code(cccd()))
  }

  @Test
  fun `operations wait for each other`() {
    val first = outcome { session.read(testService, staticRead, null, it) }
    val second = outcome { session.write(testService, echoWrite, byteArrayOf(1), true, null, it) }
    assertEquals("one at a time", 1, client.calls.size)
    client.callback.onCharacteristicRead(ref(staticRead), byteArrayOf(9), GATT_SUCCESS)
    executor.runUntilIdle()
    assertArrayEquals(byteArrayOf(9), first()?.getOrThrow())
    assertEquals(2, client.calls.size)
    client.callback.onCharacteristicWrite(ref(echoWrite), GATT_SUCCESS)
    assertTrue(second()!!.isSuccess)
  }

  @Test
  fun `operations are cancelled by the id JS gave them`() {
    val running = outcome { session.read(testService, staticRead, null, it, operationId = 1) }
    val queued = outcome { session.write(testService, echoWrite, byteArrayOf(1), true, null, it, operationId = 2) }
    session.cancel(2)
    assertEquals(CoreError.Code.OPERATION_CANCELLED, code(queued()))

    session.cancel(1)
    assertEquals("answered at once", CoreError.Code.OPERATION_CANCELLED, code(running()))
    val next = outcome { session.read(testService, staticRead, null, it) }
    assertEquals("the radio is still busy with the read", 1, client.calls.size)
    // The radio answers the cancelled read (discarded), then the next read runs.
    client.callback.onCharacteristicRead(ref(staticRead), byteArrayOf(8), GATT_SUCCESS)
    executor.runUntilIdle()
    client.callback.onCharacteristicRead(ref(staticRead), byteArrayOf(9), GATT_SUCCESS)
    executor.runUntilIdle()
    assertArrayEquals(byteArrayOf(9), next()?.getOrThrow())
    assertTrue("the cancelled write never ran", client.calls.none { it is FakeGattClient.Call.Write })

    session.cancel(1)
    session.cancel(42)
    assertEquals("finished and unknown ids do nothing", CoreError.Code.OPERATION_CANCELLED, code(running()))
  }
}
