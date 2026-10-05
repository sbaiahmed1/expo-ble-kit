package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.ManualExecutor
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.UUID

/** P4-01: the GATT server core, through a fake port; long reads also run the shared contract. */
class GattServerTest {
  private val serviceUuid = UUID.fromString("0c6c2000-b347-4cfa-9827-1c5a13658519")
  private val dynamic = UUID.fromString("0c6c2001-b347-4cfa-9827-1c5a13658519")
  private val other = UUID.fromString("0c6c2002-b347-4cfa-9827-1c5a13658519")
  private val static = UUID.fromString("0c6c2003-b347-4cfa-9827-1c5a13658519")
  private val notifying = UUID.fromString("0c6c2004-b347-4cfa-9827-1c5a13658519")
  private val userDescription = UUID.fromString("00002901-0000-1000-8000-00805f9b34fb")
  private val readWrite = CharacteristicProperties.READ or CharacteristicProperties.WRITE
  private val service = ServerServiceSpec(
    serviceUuid,
    true,
    listOf(
      ServerCharacteristicSpec(
        dynamic,
        readWrite,
        AttributePermissions.READ or AttributePermissions.WRITE,
        null,
        emptyList(),
      ),
      ServerCharacteristicSpec(
        other,
        readWrite,
        AttributePermissions.READ or AttributePermissions.WRITE,
        null,
        emptyList(),
      ),
      ServerCharacteristicSpec(
        static,
        CharacteristicProperties.READ,
        AttributePermissions.READ,
        byteArrayOf(1, 2, 3),
        listOf(ServerDescriptorSpec(userDescription, "Static".toByteArray())),
      ),
      ServerCharacteristicSpec(
        notifying,
        CharacteristicProperties.NOTIFY,
        AttributePermissions.READ,
        null,
        emptyList(),
      ),
    ),
  )

  private class Response(
    val central: String,
    val requestId: Int,
    val status: Int,
    val offset: Int,
    val value: ByteArray?,
  )

  private class FakePort : GattServerPort {
    val added = mutableListOf<UUID>()
    val responses = mutableListOf<Response>()
    var closed = false
    var events: GattServerEvents? = null

    override fun addService(service: ServerServiceSpec): Boolean {
      added += service.uuid
      events?.onServiceAdded(GATT_SUCCESS, service.uuid)
      return true
    }

    override fun sendResponse(central: String, requestId: Int, status: Int, offset: Int, value: ByteArray?): Boolean {
      responses += Response(central, requestId, status, offset, value)
      return true
    }

    override fun close() {
      closed = true
    }
  }

  private val executor = ManualExecutor()
  private val port = FakePort()
  private val reads = mutableListOf<Triple<Int, String, Int>>()
  private val writes = mutableListOf<Pair<Int, ByteArray>>()
  private val subscriptions = mutableListOf<String>()
  private val warnings = mutableListOf<String>()
  private val server = GattServer(listOf(service), executor) { events -> port.also { it.events = events } }
  private val events get() = port.events!!

  private fun open() {
    server.listener = object : GattServer.Listener {
      override fun onReadRequest(requestId: Int, central: String, characteristic: UUID, offset: Int) {
        reads += Triple(requestId, central, offset)
      }

      override fun onWriteRequest(
        requestId: Int,
        central: String,
        characteristic: UUID,
        offset: Int,
        value: ByteArray,
        withResponse: Boolean,
      ) {
        writes += requestId to value
      }

      override fun onSubscriptionChange(central: String, characteristic: UUID, subscribed: Boolean) {
        subscriptions += "$central ${if (subscribed) "on" else "off"}"
      }

      override fun onWarning(warning: CoreError) {
        warnings += warning.code.value
      }
    }
    var result: CoreError? = CoreError(CoreError.Code.INTERNAL, "pending")
    server.open { result = it }
    assertNull(result)
    assertEquals(listOf(serviceUuid), port.added)
  }

  private fun hex(value: ByteArray?) = value?.joinToString("") { "%02x".format(it) }

  private fun bytes(hex: String) = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

