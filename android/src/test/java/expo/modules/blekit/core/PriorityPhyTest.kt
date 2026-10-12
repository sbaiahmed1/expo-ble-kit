package expo.modules.blekit.core

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** P5-02: connection priority and PHY on Android. */
class PriorityPhyTest {
  private val executor = ManualExecutor()
  private val device = FakeRemoteDevice("C0:FF:EE:00:00:01")
  private val session = PeripheralSession(device.address, { device }, executor) { _, _ -> }

  private val client: FakeGattClient get() = device.clients.last()

  private fun connect() {
    session.connect(ConnectSpec(15_000, autoDiscover = false, requestMtu = null)) {}
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    executor.runUntilIdle()
  }

  private fun <T> outcome(start: ((Result<T>) -> Unit) -> Unit): () -> Result<T>? {
    var result: Result<T>? = null
    start { result = it }
    executor.runUntilIdle()
    return { result }
  }

  private fun code(result: Result<*>?) = (result?.exceptionOrNull() as? CoreError)?.code?.value

  @Test
  fun `a priority request completes once the stack took it`() {
    val disconnected = outcome<Unit> { session.requestConnectionPriority(ConnectionPriorities.HIGH, null, it) }
    assertEquals("DISCONNECTED", code(disconnected()))
    connect()
    val high = outcome<Unit> { session.requestConnectionPriority(ConnectionPriorities.HIGH, null, it) }
    assertEquals(true, high()?.isSuccess)
    assertEquals(FakeGattClient.Call.ConnectionPriority(ConnectionPriorities.HIGH), client.calls.last())
    client.acceptsPriority = false
    val refused = outcome<Unit> { session.requestConnectionPriority(ConnectionPriorities.LOW_POWER, null, it) }
    assertEquals("GATT_ERROR", code(refused()))
  }

  @Test
  fun `setPreferredPhy resolves the PHYs the update reports`() {
    connect()
    val pending = outcome<Pair<Int, Int>> {
      session.setPreferredPhy(PhyMasks.LE_2M, PhyMasks.LE_2M, PhyOptions.NO_PREFERRED, null, it)
    }
    assertEquals(FakeGattClient.Call.SetPreferredPhy(2, 2, 0), client.calls.last())
    assertNull(pending())
    client.callback.onPhyUpdate(Phys.LE_2M, Phys.LE_2M, GATT_SUCCESS)
    executor.runUntilIdle()
    assertEquals(Phys.LE_2M to Phys.LE_2M, pending()?.getOrNull())
  }

  @Test
  fun `without an update the session reads the PHYs, and a refusal maps to NOT_SUPPORTED`() {
    connect()
    val unchanged = outcome<Pair<Int, Int>> {
      session.setPreferredPhy(PhyMasks.LE_1M, PhyMasks.LE_1M, PhyOptions.NO_PREFERRED, null, it)
    }
    executor.advanceBy(PeripheralSession.PHY_UPDATE_WAIT_MS)
    assertEquals(FakeGattClient.Call.ReadPhy, client.calls.last())
    client.callback.onPhyRead(Phys.LE_1M, Phys.LE_1M, GATT_SUCCESS)
    executor.runUntilIdle()
    assertEquals(Phys.LE_1M to Phys.LE_1M, unchanged()?.getOrNull())

    val coded = outcome<Pair<Int, Int>> {
      session.setPreferredPhy(PhyMasks.LE_CODED, PhyMasks.LE_CODED, PhyOptions.S8, null, it)
    }
    client.callback.onPhyUpdate(Phys.LE_1M, Phys.LE_1M, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED)
    executor.runUntilIdle()
    assertEquals("NOT_SUPPORTED", code(coded()))
  }

  @Test
  fun `JS PHY names and the constants match Android`() {
    assertEquals(PhyMasks.LE_1M or PhyMasks.LE_2M, PhyNames.mask(listOf("le1m", "le2m")))
    assertNull(PhyNames.mask(emptyList()))
    assertNull(PhyNames.mask(listOf("le3m")))
    assertEquals(listOf("le1m", "le2m", "leCoded"), listOf(Phys.LE_1M, Phys.LE_2M, Phys.LE_CODED).map(PhyNames::name))

    assertEquals(BluetoothGatt.CONNECTION_PRIORITY_BALANCED, ConnectionPriorities.BALANCED)
    assertEquals(BluetoothGatt.CONNECTION_PRIORITY_HIGH, ConnectionPriorities.HIGH)
    assertEquals(BluetoothGatt.CONNECTION_PRIORITY_LOW_POWER, ConnectionPriorities.LOW_POWER)
    assertEquals(BluetoothDevice.PHY_LE_1M_MASK, PhyMasks.LE_1M)
    assertEquals(BluetoothDevice.PHY_LE_2M_MASK, PhyMasks.LE_2M)
    assertEquals(BluetoothDevice.PHY_LE_CODED_MASK, PhyMasks.LE_CODED)
    assertEquals(BluetoothDevice.PHY_LE_1M, Phys.LE_1M)
    assertEquals(BluetoothDevice.PHY_LE_2M, Phys.LE_2M)
    assertEquals(BluetoothDevice.PHY_LE_CODED, Phys.LE_CODED)
    assertEquals(BluetoothDevice.PHY_OPTION_NO_PREFERRED, PhyOptions.NO_PREFERRED)
    assertEquals(BluetoothDevice.PHY_OPTION_S2, PhyOptions.S2)
    assertEquals(BluetoothDevice.PHY_OPTION_S8, PhyOptions.S8)
  }
}
