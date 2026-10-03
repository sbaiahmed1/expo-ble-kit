package expo.modules.blekit.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

/** P3-04: the rules of background (PendingIntent) scans. */
class BackgroundScanningTest {
  private val testService = UUID.fromString("0c6c1000-b347-4cfa-9827-1c5a13658519")

  @Test
  fun `low power, and as few wakes as the controller allows`() {
    val filtering = BackgroundScanning.settings(offloadedFiltering = true, offloadedBatching = true)
    assertEquals(ScanModes.LOW_POWER, filtering.scanMode)
    assertEquals("first match", 2, filtering.callbackType)
    assertEquals(0L, filtering.reportDelayMs)

    val batching = BackgroundScanning.settings(offloadedFiltering = false, offloadedBatching = true)
    assertEquals("all matches", 1, batching.callbackType)
    assertEquals(BackgroundScanning.BATCH_DELAY_MS, batching.reportDelayMs)

    val neither = BackgroundScanning.settings(offloadedFiltering = false, offloadedBatching = false)
    assertEquals(1, neither.callbackType)
    assertEquals(0L, neither.reportDelayMs)
  }

  private fun policy(sdkInt: Int, vararg declared: String) =
    BlePermissionPolicy(sdkInt, DeclaredPermissions(declared.toSet(), scanNeverForLocation = true))

  private fun errorOf(block: () -> Unit) = runCatching(block).exceptionOrNull() as CoreError?

  @Test
  fun `Android 10 and 11 need background location, declared and granted`() {
    val fine = AndroidPermissions.ACCESS_FINE_LOCATION
    val background = AndroidPermissions.ACCESS_BACKGROUND_LOCATION
    val legacy = arrayOf(AndroidPermissions.BLUETOOTH, AndroidPermissions.BLUETOOTH_ADMIN, fine)

    val undeclared = errorOf { BackgroundScanning.check(policy(29, *legacy), { true }, null) }
    assertEquals(CoreError.Code.MISCONFIGURED, undeclared?.code)
    assertTrue(undeclared!!.message!!.contains(background))

    val denied = errorOf {
      BackgroundScanning.check(policy(30, *legacy, background), { it != background }, null)
    }
    assertEquals(CoreError.Code.PERMISSION_DENIED, denied?.code)
    assertTrue("names the missing permission", denied!!.message!!.contains(background))
    assertTrue(!denied.message!!.contains(fine))

    assertNull(errorOf { BackgroundScanning.check(policy(30, *legacy, background), { true }, null) })
  }

  @Test
  fun `Android 12 and later only need the scan permission, and an adapter that is on`() {
    val scan = AndroidPermissions.BLUETOOTH_SCAN
    assertNull(errorOf { BackgroundScanning.check(policy(34, scan), { true }, null) })
    assertEquals(
      CoreError.Code.PERMISSION_DENIED,
      errorOf { BackgroundScanning.check(policy(34, scan), { false }, null) }?.code,
    )
    val off = CoreError(CoreError.Code.BLUETOOTH_POWERED_OFF, "Bluetooth is off")
    assertEquals(off, errorOf { BackgroundScanning.check(policy(34, scan), { true }, off) })
  }

  @Test
  fun `reads the options TaskManager persisted, where JSON numbers can come back as doubles`() {
    val spec = BackgroundScanning.spec(
      mapOf(
        "events" to listOf("scanResults"),
        "scan" to mapOf(
          "services" to listOf(testService.toString()),
          "namePrefix" to "BleKit",
          "manufacturerData" to listOf(
            mapOf("companyId" to 76.0, "data" to listOf(2.0, 21.0), "mask" to null),
          ),
        ),
      ),
    )
    assertEquals(listOf(testService), spec.services)
    assertEquals("BleKit", spec.namePrefix)
    assertEquals(76, spec.manufacturerData.single().companyId)
    assertArrayEquals(byteArrayOf(2, 21), spec.manufacturerData.single().data)
    assertNull(spec.manufacturerData.single().mask)
    assertEquals("one hardware filter per service × manufacturer entry", 1, spec.platformFilters().size)
  }
}
