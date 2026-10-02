package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeBluetoothAdapter
import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import expo.modules.blekit.core.fakes.scanRecord
import expo.modules.blekit.core.fakes.service
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** P1-01: the Android Bluetooth abstractions and the fakes used by later tests. */
class AbstractionsTest {
  private val heartRate =
    service(
      "180d",
      "2a37" to CharacteristicProperties.NOTIFY,
      "2a38" to CharacteristicProperties.READ,
    )
  private val measurement = heartRate.characteristics[0].ref
  private val location = heartRate.characteristics[1].ref

  @Test
  fun `fake adapter scans and exposes no scanner while off`() {
    val adapter = FakeBluetoothAdapter()
    val received = mutableListOf<String>()
    val callback =
      object : LeScanCallback {
        override fun onScanResults(results: List<ScanRecordData>) {
          results.forEach { received.add("${it.name} ${it.rssi}") }
        }

        override fun onScanFailed(errorCode: Int) {
          received.add("failed $errorCode")
        }
      }

    adapter.leScanner!!.startScan(emptyList(), ScanSettingsSpec(), callback)
    adapter.scanner.emit(scanRecord("AA:BB:CC:DD:EE:FF", name = "HRM", rssi = -42))
    adapter.leScanner!!.stopScan(callback)
    adapter.scanner.emit(scanRecord("AA:BB:CC:DD:EE:FF", name = "late"))
    adapter.state = AdapterStates.OFF

    assertEquals(listOf("HRM -42"), received)
    assertTrue(adapter.scanner.active.isEmpty())
    assertNull(adapter.leScanner)
  }

  @Test
  fun `fake gatt client holds operations until the test completes them`() {
    val device = FakeRemoteDevice("AA:BB:CC:DD:EE:FF").apply { services = listOf(heartRate) }
    device.values[location] = byteArrayOf(0x01)
    val events = mutableListOf<String>()
    val client =
      device.connectGatt(
        autoConnect = false,
        callback =
        object : GattClientCallback {
          override fun onConnectionStateChange(status: Int, newState: Int) {
            events.add("state $newState")
          }

          override fun onServicesDiscovered(status: Int) {
            events.add("discovered $status")
          }

          override fun onCharacteristicRead(ref: GattCharacteristicRef, value: ByteArray, status: Int) {
            events.add("read ${value.toList()}")
          }

          override fun onCharacteristicChanged(ref: GattCharacteristicRef, value: ByteArray) {
            events.add("changed ${value.toList()}")
          }
        },
      ) as FakeGattClient

    client.completeConnection()
    assertTrue(client.discoverServices())
    assertTrue("nothing is discovered until the test completes the call", client.services().isEmpty())
    client.completeServiceDiscovery()
    client.readCharacteristic(location)
    assertEquals("the read stays in flight", 2, events.size)
    client.respondsAutomatically = true
    client.readCharacteristic(location)
    client.notify(measurement, byteArrayOf(0x00, 72))
    client.close()

    assertEquals(
      listOf("state ${ConnectionStates.CONNECTED}", "discovered $GATT_SUCCESS", "read [1]", "changed [0, 72]"),
      events,
    )
    assertEquals(listOf(heartRate), client.services())
    assertEquals(
      listOf(
        FakeGattClient.Call.DiscoverServices,
        FakeGattClient.Call.Read(location),
        FakeGattClient.Call.Read(location),
        FakeGattClient.Call.Close,
      ),
      client.calls,
    )
    assertEquals(1, client.closeCount)
  }

  @Test
  fun `fake gatt client reports a busy write without storing it`() {
    val device = FakeRemoteDevice("AA:BB:CC:DD:EE:FF").apply { services = listOf(heartRate) }
    val client = device.connectGatt(false, object : GattClientCallback {}) as FakeGattClient

    client.nextWriteStatus = SubmitStatus.ERROR_GATT_WRITE_REQUEST_BUSY
    assertEquals(
      SubmitStatus.ERROR_GATT_WRITE_REQUEST_BUSY,
      client.writeCharacteristic(location, byteArrayOf(9), WriteTypes.NO_RESPONSE),
    )
    assertNull(device.values[location])

    client.nextWriteStatus = SubmitStatus.SUCCESS
    assertEquals(SubmitStatus.SUCCESS, client.writeCharacteristic(location, byteArrayOf(9), WriteTypes.DEFAULT))
    assertArrayEquals(byteArrayOf(9), device.values[location])
  }

  @Test
  fun `manual executor runs due work in order and skips cancelled work`() {
    val executor = ManualExecutor()
    val log = mutableListOf<String>()

    executor.executeDelayed(2_000) { log.add("timeout 2s") }
    val cancelled = executor.executeDelayed(1_000) { log.add("cancelled") }
    executor.execute { log.add("now") }
    executor.executeDelayed(1_000) {
      assertTrue(executor.isOnExecutorThread())
      log.add("1s")
      executor.execute { log.add("submitted from 1s") }
    }
    cancelled.cancel()

    executor.runUntilIdle()
    assertEquals(listOf("now"), log)
    assertFalse(executor.isOnExecutorThread())
    executor.advanceBy(1_500)
    assertEquals(listOf("now", "1s", "submitted from 1s"), log)
    assertEquals(1_500L, executor.nowMs())
    executor.advanceBy(1_000)
    assertEquals(listOf("now", "1s", "submitted from 1s", "timeout 2s"), log)
    assertEquals(0, executor.pendingCount)
  }
}
