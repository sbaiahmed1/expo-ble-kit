package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.scanRecord
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

/** P1-04: session filters, the platform-scan union, and the JS shape of results. */
class ScanningTest {
  private val heartRate = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb")
  private val battery = UUID.fromString("0000180f-0000-1000-8000-00805f9b34fb")

  private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

  @Test
  fun `manufacturer filters compare a prefix under the mask`() {
    val filter = ManufacturerFilter(0xFFFF, data = bytes(0x42, 0x4B), mask = bytes(0xFF, 0x0F))
    assertTrue(filter.matches(bytes(0x42, 0x4B, 0x00, 0x01)))
    assertTrue(filter.matches(bytes(0x42, 0xFB)))
    assertFalse(filter.matches(bytes(0x43, 0x4B)))
    assertFalse(filter.matches(bytes(0x42)))
    assertTrue(ManufacturerFilter(0xFFFF).matches(ByteArray(0)))
  }

  @Test
  fun `a session matches only when every criterion does`() {
    val spec = ScanSpec(
      services = listOf(heartRate, battery),
      namePrefix = "BleKit",
      manufacturerData = listOf(ManufacturerFilter(0xFFFF, bytes(0x42))),
    )
    val match = scanRecord(
      "AA",
      name = "BleKit-Test",
      services = listOf(battery),
      manufacturerData = mapOf(0xFFFF to bytes(0x42, 0x4B)),
    )
    assertTrue(spec.matches(match))
    assertFalse(spec.matches(scanRecord("AA", name = "Other", services = listOf(battery))))
    assertFalse(spec.matches(scanRecord("AA", name = "BleKit-Test", manufacturerData = match.manufacturerData)))
    assertFalse(
      spec.matches(
        scanRecord("AA", name = "BleKit", services = listOf(heartRate), manufacturerData = mapOf(1 to bytes(0x42))),
      ),
    )
    assertTrue(ScanSpec().matches(scanRecord("BB")))
  }

  @Test
  fun `platform filters select a superset of the session`() {
    val both = ScanSpec(
      services = listOf(heartRate, battery),
      manufacturerData = listOf(ManufacturerFilter(1, bytes(1), bytes(0xFF)), ManufacturerFilter(2)),
    ).platformFilters()
    assertEquals(4, both.size)
    assertEquals(listOf(heartRate, heartRate, battery, battery), both.map { it.serviceUuid })
    assertEquals(listOf(1, 2, 1, 2), both.map { it.manufacturerId })
    assertNull("a mask needs data", both[1].manufacturerDataMask)
    // Android can't filter by name prefix in hardware.
    assertEquals(emptyList<ScanFilterSpec>(), ScanSpec(namePrefix = "BleKit").platformFilters())
  }

  @Test
  fun `the union is unfiltered if any session is, and takes the most demanding settings`() {
    val heartRateOnly =
      ScanSpec(services = listOf(heartRate), settings = ScanSettingsSpec(scanMode = ScanModes.LOW_POWER))
    val batteryOnly = ScanSpec(
      services = listOf(battery),
      settings = ScanSettingsSpec(scanMode = ScanModes.LOW_LATENCY, legacy = false, reportDelayMs = 500, matchMode = 2),
    )
    val union = PlatformScan.union(listOf(heartRateOnly, batteryOnly))
    assertEquals(setOf(heartRate, battery), union.filters.map { it.serviceUuid }.toSet())
    assertEquals(ScanModes.LOW_LATENCY, union.settings.scanMode)
    assertFalse(union.settings.legacy)
    assertEquals(0L, union.settings.reportDelayMs)
    assertEquals(1, union.settings.matchMode)

    assertEquals(emptyList<ScanFilterSpec>(), PlatformScan.union(listOf(heartRateOnly, ScanSpec())).filters)
    assertEquals(PlatformScan.union(listOf(heartRateOnly)), PlatformScan.union(listOf(heartRateOnly, heartRateOnly)))
    val firstMatch = ScanSpec(settings = ScanSettingsSpec(callbackType = 2))
    assertEquals(2, PlatformScan.union(listOf(firstMatch)).settings.callbackType)
    assertEquals(PlatformScan.ALL_MATCHES, PlatformScan.union(listOf(firstMatch, ScanSpec())).settings.callbackType)
  }

  @Test
  fun `advertisements lose Android's zero padding`() {
    val padded = bytes(0x02, 0x01, 0x06, 0x03, 0xFF, 0x34, 0x12, 0x00, 0x00, 0x00)
    assertArrayEquals(bytes(0x02, 0x01, 0x06, 0x03, 0xFF, 0x34, 0x12), trimAdvertisement(padded))
    assertArrayEquals(bytes(0x05, 0x09), trimAdvertisement(bytes(0x05, 0x09)))
    assertArrayEquals(ByteArray(0), trimAdvertisement(ByteArray(62)))
  }

  @Test
  fun `results have the JS ScanResult shape`() {
    val record = ScanRecordData(
      address = "C0:FF:EE:00:00:01",
      name = "BleKit-Test",
      rssi = -55,
      txPowerLevel = 0,
      isConnectable = true,
      serviceUuids = listOf(heartRate),
      serviceData = mapOf(heartRate to bytes(1, 2)),
      manufacturerData = mapOf(0xFFFF to bytes(0x42, 0x4B)),
      rawBytes = bytes(0x02, 0x01, 0x06, 0x00, 0x00),
      timestampNanos = 7_000_000,
    )
    val js = record.toJs(EpochClock(wallAtStartMs = 1_700_000_000_000, monotonicAtStartMs = 2))
    assertEquals(
      listOf(
        "id",
        "name",
        "rssi",
        "txPowerLevel",
        "isConnectable",
        "serviceUUIDs",
        "serviceData",
        "manufacturerData",
        "rawAdvertisement",
        "timestamp",
      ),
      js.keys.toList(),
    )
    assertEquals(listOf("0000180d-0000-1000-8000-00805f9b34fb"), js["serviceUUIDs"])
    assertArrayEquals(
      bytes(1, 2),
      (js["serviceData"] as Map<*, *>)["0000180d-0000-1000-8000-00805f9b34fb"] as ByteArray,
    )
    assertArrayEquals(bytes(0x42, 0x4B), (js["manufacturerData"] as Map<*, *>)["65535"] as ByteArray)
    assertArrayEquals(bytes(0x02, 0x01, 0x06), js["rawAdvertisement"] as ByteArray)
    assertEquals(1_700_000_000_005.0, js["timestamp"])
  }

  @Test
  fun `JS option strings map to Android values`() {
    assertEquals(ScanModes.BALANCED, ScanOptionValues.scanMode(null))
    assertEquals(ScanModes.OPPORTUNISTIC, ScanOptionValues.scanMode("opportunistic"))
    assertEquals(ScanModes.LOW_LATENCY, ScanOptionValues.scanMode("lowLatency"))
    assertNull(ScanOptionValues.scanMode("fast"))
    assertEquals(4, ScanOptionValues.callbackType("matchLost"))
    assertEquals(2, ScanOptionValues.matchMode("sticky"))
    assertEquals(3, ScanOptionValues.phy("leCoded"))
    assertNull(ScanOptionValues.phy("le2m"))
  }
}
