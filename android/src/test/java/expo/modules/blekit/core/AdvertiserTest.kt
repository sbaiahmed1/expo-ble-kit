package expo.modules.blekit.core

import android.bluetooth.le.AdvertisingSetCallback
import android.bluetooth.le.AdvertisingSetParameters
import expo.modules.blekit.core.fakes.ManualExecutor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class AdvertiserTest {
  private val test: UUID = UUID.fromString("0c6c1000-b347-4cfa-9827-1c5a13658519")
  private val heartRate: UUID = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb")
  private val uuid32: UUID = UUID.fromString("1234abcd-0000-1000-8000-00805f9b34fb")

  private fun spec(
    localName: String? = null,
    serviceUuids: List<UUID> = emptyList(),
    manufacturer: ManufacturerSpec? = null,
    serviceData: List<ServiceDataSpec> = emptyList(),
    includeTxPower: Boolean = false,
    connectable: Boolean = true,
    extended: Boolean = false,
    timeoutMs: Int? = null,
  ) = AdvertisingSpec(
    localName, serviceUuids, manufacturer, serviceData, includeTxPower, connectable,
    AdvertisingMode.LOW_LATENCY, AdvertisingTxPower.MEDIUM, extended, timeoutMs,
  )

  // Layout (sizes as AOSP's BluetoothLeAdvertiser.totalBytes counts them)

  @Test
  fun `UUIDs are written in 2, 4 or 16 bytes and grouped by length`() {
    assertEquals(2, AdvertisingLayouts.uuidLength(heartRate))
    assertEquals(4, AdvertisingLayouts.uuidLength(uuid32))
    assertEquals(16, AdvertisingLayouts.uuidLength(test))
    // One field per length: 2 + 2 × 2, 2 + 4, 2 + 16.
    assertEquals(6 + 6 + 18, AdvertisingLayouts.serviceUuidsSize(listOf(heartRate, heartRate, uuid32, test)))
  }

  @Test
  fun `legacy fields fill the advertising data, then the scan response after the name`() {
    // The test profile: 128-bit TEST (18) + 16-bit Heart Rate (4) = 22 of 28 bytes (flags take 3).
    val layout = AdvertisingLayouts.plan(
      spec(
        localName = "Galaxy A52",
        serviceUuids = listOf(test, heartRate),
        manufacturer = ManufacturerSpec(0xFFFF, byteArrayOf(0x42, 0x4B, 0, 1)), // 8 bytes: scan response
        serviceData = listOf(ServiceDataSpec(heartRate, byteArrayOf(1, 2))), // 6 bytes: fits the advertising data
      ),
      nameLength = 10,
      maxExtended = 251,
    )
    assertTrue(layout.legacy)
    assertEquals(listOf(test, heartRate), layout.advertising.serviceUuids)
    assertEquals(1, layout.advertising.serviceData.size)
    assertNull(layout.advertising.manufacturerData)
    val response = layout.scanResponse!!
    assertTrue(response.includeName)
    assertEquals(0xFFFF, response.manufacturerData!!.companyId)
    assertTrue(layout.warnings.isEmpty())
  }

  @Test
  fun `a field that fits nowhere is refused, a name too long is dropped with a warning`() {
    val tooMuch = spec(serviceData = listOf(ServiceDataSpec(test, ByteArray(30))))
    val error = runCatching { AdvertisingLayouts.plan(tooMuch, 0, 251) }.exceptionOrNull() as CoreError
    assertEquals(CoreError.Code.ADVERTISING_FAILED, error.code)
    assertTrue(error.message!!.contains("serviceData"))

    val longName = AdvertisingLayouts.plan(spec(localName = "x"), nameLength = 30, maxExtended = 251)
    assertFalse(longName.scanResponse!!.includeName)
    assertEquals(1, longName.warnings.size)
  }

  @Test
  fun `an unknown name length keeps the scan response for the name`() {
    // 18 + 10 bytes fill the 28 of the advertising data.
    val layout = AdvertisingLayouts.plan(
      spec(localName = "x", manufacturer = ManufacturerSpec(1, ByteArray(6)), serviceUuids = listOf(test)),
      nameLength = null,
      maxExtended = 251,
    )
    assertTrue(layout.scanResponse!!.includeName)
    assertEquals(1, layout.advertising.manufacturerData!!.companyId)
    // 24 + 10 don't, and the scan response is the name's.
    val error = runCatching {
      AdvertisingLayouts.plan(
        spec(localName = "x", manufacturer = ManufacturerSpec(1, ByteArray(6)), serviceUuids = listOf(test, uuid32)),
        nameLength = null,
        maxExtended = 251,
      )
    }.exceptionOrNull() as CoreError
    assertEquals(CoreError.Code.ADVERTISING_FAILED, error.code)
  }

  @Test
  fun `non-connectable advertising has no flags and is scannable only with a scan response`() {
    val bare = AdvertisingLayouts.plan(spec(connectable = false, serviceUuids = listOf(test)), 10, 251)
    assertNull(bare.scanResponse)
    // 31 bytes without flags: 18 + 13 = 31 fits.
    val full = AdvertisingLayouts.plan(
      spec(
        connectable = false,
        serviceUuids = listOf(test),
        serviceData = listOf(ServiceDataSpec(heartRate, ByteArray(9))),
      ),
      10,
      251,
    )
    assertEquals(1, full.advertising.serviceData.size)
    val named = AdvertisingLayouts.plan(spec(connectable = false, localName = "n"), 1, 251)
    assertTrue(named.scanResponse!!.includeName)
  }

  @Test
  fun `extended advertising puts everything in the advertising data, up to the controller's maximum`() {
    val layout = AdvertisingLayouts.plan(
      spec(
        localName = "x",
        serviceUuids = listOf(test),
        manufacturer = ManufacturerSpec(1, ByteArray(200)),
        extended = true,
      ),
      nameLength = 10,
      maxExtended = 251,
    )
    assertFalse(layout.legacy)
    assertNull(layout.scanResponse)
    assertTrue(layout.advertising.includeName)
    assertEquals(1, layout.advertising.manufacturerData!!.companyId)
    val error = runCatching {
      AdvertisingLayouts.plan(spec(manufacturer = ManufacturerSpec(1, ByteArray(250)), extended = true), 0, 251)
    }.exceptionOrNull() as CoreError
    assertEquals(CoreError.Code.ADVERTISING_FAILED, error.code)
  }

  // The advertiser

  private class FakePort : AdvertiserPort {
    var capabilities: AdvertiserCapabilities? = AdvertiserCapabilities(true, 251, "Galaxy A52")
    val started = mutableListOf<AdvertisingLayout>()
    var events: AdvertiserEvents? = null
    var stops = 0
    var refuse: RuntimeException? = null

    override fun capabilities() = capabilities

    override fun start(layout: AdvertisingLayout, spec: AdvertisingSpec, events: AdvertiserEvents) {
      refuse?.let { throw it }
      started += layout
      this.events = events
    }

    override fun stop() {
      stops++
    }
  }

  private val executor = ManualExecutor()
  private val port = FakePort()
  private val advertiser = Advertiser(executor, port)
  private val warnings = mutableListOf<String>()

  init {
    advertiser.onWarning = { warnings += it.message!! }
  }

  private fun start(spec: AdvertisingSpec = spec(serviceUuids = listOf(test))): () -> String {
    var result = "pending"
    advertiser.start(spec) { id, error -> result = error?.code?.value ?: "id $id" }
    return { result }
  }

  @Test
  fun `one advertisement at a time, and a stale id stops nothing`() {
    val first = start()
    port.events!!.onStarted(AdvertisingLayouts.ADVERTISE_SUCCESS)
    assertEquals("id 1", first())
    assertEquals("ADVERTISING_FAILED", start()())
    advertiser.stop(7)
    assertEquals(0, port.stops)
    advertiser.stop(1)
    assertEquals(1, port.stops)
    assertNull(advertiser.running)
    val second = start()
    port.events!!.onStarted(AdvertisingLayouts.ADVERTISE_SUCCESS)
    assertEquals("id 2", second())
    advertiser.stop(1)
    assertEquals(2, advertiser.running)
  }

  @Test
  fun `start statuses, refusals and the start deadline`() {
    val tooLarge = start()
    port.events!!.onStarted(AdvertisingLayouts.ADVERTISE_FAILED_DATA_TOO_LARGE)
    assertEquals("ADVERTISING_FAILED", tooLarge())
    val unsupported = start()
    port.events!!.onStarted(AdvertisingLayouts.ADVERTISE_FAILED_FEATURE_UNSUPPORTED)
    assertEquals("NOT_SUPPORTED", unsupported())

    port.refuse = IllegalArgumentException("Legacy advertising data too big")
    assertEquals("ADVERTISING_FAILED", start()())
    port.refuse = IllegalStateException("BT Adapter is not turned ON")
    assertEquals("BLUETOOTH_POWERED_OFF", start()())
    port.refuse = null

    val silent = start()
    executor.advanceBy(Advertiser.START_TIMEOUT_MS)
    assertEquals("OPERATION_TIMEOUT", silent())
    port.events!!.onStarted(AdvertisingLayouts.ADVERTISE_SUCCESS) // too late: ignored
    assertNull(advertiser.running)
  }

  @Test
  fun `capabilities, the name warning, and the end of an advertisement`() {
    port.capabilities = AdvertiserCapabilities(false, 31, "Galaxy A52")
    assertEquals("NOT_SUPPORTED", start(spec(extended = true))())
    port.capabilities = null
    assertEquals("NOT_SUPPORTED", start()())
    port.capabilities = AdvertiserCapabilities(false, 31, "Galaxy A52")

    val named = start(spec(localName = "BleKit-Test"))
    assertEquals(
      listOf("Android can't advertise the name 'BleKit-Test': it advertises its Bluetooth name 'Galaxy A52'"),
      warnings,
    )
    port.events!!.onStarted(AdvertisingLayouts.ADVERTISE_SUCCESS)
    assertEquals("id 1", named())
    port.events!!.onDisabled() // the timeout elapsed
    assertNull(advertiser.running)

    val again = start(spec(localName = "Galaxy A52"))
    assertEquals(1, warnings.size)
    port.events!!.onStarted(AdvertisingLayouts.ADVERTISE_SUCCESS)
    assertEquals("id 2", again())
    advertiser.close(CoreError(CoreError.Code.BLUETOOTH_POWERED_OFF, "off"))
    assertNull(advertiser.running)
    val pending = start()
    advertiser.close(CoreError(CoreError.Code.BLUETOOTH_POWERED_OFF, "off"))
    assertEquals("BLUETOOTH_POWERED_OFF", pending())
  }

  @Test
  fun `constants match Android`() {
    assertEquals(AdvertisingSetParameters.INTERVAL_HIGH, AdvertisingMode.LOW_POWER.interval)
    assertEquals(AdvertisingSetParameters.INTERVAL_MEDIUM, AdvertisingMode.BALANCED.interval)
    assertEquals(AdvertisingSetParameters.INTERVAL_LOW, AdvertisingMode.LOW_LATENCY.interval)
    assertEquals(AdvertisingSetParameters.TX_POWER_ULTRA_LOW, AdvertisingTxPower.ULTRA_LOW.dbm)
    assertEquals(AdvertisingSetParameters.TX_POWER_LOW, AdvertisingTxPower.LOW.dbm)
    assertEquals(AdvertisingSetParameters.TX_POWER_MEDIUM, AdvertisingTxPower.MEDIUM.dbm)
    assertEquals(AdvertisingSetParameters.TX_POWER_HIGH, AdvertisingTxPower.HIGH.dbm)
    assertEquals(AdvertisingSetCallback.ADVERTISE_SUCCESS, AdvertisingLayouts.ADVERTISE_SUCCESS)
    assertEquals(
      AdvertisingSetCallback.ADVERTISE_FAILED_DATA_TOO_LARGE,
      AdvertisingLayouts.ADVERTISE_FAILED_DATA_TOO_LARGE,
    )
    assertEquals(
      AdvertisingSetCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS,
      AdvertisingLayouts.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS,
    )
    assertEquals(
      AdvertisingSetCallback.ADVERTISE_FAILED_ALREADY_STARTED,
      AdvertisingLayouts.ADVERTISE_FAILED_ALREADY_STARTED,
    )
    assertEquals(
      AdvertisingSetCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED,
      AdvertisingLayouts.ADVERTISE_FAILED_FEATURE_UNSUPPORTED,
    )
  }
}
