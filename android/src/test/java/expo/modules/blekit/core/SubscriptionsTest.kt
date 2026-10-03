package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.UUID

/** P1-08: subscriptions, the shared CCCD, and notification delivery on Android. */
class SubscriptionsTest {
  private val testService = UUID.fromString("0c6c1000-b347-4cfa-9827-1c5a13658519")
  private val stream = UUID.fromString("0c6c1007-b347-4cfa-9827-1c5a13658519")
  private val indicate = UUID.fromString("0c6c1008-b347-4cfa-9827-1c5a13658519")
  private val both = UUID.fromString("0c6c100c-b347-4cfa-9827-1c5a13658519")
  private val noCccd = UUID.fromString("0c6c100d-b347-4cfa-9827-1c5a13658519")
  private val readOnly = UUID.fromString("0c6c1001-b347-4cfa-9827-1c5a13658519")
  private val cccd = PeripheralSession.CCCD

  private fun characteristic(uuid: UUID, properties: Int, vararg descriptors: UUID) =
    GattCharacteristicInfo(GattCharacteristicRef(testService, 0, uuid, 0), properties, descriptors.toList())

  private val profile = GattServiceInfo(
    testService,
    0,
    true,
    listOf(
      characteristic(stream, CharacteristicProperties.NOTIFY, cccd),
      characteristic(indicate, CharacteristicProperties.INDICATE, cccd),
      characteristic(both, CharacteristicProperties.NOTIFY or CharacteristicProperties.INDICATE, cccd),
      characteristic(noCccd, CharacteristicProperties.NOTIFY),
      characteristic(readOnly, CharacteristicProperties.READ),
    ),
  )

  private val executor = ManualExecutor()
  private val device = FakeRemoteDevice("C0:FF:EE:00:00:01").apply { services = listOf(profile) }
  private val session = PeripheralSession(device.address, { device }, executor) { _, _ -> }
  private val received = mutableListOf<Pair<UUID, List<Byte>>>()
  private lateinit var client: FakeGattClient

  private fun ref(uuid: UUID) = profile.characteristics.first { it.ref.uuid == uuid }.ref

  @Before
  fun connect() {
    session.onNotification = { ref, value, _ -> received += ref.uuid to value.toList() }
    session.connect(ConnectSpec(15_000, requestMtu = null)) {}
    client = device.clients.single()
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    executor.runUntilIdle()
    client.completeServiceDiscovery()
    client.calls.clear()
    client.respondsAutomatically = true
  }

  private fun subscribe(
    id: Int,
    characteristic: UUID = stream,
    mode: SubscribeMode = SubscribeMode.AUTO,
  ): () -> Result<Unit>? {
    var result: Result<Unit>? = null
    session.subscribe(testService, characteristic, mode, id, null) { result = it }
    executor.runUntilIdle()
    return { result }
  }

  private fun unsubscribe(id: Int): () -> Result<Unit>? {
    var result: Result<Unit>? = null
    session.unsubscribe(id, null) { result = it }
    executor.runUntilIdle()
    return { result }
  }

  private fun code(result: Result<Unit>?) = (result?.exceptionOrNull() as? CoreError)?.code

  private fun cccdWrites() = client.calls.filterIsInstance<FakeGattClient.Call.WriteDescriptor>().map { it.value }

  private fun registrations() = client.calls.filterIsInstance<FakeGattClient.Call.SetNotification>().map { it.enable }

  @Test
  fun `subscribers share one CCCD, and the last one out disables it`() {
    assertTrue(subscribe(1)()!!.isSuccess)
    assertEquals(listOf(listOf<Byte>(1, 0)), cccdWrites())
    assertEquals(listOf(true), registrations())

    assertTrue(subscribe(2)()!!.isSuccess)
    assertEquals("the second subscriber shares the CCCD", 1, cccdWrites().size)

    client.notify(ref(stream), byteArrayOf(7))
    assertEquals(listOf(stream to listOf<Byte>(7)), received)

    assertTrue(unsubscribe(1)()!!.isSuccess)
    client.notify(ref(stream), byteArrayOf(8))
    assertEquals("the other subscriber keeps receiving", 2, received.size)
    assertEquals(1, cccdWrites().size)

    assertTrue(unsubscribe(2)()!!.isSuccess)
    assertEquals(listOf(listOf<Byte>(1, 0), listOf<Byte>(0, 0)), cccdWrites())
    assertEquals(listOf(true, false), registrations())
    client.notify(ref(stream), byteArrayOf(9))
    assertEquals("nothing after the last subscriber", 2, received.size)
  }

