package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.UUID

/** P2-04: native notification batching per subscriber, and the overflow policy, on Android. */
class BatchingTest {
  private val testService = UUID.fromString("0c6c1000-b347-4cfa-9827-1c5a13658519")
  private val stream = UUID.fromString("0c6c1007-b347-4cfa-9827-1c5a13658519")
  private val streamRef = GattCharacteristicRef(testService, 0, stream, 0)
  private val profile = GattServiceInfo(
    testService,
    0,
    true,
    listOf(GattCharacteristicInfo(streamRef, CharacteristicProperties.NOTIFY, listOf(PeripheralSession.CCCD))),
  )

  private val executor = ManualExecutor()
  private val device = FakeRemoteDevice("C0:FF:EE:00:00:01").apply { services = listOf(profile) }
  private val states = mutableListOf<String>()
  private val session = PeripheralSession(device.address, { device }, executor) { state, _ -> states += state.js }
  private val single = mutableListOf<List<Byte>>()
  private val batches = mutableListOf<Pair<Int, NotificationBatch>>()
  private val warnings = mutableListOf<CoreError>()
  private val log = mutableListOf<String>()
  private lateinit var client: FakeGattClient

  @Before
  fun connect() {
    session.onNotification = { _, value, _ -> single += value.toList() }
    session.onNotificationBatch = { id, batch ->
      batches += id to batch
      log += "batch $id"
    }
    session.onWarning = { warnings += it }
    session.connect(ConnectSpec(15_000, requestMtu = null)) {}
    client = device.clients.single()
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    executor.runUntilIdle()
    client.completeServiceDiscovery()
    client.respondsAutomatically = true
  }

  private fun subscribe(id: Int, batch: BatchSpec?) {
    var result: Result<Unit>? = null
    session.subscribe(testService, stream, SubscribeMode.AUTO, id, null, batch) { result = it }
    executor.runUntilIdle()
    assertTrue(result!!.isSuccess)
  }

  private fun notify(vararg bytes: Int) = client.notify(streamRef, ByteArray(bytes.size) { bytes[it].toByte() })

  private fun values(batch: NotificationBatch) = batch.values.map { it.first().toInt() }

  @Test
  fun `values within one interval come as one batch, with their arrival times`() {
    subscribe(1, BatchSpec(16))
    notify(1)
    executor.advanceBy(5)
    notify(2)
    executor.advanceBy(10)
    assertTrue("not before the interval", batches.isEmpty())
    executor.advanceBy(1)
    assertEquals(listOf(1, 2), values(batches.single().second))
    val (first, second) = batches.single().second.timestamps
    assertEquals(5.0, second - first, 0.0)
    assertEquals(0, batches.single().second.dropped)
    assertTrue("no single events for a batched subscriber", single.isEmpty())

    executor.advanceBy(1_000)
    assertEquals("nothing while idle", 1, batches.size)
    notify(3)
    executor.advanceBy(16)
    assertEquals(listOf(3), values(batches.last().second))
  }

  @Test
  fun `batched and unbatched subscribers share a characteristic`() {
    subscribe(1, BatchSpec(16))
    subscribe(2, null)
    subscribe(3, BatchSpec(100))
    notify(7)
    executor.advanceBy(100)
    assertEquals(listOf(listOf<Byte>(7)), single)
    assertEquals(listOf(1, 3), batches.map { it.first })
  }

  @Test
  fun `a full batch drops its oldest values, counts them, and warns once`() {
    subscribe(1, BatchSpec(100, maxItems = 3))
    (1..5).forEach { notify(it) }
    executor.advanceBy(100)
    val batch = batches.single().second
    assertEquals(listOf(3, 4, 5), values(batch))
    assertEquals(2, batch.dropped)
    assertEquals(listOf(CoreError.Code.BUFFER_OVERFLOW), warnings.map { it.code })

    (1..4).forEach { notify(it) }
    executor.advanceBy(100)
    assertEquals(1, batches.last().second.dropped)
    assertEquals("the warning comes once per subscription", 1, warnings.size)
  }

  @Test
  fun `unsubscribing stops delivery at once, collected values included`() {
    subscribe(1, BatchSpec(16))
    subscribe(2, null)
    notify(1)
    var done = false
    session.unsubscribe(1, null) { done = it.isSuccess }
    executor.advanceBy(100)
    assertTrue(done)
    assertTrue(batches.isEmpty())
    notify(2)
    executor.advanceBy(100)
    assertTrue(batches.isEmpty())
  }

  @Test
  fun `a disconnect delivers the collected values before the state changes`() {
    subscribe(1, BatchSpec(1_000))
    notify(1)
    session.onNotificationBatch = { id, _ -> log += "batch $id (state ${states.last()})" }
    client.callback.onConnectionStateChange(0x08, ConnectionStates.DISCONNECTED)
    executor.runUntilIdle()
    assertEquals(listOf("batch 1 (state connected)"), log)
    executor.advanceBy(2_000)
    assertEquals("nothing after the end", 1, log.size)
  }

  @Test
  fun `100 Hz x 20 B for 10 minutes with 16 ms batches`() {
    subscribe(1, BatchSpec(16))
    val minutes = 10
    for (n in 0 until 100 * 60 * minutes) {
      client.notify(streamRef, ByteArray(20) { (n + it).toByte() }.also { it[0] = (n and 0xFF).toByte() })
      executor.advanceBy(10)
    }
    executor.advanceBy(16)
    val perSecond = batches.size / (60.0 * minutes)
    assertTrue("$perSecond batches/s", perSecond <= 63)
    assertEquals(0, batches.sumOf { it.second.dropped })
    val received = batches.flatMap { values(it.second) }
    assertEquals((0 until 100 * 60 * minutes).map { (it and 0xFF).toByte().toInt() }, received)
    assertTrue(warnings.isEmpty())
  }
}
