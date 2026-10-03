package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.UUID

/** P2-03: writeStream on Android: chunks through the queue, progress, abort, failures. */
class WriteStreamTest {
  private val testService = UUID.fromString("0c6c1000-b347-4cfa-9827-1c5a13658519")
  private val staticRead = UUID.fromString("0c6c1001-b347-4cfa-9827-1c5a13658519")
  private val echoWrite = UUID.fromString("0c6c1003-b347-4cfa-9827-1c5a13658519")
  private val sink = UUID.fromString("0c6c1005-b347-4cfa-9827-1c5a13658519")

  private fun characteristic(uuid: UUID, properties: Int) =
    GattCharacteristicInfo(GattCharacteristicRef(testService, 0, uuid, 0), properties, emptyList())

  private val profile = GattServiceInfo(
    testService,
    0,
    true,
    listOf(
      characteristic(staticRead, CharacteristicProperties.READ),
      characteristic(echoWrite, CharacteristicProperties.WRITE),
      characteristic(sink, CharacteristicProperties.WRITE_NO_RESPONSE),
    ),
  )

  private val executor = ManualExecutor()
  private val device = FakeRemoteDevice("C0:FF:EE:00:00:01").apply { services = listOf(profile) }
  private val session = PeripheralSession(device.address, { device }, executor) { _, _ -> }
  private lateinit var client: FakeGattClient
  private val progress = mutableListOf<Pair<Int, Int>>()
  private var result: Result<Unit>? = null

  @Before
  fun connect() {
    session.connect(ConnectSpec(15_000, requestMtu = null)) {}
    client = device.clients.single()
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    executor.runUntilIdle()
    client.completeServiceDiscovery()
    client.calls.clear()
  }

  private fun stream(
    data: ByteArray,
    characteristic: UUID = sink,
    withResponse: Boolean = false,
    chunkSize: Int? = null,
    timeoutMs: Long? = null,
  ) {
    session.writeStream(
      testService,
      characteristic,
      data,
      withResponse,
      chunkSize,
      timeoutMs,
      { sent, total -> progress += sent to total },
      { result = it },
      operationId = 7,
    )
    executor.runUntilIdle()
  }

  private fun writes() = client.calls.filterIsInstance<FakeGattClient.Call.Write>()

  private fun code() = (result?.exceptionOrNull() as? CoreError)?.code

  /** The radio takes the packet in flight. */
  private fun answer(status: Int = GATT_SUCCESS) {
    client.callback.onCharacteristicWrite(writes().last().ref, status)
    executor.runUntilIdle()
  }

  @Test
  fun `64 KB go out in packets of MTU minus 3, in order, with about 100 progress reports`() {
    client.respondsAutomatically = true
    val data = ByteArray(65_536) { (it * 7).toByte() }
    stream(data)
    assertTrue(result!!.isSuccess)
    assertEquals(65_536 / 20 + 1, writes().size)
    assertTrue(writes().all { it.value.size <= 20 && it.writeType == WriteTypes.NO_RESPONSE })
    assertEquals(data.toList(), writes().flatMap { it.value })
    assertEquals(65_536 to 65_536, progress.last())
    assertTrue("${progress.size} reports", progress.size in 90..101)
    assertEquals(progress.map { it.first }.sorted(), progress.map { it.first })
  }

  @Test
  fun `a chunk size and writes with response`() {
    client.respondsAutomatically = true
    stream(ByteArray(1_000) { it.toByte() }, echoWrite, withResponse = true, chunkSize = 300)
    assertTrue(result!!.isSuccess)
    assertEquals(listOf(300, 300, 300, 100), writes().map { it.value.size })
    assertTrue(writes().all { it.writeType == WriteTypes.DEFAULT })
    assertEquals(listOf(300 to 1_000, 600 to 1_000, 900 to 1_000, 1_000 to 1_000), progress)
  }

  @Test
  fun `operations issued during the stream wait for its end`() {
    stream(ByteArray(60))
    var read: Result<ByteArray>? = null
    session.read(testService, staticRead, null, { read = it })
    executor.runUntilIdle()
    repeat(3) { answer() }
    assertTrue(result!!.isSuccess)
    assertEquals(3, writes().size)
    assertTrue("the read only starts now", client.calls.last() is FakeGattClient.Call.Read)
    assertNull(read)
  }

  @Test
  fun `cancelling stops the stream within the chunk in flight`() {
    stream(ByteArray(200))
    answer()
    answer()
    session.cancel(7)
    assertEquals(CoreError.Code.OPERATION_CANCELLED, code())
    assertEquals(3, writes().size)
    answer()
    executor.advanceBy(60_000)
    assertEquals("no chunk after the one in flight", 3, writes().size)
  }

  @Test
  fun `a failed chunk ends the stream and says how far it got`() {
    stream(ByteArray(100), echoWrite, withResponse = true, chunkSize = 20)
    answer()
    answer(0x03) // ATT write not permitted
    assertEquals(CoreError.Code.WRITE_NOT_PERMITTED, code())
    assertTrue(result!!.exceptionOrNull()!!.message!!.contains("after 20 of 100 bytes"))
    executor.advanceBy(60_000)
    assertEquals(2, writes().size)
  }

  @Test
  fun `the timeout applies to each chunk`() {
    stream(ByteArray(60), timeoutMs = 1_000)
    executor.advanceBy(900)
    answer()
    executor.advanceBy(900)
    answer()
    assertNull("each chunk had its own 1 s", result)
    executor.advanceBy(1_000)
    assertEquals(CoreError.Code.OPERATION_TIMEOUT, code())
  }

  @Test
  fun `a disconnect rejects the stream`() {
    stream(ByteArray(100))
    answer()
    client.callback.onConnectionStateChange(0x08, ConnectionStates.DISCONNECTED)
    executor.runUntilIdle()
    assertEquals(CoreError.Code.DISCONNECTED, code())
  }

  @Test
  fun `chunk sizes are checked, and empty data writes nothing`() {
    stream(ByteArray(100), chunkSize = 21)
    assertEquals("one packet at most without response", CoreError.Code.INVALID_ARGUMENT, code())
    stream(ByteArray(100), echoWrite, withResponse = true, chunkSize = 513)
    assertEquals(CoreError.Code.INVALID_ARGUMENT, code())
    stream(ByteArray(100), echoWrite)
    assertEquals(CoreError.Code.WRITE_NOT_PERMITTED, code())
    stream(ByteArray(0))
    assertTrue(result!!.isSuccess)
    assertTrue(client.calls.isEmpty())
    assertTrue(progress.isEmpty())
  }
}