  @Test
  fun `the mode picks notifications or indications, and conflicts are rejected`() {
    assertTrue(subscribe(1, indicate)()!!.isSuccess)
    assertEquals(listOf(listOf<Byte>(2, 0)), cccdWrites())
    assertEquals(CoreError.Code.NOT_SUPPORTED, code(subscribe(2, indicate, SubscribeMode.NOTIFY)()))

    assertTrue(subscribe(3, both)()!!.isSuccess)
    assertEquals("auto prefers notifications", listOf<Byte>(1, 0), cccdWrites().last())
    assertEquals(CoreError.Code.INVALID_ARGUMENT, code(subscribe(4, both, SubscribeMode.INDICATE)()))
    assertTrue(subscribe(5, both, SubscribeMode.NOTIFY)()!!.isSuccess)
  }

  @Test
  fun `checks come before the radio`() {
    assertEquals(CoreError.Code.NOT_SUPPORTED, code(subscribe(1, readOnly)()))
    assertEquals(CoreError.Code.DESCRIPTOR_NOT_FOUND, code(subscribe(2, noCccd)()))
    assertTrue(subscribe(3)()!!.isSuccess)
    assertEquals(CoreError.Code.INVALID_ARGUMENT, code(subscribe(3)()))
    assertTrue(unsubscribe(42)()!!.isSuccess)
  }

  @Test
  fun `a failed CCCD write rejects subscribe, and unsubscribe`() {
    client.respondsAutomatically = false
    val failed = subscribe(1)
    client.callback.onDescriptorWrite(GattDescriptorRef(ref(stream), cccd), 0x05)
    executor.runUntilIdle()
    assertEquals(CoreError.Code.INSUFFICIENT_AUTHENTICATION, code(failed()))
    client.notify(ref(stream), byteArrayOf(1))
    assertTrue("not subscribed after a failed enable", received.isEmpty())

    client.respondsAutomatically = true
    assertTrue(subscribe(2)()!!.isSuccess)
    client.respondsAutomatically = false
    val leaving = unsubscribe(2)
    client.callback.onDescriptorWrite(GattDescriptorRef(ref(stream), cccd), 0x03)
    assertEquals(CoreError.Code.WRITE_NOT_PERMITTED, code(leaving()))
    client.notify(ref(stream), byteArrayOf(2))
    assertTrue("delivery stopped anyway", received.isEmpty())
  }

  @Test
  fun `unsubscribing while the CCCD write is pending cancels that subscriber and disables again`() {
    client.respondsAutomatically = false
    val pending = subscribe(1)
    val leaving = unsubscribe(1)
    assertEquals(CoreError.Code.OPERATION_CANCELLED, code(pending()))
    // The disable write queues behind the enable write.
    client.callback.onDescriptorWrite(GattDescriptorRef(ref(stream), cccd), GATT_SUCCESS)
    executor.runUntilIdle()
    client.callback.onDescriptorWrite(GattDescriptorRef(ref(stream), cccd), GATT_SUCCESS)
    executor.runUntilIdle()
    assertTrue(leaving()!!.isSuccess)
    assertEquals("enabled, then disabled again", listOf(listOf<Byte>(1, 0), listOf<Byte>(0, 0)), cccdWrites())
  }

  @Test
  fun `a disconnect ends every subscription without writing`() {
    assertTrue(subscribe(1)()!!.isSuccess)
    client.callback.onConnectionStateChange(0x08, ConnectionStates.DISCONNECTED)
    client.notify(ref(stream), byteArrayOf(1))
    assertTrue(received.isEmpty())
    val writes = cccdWrites().size
    assertTrue(unsubscribe(1)()!!.isSuccess)
    assertEquals(writes, cccdWrites().size)
    assertEquals(CoreError.Code.DISCONNECTED, code(subscribe(2)()))
  }
}