  @Test
  fun `the shared long-read contract`() {
    val contract = JSONObject(File(System.getProperty("blekit.contracts"), "gatt-server-reads.json").readText())
    val cases = contract.getJSONArray("cases")
    for (index in 0 until cases.length()) {
      val case = cases.getJSONObject(index)
      val executor = ManualExecutor()
      val port = FakePort()
      val server = GattServer(listOf(service), executor) { events -> port.also { it.events = events } }
      var asked: Int? = null
      var handlerValue = ByteArray(0)
      server.listener = object : GattServer.Listener {
        override fun onReadRequest(requestId: Int, central: String, characteristic: UUID, offset: Int) {
          asked = offset
          server.respondToRead(requestId, handlerValue, null)
        }

        override fun onWriteRequest(r: Int, c: String, ch: UUID, o: Int, v: ByteArray, w: Boolean) = Unit

        override fun onSubscriptionChange(central: String, characteristic: UUID, subscribed: Boolean) = Unit

        override fun onWarning(warning: CoreError) = Unit
      }
      server.open {}
      val steps = case.getJSONArray("steps")
      for (s in 0 until steps.length()) {
        val step = steps.getJSONObject(s)
        val label = "${case.getString("name")}, step ${s + 1}"
        when {
          step.has("advance") -> executor.advanceBy(step.getLong("advance"))

          step.has("disconnect") -> port.events!!.onConnectionStateChange(step.getString("disconnect"), false)

          else -> {
            val read = step.getJSONObject("read")
            val characteristic = if (read.getString("characteristic") == "c1") dynamic else other
            asked = null
            handlerValue = bytes(step.getString("handlerValue"))
            port.events!!.onCharacteristicReadRequest(
              read.getString("central"),
              s,
              read.getInt("offset"),
              characteristic,
            )
            val expect = step.getJSONObject("expect")
            assertEquals(label, if (expect.isNull("handler")) null else expect.getInt("handler"), asked)
            val response = port.responses.last()
            val expected = expect.getString("response")
            if (expected == "INVALID_OFFSET") {
              assertEquals(label, AttErrors.INVALID_OFFSET, response.status)
            } else {
              assertEquals(label, AttErrors.SUCCESS, response.status)
              assertEquals(label, expected, hex(response.value))
            }
          }
        }
      }
    }
  }

  @Test
  fun `a 512-byte value read at MTU 23 is one snapshot while the handler's value changes`() {
    open()
    var value = ByteArray(512) { it.toByte() }
    val received = mutableListOf<Byte>()
    // A central at MTU 23 reads 22 bytes per response: Read, then Read Blob until a short response.
    var offset = 0
    var id = 100
    while (true) {
      events.onCharacteristicReadRequest("A", id++, offset, dynamic)
      reads.lastOrNull()?.takeIf {
        it.third == offset && offset == 0
      }?.let { server.respondToRead(it.first, value, null) }
      value = ByteArray(512) { (it + offset + 1).toByte() } // the app's value keeps changing
      val response = port.responses.last()
      val part = response.value!!.copyOf(minOf(22, response.value.size))
      received += part.toList()
      if (part.size < 22) break
      offset += part.size
    }
    assertEquals("the handler is asked once per sequence", 1, reads.size)
    assertArrayEquals(ByteArray(512) { it.toByte() }, received.toByteArray())
  }

  @Test
  fun `static values and descriptors are answered without JS`() {
    open()
    events.onCharacteristicReadRequest("A", 1, 1, static)
    assertEquals("0203", hex(port.responses.last().value))
    events.onDescriptorReadRequest("A", 2, 0, static, userDescription)
    assertEquals("Static", String(port.responses.last().value!!))
    events.onCharacteristicWriteRequest("A", 3, static, false, true, 0, byteArrayOf(9))
    assertEquals(AttErrors.WRITE_NOT_PERMITTED, port.responses.last().status)
    assertTrue(reads.isEmpty() && writes.isEmpty())
  }

  @Test
  fun `a write reaches JS and is answered with its result`() {
    open()
    events.onCharacteristicWriteRequest("A", 7, dynamic, false, true, 0, byteArrayOf(1, 2))
    val (id, value) = writes.single()
    assertEquals("0102", hex(value))
    server.respondToWrite(id, AttErrors.WRITE_NOT_PERMITTED)
    assertEquals(
      listOf(7, AttErrors.WRITE_NOT_PERMITTED),
      port.responses.last().let {
        listOf(it.requestId, it.status)
      },
    )

    events.onCharacteristicWriteRequest("A", 8, dynamic, false, false, 0, byteArrayOf(3))
    server.respondToWrite(writes.last().first, null)
    assertEquals("a write without response gets no answer", 1, port.responses.size)
  }

