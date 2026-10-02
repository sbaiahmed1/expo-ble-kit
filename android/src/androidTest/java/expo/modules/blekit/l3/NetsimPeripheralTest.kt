package expo.modules.blekit.l3

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.os.Build
import android.os.ParcelUuid
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private const val TAG = "BleKitL3"
private const val SCAN_TIMEOUT_MS = 30_000L
private const val CONNECT_TIMEOUT_MS = 15_000L
private const val OP_TIMEOUT_MS = 10_000L
private const val DEFAULT_REQUESTED_MTU = 517

/**
 * L3 spike (plan P0-06): scans for, connects to and reads the Bumble test peripheral
 * (test-peripherals/bumble) over the emulator's netsim radio.
 *
 * Uses raw Android Bluetooth APIs because the library's own BLE core doesn't exist yet.
 * Run with e2e/android-netsim/run.sh, which starts the peripheral first.
 */
@SuppressLint("MissingPermission") // granted by the rule below
@RunWith(AndroidJUnit4::class)
class NetsimPeripheralTest {
  @get:Rule
  val permissions: GrantPermissionRule = GrantPermissionRule.grant(*runtimePermissions())

  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context = instrumentation.targetContext
  private val profile = TestProfile.load(instrumentation.context)
  private val adapter = context.getSystemService(BluetoothManager::class.java).adapter

  @Test
  fun scansConnectsAndReads() {
    assertTrue("Bluetooth must be on in the emulator", adapter.isEnabled)

    val result = scanForTestPeripheral()
    val record = requireNotNull(result.scanRecord)
    assertEquals(profile.localName, record.deviceName)
    assertArrayEquals(
      profile.manufacturerPayload,
      record.getManufacturerSpecificData(profile.manufacturerCompanyId),
    )
    Log.i(TAG, "Found ${result.device.address} rssi=${result.rssi} connectable=${result.isConnectable}")

    val events = LinkedBlockingQueue<GattEvent>()
    val gatt = result.device.connectGatt(context, false, GattEvents(events), BluetoothDevice.TRANSPORT_LE)
    try {
      val connected = events.next<GattEvent.ConnectionState>(CONNECT_TIMEOUT_MS)
      assertEquals(BluetoothProfile.STATE_CONNECTED, connected.newState)

      // Override with -Pandroid.testInstrumentationRunnerArguments.requestedMtu=<n> (plan Q3 data).
      val requestedMtu =
        InstrumentationRegistry.getArguments().getString("requestedMtu")?.toInt() ?: DEFAULT_REQUESTED_MTU
      assertTrue("requestMtu", gatt.requestMtu(requestedMtu))
      val mtu = events.next<GattEvent.MtuChanged>(OP_TIMEOUT_MS)
      Log.i(TAG, "MTU requested=$requestedMtu negotiated=${mtu.mtu} status=${mtu.status}")

      assertTrue("discoverServices", gatt.discoverServices())
      assertEquals(BluetoothGatt.GATT_SUCCESS, events.next<GattEvent.ServicesDiscovered>(OP_TIMEOUT_MS).status)
      val service = requireNotNull(gatt.getService(profile.uuid("TEST"))) { "TEST service not discovered" }

      for (key in listOf("STATIC_READ", "LONG_READ")) {
        val characteristic = requireNotNull(service.getCharacteristic(profile.uuid(key))) { "$key not discovered" }
        assertTrue("readCharacteristic($key)", gatt.readCharacteristic(characteristic))
        val read = events.next<GattEvent.Read>(OP_TIMEOUT_MS)
        assertEquals("$key status", BluetoothGatt.GATT_SUCCESS, read.status)
        assertArrayEquals(key, profile.value(key), read.value)
        Log.i(TAG, "Read $key: ${read.value.size} bytes match the profile")
      }
    } finally {
      gatt.disconnect()
      gatt.close()
    }
  }

  /** Scans by the TEST service UUID until a result carries the scan response (the local name). */
  private fun scanForTestPeripheral(): ScanResult {
    val results = LinkedBlockingQueue<ScanResult>()
    val scanError = AtomicInteger(0)
    val callback =
      object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
          results.add(result)
        }

        override fun onScanFailed(errorCode: Int) {
          scanError.set(errorCode)
        }
      }
    val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(profile.uuid("TEST"))).build()
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
    val scanner = requireNotNull(adapter.bluetoothLeScanner) { "No LE scanner" }
    scanner.startScan(listOf(filter), settings, callback)
    try {
      val deadline = System.currentTimeMillis() + SCAN_TIMEOUT_MS
      while (System.currentTimeMillis() < deadline) {
        if (scanError.get() != 0) throw AssertionError("Scan failed with error ${scanError.get()}")
        val result = results.poll(250, TimeUnit.MILLISECONDS) ?: continue
        if (result.scanRecord?.deviceName != null) return result
      }
      throw AssertionError("Test peripheral not found within ${SCAN_TIMEOUT_MS}ms. Is the Bumble peripheral running?")
    } finally {
      scanner.stopScan(callback)
    }
  }
}

private fun runtimePermissions(): Array<String> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
  arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
} else {
  arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
}

private sealed interface GattEvent {
  data class ConnectionState(val status: Int, val newState: Int) : GattEvent

  data class MtuChanged(val mtu: Int, val status: Int) : GattEvent

  data class ServicesDiscovered(val status: Int) : GattEvent

  class Read(val value: ByteArray, val status: Int) : GattEvent
}

private class GattEvents(private val events: LinkedBlockingQueue<GattEvent>) : BluetoothGattCallback() {
  override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
    events.add(GattEvent.ConnectionState(status, newState))
  }

  override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
    events.add(GattEvent.MtuChanged(mtu, status))
  }

  override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
    events.add(GattEvent.ServicesDiscovered(status))
  }

  override fun onCharacteristicRead(
    gatt: BluetoothGatt,
    characteristic: BluetoothGattCharacteristic,
    value: ByteArray,
    status: Int,
  ) {
    events.add(GattEvent.Read(value, status))
  }

  @Deprecated("Only called below API 33")
  @Suppress("DEPRECATION")
  override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      events.add(GattEvent.Read(characteristic.value ?: ByteArray(0), status))
    }
  }
}

/** Waits for the next event of type [T], failing on timeout or on an unexpected disconnection. */
private inline fun <reified T : GattEvent> LinkedBlockingQueue<GattEvent>.next(timeoutMs: Long): T {
  val deadline = System.currentTimeMillis() + timeoutMs
  while (true) {
    val remaining = deadline - System.currentTimeMillis()
    if (remaining <= 0) throw AssertionError("Timed out after ${timeoutMs}ms waiting for ${T::class.simpleName}")
    val event = poll(remaining, TimeUnit.MILLISECONDS) ?: continue
    if (event is T) return event
    if (event is GattEvent.ConnectionState && event.newState == BluetoothProfile.STATE_DISCONNECTED) {
      throw AssertionError("Disconnected (status ${event.status}) while waiting for ${T::class.simpleName}")
    }
    Log.d(TAG, "Ignoring $event while waiting for ${T::class.simpleName}")
  }
}
