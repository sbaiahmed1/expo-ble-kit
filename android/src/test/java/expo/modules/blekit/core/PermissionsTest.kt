package expo.modules.blekit.core

import expo.modules.blekit.core.AndroidPermissions.ACCESS_BACKGROUND_LOCATION
import expo.modules.blekit.core.AndroidPermissions.ACCESS_FINE_LOCATION
import expo.modules.blekit.core.AndroidPermissions.BLUETOOTH
import expo.modules.blekit.core.AndroidPermissions.BLUETOOTH_ADMIN
import expo.modules.blekit.core.AndroidPermissions.BLUETOOTH_ADVERTISE
import expo.modules.blekit.core.AndroidPermissions.BLUETOOTH_CONNECT
import expo.modules.blekit.core.AndroidPermissions.BLUETOOTH_SCAN
import expo.modules.blekit.core.BleCapability.ADVERTISE
import expo.modules.blekit.core.BleCapability.BACKGROUND_SCAN
import expo.modules.blekit.core.BleCapability.CONNECT
import expo.modules.blekit.core.BleCapability.SCAN
import expo.modules.blekit.core.PermissionStatus.DENIED
import expo.modules.blekit.core.PermissionStatus.GRANTED
import expo.modules.blekit.core.PermissionStatus.UNDETERMINED
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** P1-03: the permission rules of plan §4.13 per API level, and the declaration checks. */
class PermissionsTest {
  /** What the config plugin declares with its defaults, as Android reports it on [sdkInt]. */
  private fun pluginDefaults(sdkInt: Int) = DeclaredPermissions(
    names = if (sdkInt <= 30) {
      setOf(BLUETOOTH, BLUETOOTH_ADMIN, ACCESS_FINE_LOCATION)
    } else {
      setOf(BLUETOOTH_SCAN, BLUETOOTH_CONNECT)
    },
    scanNeverForLocation = true,
  )

  private fun policy(sdkInt: Int, declared: DeclaredPermissions = pluginDefaults(sdkInt)) =
    BlePermissionPolicy(sdkInt, declared)

  @Test
  fun `runtime permissions per API level`() {
    for (sdkInt in listOf(26, 28)) {
      val policy = policy(sdkInt)
      assertEquals(listOf(ACCESS_FINE_LOCATION), policy.runtimePermissions(SCAN))
      assertEquals(emptyList<String>(), policy.runtimePermissions(CONNECT))
      assertEquals(emptyList<String>(), policy.runtimePermissions(ADVERTISE))
      assertEquals(listOf(ACCESS_FINE_LOCATION), policy.runtimePermissions(BACKGROUND_SCAN))
    }
    for (sdkInt in listOf(29, 30)) {
      assertEquals(
        listOf(ACCESS_FINE_LOCATION, ACCESS_BACKGROUND_LOCATION),
        policy(sdkInt).runtimePermissions(BACKGROUND_SCAN),
      )
    }
    for (sdkInt in listOf(31, 34, 36)) {
      val policy = policy(sdkInt)
      assertEquals(listOf(BLUETOOTH_SCAN), policy.runtimePermissions(SCAN))
      assertEquals(listOf(BLUETOOTH_CONNECT), policy.runtimePermissions(CONNECT))
      assertEquals(listOf(BLUETOOTH_ADVERTISE), policy.runtimePermissions(ADVERTISE))
      assertEquals(listOf(BLUETOOTH_SCAN), policy.runtimePermissions(BACKGROUND_SCAN))
    }
  }

  @Test
  fun `scanning needs location on Android 12+ without neverForLocation`() {
    val declared = DeclaredPermissions(setOf(BLUETOOTH_SCAN, BLUETOOTH_CONNECT), scanNeverForLocation = false)
    val policy = policy(31, declared)
    assertEquals(listOf(BLUETOOTH_SCAN, ACCESS_FINE_LOCATION), policy.runtimePermissions(SCAN))
    // A location permission capped at API 30 isn't visible on API 31, so the check names it.
    assertEquals(listOf(ACCESS_FINE_LOCATION), policy.missingDeclarations(BleCapability.BASE))
  }

  @Test
  fun `the plugin defaults declare the base capabilities on every API level`() {
    for (sdkInt in 26..36) {
      val policy = policy(sdkInt)
      assertEquals("API $sdkInt", emptyList<String>(), policy.missingDeclarations(BleCapability.BASE))
      policy.checkDeclared(BleCapability.BASE)
    }
  }

  @Test
  fun `install-time permissions are required up to API 30`() {
    assertEquals(listOf(BLUETOOTH), policy(30).requiredDeclarations(CONNECT))
    assertEquals(listOf(BLUETOOTH, BLUETOOTH_ADMIN, ACCESS_FINE_LOCATION), policy(30).requiredDeclarations(SCAN))
    assertEquals(listOf(BLUETOOTH, BLUETOOTH_ADMIN), policy(30).requiredDeclarations(ADVERTISE))
    assertEquals(listOf(BLUETOOTH_CONNECT), policy(31).requiredDeclarations(CONNECT))
  }