  @Test
  fun `prepared writes reach JS as one value per characteristic at execute`() {
    open()
    events.onCharacteristicWriteRequest("A", 1, dynamic, true, true, 0, ByteArray(18) { 1 })
    events.onCharacteristicWriteRequest("A", 2, dynamic, true, true, 18, ByteArray(18) { 2 })
    events.onCharacteristicWriteRequest("A", 3, other, true, true, 0, byteArrayOf(7))
    assertEquals("each part is echoed", listOf(0, 18, 0), port.responses.map { it.offset })
    assertTrue(writes.isEmpty())

    events.onExecuteWrite("A", 4, true)
    assertEquals(listOf(36, 1), writes.map { it.second.size })
    assertArrayEquals(ByteArray(18) { 1 } + ByteArray(18) { 2 }, writes[0].second)
    server.respondToWrite(writes[0].first, null)
    assertEquals("the execute waits for every characteristic", 3, port.responses.size)
    server.respondToWrite(writes[1].first, null)
    assertEquals(listOf(4, AttErrors.SUCCESS), port.responses.last().let { listOf(it.requestId, it.status) })

    events.onCharacteristicWriteRequest("A", 5, dynamic, true, true, 0, byteArrayOf(1))
    events.onExecuteWrite("A", 6, false)
    assertEquals("cancelled", 2, writes.size)
    events.onCharacteristicWriteRequest("A", 7, dynamic, true, true, 500, ByteArray(20))
    events.onExecuteWrite("A", 8, true)
    assertEquals("a gap", AttErrors.INVALID_OFFSET, port.responses.last().status)
    events.onCharacteristicWriteRequest("A", 9, dynamic, true, true, 0, ByteArray(20))
    events.onCharacteristicWriteRequest("A", 10, dynamic, true, true, 20, ByteArray(500))
    events.onExecuteWrite("A", 11, true)
    assertEquals("over 512 bytes", AttErrors.INVALID_ATTRIBUTE_LENGTH, port.responses.last().status)
    assertEquals(2, writes.size)
  }

  @Test
  fun `an unanswered request gets an ATT error at the deadline, with a warning`() {
    open()
    events.onCharacteristicReadRequest("A", 1, 0, dynamic)
    executor.advanceBy(GattServer.RESPONSE_DEADLINE_MS - 1)
    assertTrue(port.responses.isEmpty())
    executor.advanceBy(1)
    assertEquals(AttErrors.UNLIKELY_ERROR, port.responses.single().status)
    assertEquals(listOf("OPERATION_TIMEOUT"), warnings)
    server.respondToRead(reads.single().first, byteArrayOf(1), null)
    assertEquals("a late answer is ignored", 1, port.responses.size)
  }

  @Test
  fun `the CCCD tracks subscriptions per central, and a disconnect ends them`() {
    open()
    events.onDescriptorWriteRequest("A", 1, notifying, GattServer.CCCD, false, true, 0, byteArrayOf(1, 0))
    events.onDescriptorWriteRequest("B", 2, notifying, GattServer.CCCD, false, true, 0, byteArrayOf(1, 0))
    events.onDescriptorReadRequest("A", 3, 0, notifying, GattServer.CCCD)
    assertEquals("0100", hex(port.responses.last().value))
    events.onDescriptorWriteRequest("A", 4, notifying, GattServer.CCCD, false, true, 0, byteArrayOf(2, 0))
    assertEquals("no indications on this one", AttErrors.CCCD_IMPROPERLY_CONFIGURED, port.responses.last().status)
    assertEquals(setOf("A", "B"), server.subscribedCentrals(notifying))

    events.onConnectionStateChange("A", false)
    events.onDescriptorWriteRequest("B", 5, notifying, GattServer.CCCD, false, true, 0, byteArrayOf(0, 0))
    assertEquals(listOf("A on", "B on", "A off", "B off"), subscriptions)
    assertTrue(server.subscribedCentrals(notifying).isEmpty())
  }

  @Test
  fun `a disconnect drops the central's pending requests, and close closes the port`() {
    open()
    events.onCharacteristicReadRequest("A", 1, 0, dynamic)
    events.onConnectionStateChange("A", false)
    executor.advanceBy(GattServer.RESPONSE_DEADLINE_MS)
    assertTrue("nothing to answer on a lost link", port.responses.isEmpty())
    assertTrue(warnings.isEmpty())
    server.close()
    assertTrue(port.closed)
  }

  @Test
  fun `a service Android doesn't confirm in time fails the open`() {
    val silent = object : GattServerPort {
      var closed = false

      override fun addService(service: ServerServiceSpec) = true

      override fun sendResponse(central: String, requestId: Int, status: Int, offset: Int, value: ByteArray?) = true

      override fun close() {
        closed = true
      }
    }
    var error: CoreError? = null
    GattServer(listOf(service), executor) { silent }.open { error = it }
    executor.advanceBy(GattServer.ADD_SERVICE_TIMEOUT_MS)
    assertEquals(CoreError.Code.OPERATION_TIMEOUT, error?.code)
    assertTrue(silent.closed)
    var refused: CoreError? = null
    GattServer(listOf(service), executor) { null }.open { refused = it }
    assertEquals(CoreError.Code.INTERNAL, refused?.code)
  }
}