  @Test
  fun `a missing declaration is MISCONFIGURED and names every entry`() {
    val declared = DeclaredPermissions(setOf(BLUETOOTH_SCAN), scanNeverForLocation = true)
    val error = assertThrows(CoreError::class.java) {
      policy(34, declared).checkDeclared(listOf(SCAN, CONNECT, ADVERTISE))
    }
    assertEquals(CoreError.Code.MISCONFIGURED, error.code)
    assertTrue(error.message!!, error.message!!.contains("$BLUETOOTH_CONNECT, $BLUETOOTH_ADVERTISE"))
    assertTrue(error.message!!, error.message!!.contains("API 34"))

    val legacy = DeclaredPermissions(setOf(BLUETOOTH, ACCESS_FINE_LOCATION), scanNeverForLocation = false)
    assertEquals(listOf(BLUETOOTH_ADMIN), policy(30, legacy).missingDeclarations(BleCapability.BASE))
  }

  @Test
  fun `background location is requested last and alone`() {
    assertEquals(
      listOf(listOf(ACCESS_FINE_LOCATION), listOf(ACCESS_BACKGROUND_LOCATION)),
      policy(30).requestStages(listOf(BACKGROUND_SCAN, SCAN, CONNECT)),
    )
    assertEquals(
      listOf(listOf(BLUETOOTH_SCAN, BLUETOOTH_CONNECT)),
      policy(34).requestStages(listOf(SCAN, CONNECT, BACKGROUND_SCAN)),
    )
    assertEquals(listOf(listOf(ACCESS_FINE_LOCATION)), policy(28).requestStages(listOf(SCAN, CONNECT)))
    assertEquals(emptyList<List<String>>(), policy(28).requestStages(listOf(CONNECT)))
  }

  @Test
  fun `statuses combine per capability`() {
    val policy = policy(34)
    val results = mapOf(
      BLUETOOTH_SCAN to PermissionResult(GRANTED, canAskAgain = true),
      BLUETOOTH_CONNECT to PermissionResult(DENIED, canAskAgain = true),
    )
    val permissions = policy.permissions(results)
    assertEquals(GRANTED, permissions.statuses[SCAN])
    assertEquals(DENIED, permissions.statuses[CONNECT])
    // Not declared: requesting it would be MISCONFIGURED.
    assertEquals(DENIED, permissions.statuses[ADVERTISE])
    assertEquals(GRANTED, permissions.statuses[BACKGROUND_SCAN])
    assertTrue(permissions.canAskAgain)
    assertEquals(
      mapOf(
        "scan" to "granted",
        "connect" to "denied",
        "advertise" to "denied",
        "backgroundScan" to "granted",
        "canAskAgain" to true,
      ),
      permissions.toJs(),
    )

    val blocked = policy.permissions(results + (BLUETOOTH_CONNECT to PermissionResult(DENIED, canAskAgain = false)))
    assertFalse(blocked.canAskAgain)

    val fresh = policy.permissions(emptyMap())
    assertEquals(UNDETERMINED, fresh.statuses[SCAN])
    assertTrue(fresh.canAskAgain)

    // Up to API 30, connecting needs no runtime permission.
    val legacy = policy(30).permissions(mapOf(ACCESS_FINE_LOCATION to PermissionResult(UNDETERMINED, true)))
    assertEquals(GRANTED, legacy.statuses[CONNECT])
    assertEquals(UNDETERMINED, legacy.statuses[SCAN])
    assertEquals(GRANTED, legacy.statuses[ADVERTISE])
    assertEquals("ACCESS_BACKGROUND_LOCATION isn't declared", DENIED, legacy.statuses[BACKGROUND_SCAN])
  }

  @Test
  fun `combine prefers denied over undetermined`() {
    val granted = PermissionResult(GRANTED, true)
    val denied = PermissionResult(DENIED, true)
    val undetermined = PermissionResult(UNDETERMINED, true)
    assertEquals(GRANTED, BlePermissionPolicy.combine(emptyList()))
    assertEquals(GRANTED, BlePermissionPolicy.combine(listOf(granted, granted)))
    assertEquals(UNDETERMINED, BlePermissionPolicy.combine(listOf(granted, undetermined)))
    assertEquals(DENIED, BlePermissionPolicy.combine(listOf(undetermined, denied)))
  }

  @Test
  fun `the adapter needs BLUETOOTH_CONNECT on Android 12+`() {
    assertTrue(policy(30).isAuthorized { false })
    assertFalse(policy(31).isAuthorized { false })
    assertTrue(policy(31).isAuthorized { it == BLUETOOTH_CONNECT })
    val undeclared = DeclaredPermissions(setOf(BLUETOOTH_SCAN), scanNeverForLocation = true)
    assertFalse(policy(31, undeclared).isAuthorized { true })
  }

  @Test
  fun `js message carries the details`() {
    assertEquals(
      "Write failed [blekit]{\"gattStatus\":133,\"retryable\":true}",
      CoreError(CoreError.Code.GATT_ERROR, "Write failed", gattStatus = 133, retryable = true).jsMessage,
    )
    assertEquals(
      "No entry [blekit]{\"retryable\":false}",
      CoreError(CoreError.Code.MISCONFIGURED, "No entry").jsMessage,
    )
  }
}
