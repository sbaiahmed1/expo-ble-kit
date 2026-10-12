package expo.modules.blekit.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

/** P5-05: the rules of CompanionDeviceManager associations and presence. */
class CompanionDevicesTest {
  private val testService = "0c6c1000-b347-4cfa-9827-1c5a13658519"

  private fun errorOf(block: () -> Unit) = runCatching(block).exceptionOrNull() as CoreError?

  @Test
  fun `a filter's services and name pattern are checked`() {
    val spec = CompanionDevices.spec(listOf(testService), "^BleKit", singleDevice = true)
    assertEquals(listOf(UUID.fromString(testService)), spec.services)
    assertEquals("^BleKit", spec.namePattern?.pattern())
    assertTrue(spec.singleDevice)
    assertNull(CompanionDevices.spec(emptyList(), null, singleDevice = false).namePattern)

    assertEquals(CoreError.Code.INVALID_ARGUMENT, errorOf { CompanionDevices.spec(listOf("heart"), null, false) }?.code)
    val pattern = errorOf { CompanionDevices.spec(emptyList(), "BleKit(", false) }
    assertEquals(CoreError.Code.INVALID_ARGUMENT, pattern?.code)
    assertTrue(pattern!!.message!!.contains("name pattern"))
  }

  @Test
  fun `a closed picker or no device resolves null, other failures reject`() {
    assertNull(CompanionDevices.failure(null, "Timeout"))
    assertNull(CompanionDevices.failure(CompanionDevices.RESULT_CANCELED, "canceled"))
    assertNull(CompanionDevices.failure(CompanionDevices.RESULT_USER_REJECTED, "rejected"))
    assertNull(CompanionDevices.failure(CompanionDevices.RESULT_DISCOVERY_TIMEOUT, "timeout"))
    assertEquals(
      CoreError.Code.MISCONFIGURED,
      CompanionDevices.failure(CompanionDevices.RESULT_SECURITY_ERROR, "no feature")?.code,
    )
    assertEquals(CoreError.Code.INTERNAL, CompanionDevices.failure(CompanionDevices.RESULT_INTERNAL_ERROR, null)?.code)
  }

  @Test
  fun `presence needs Android 12, the system feature and the plugin's declarations`() {
    val permission = CompanionDevices.OBSERVE_PRESENCE_PERMISSION
    assertEquals(
      CoreError.Code.NOT_SUPPORTED,
      errorOf { CompanionDevices.checkPresence(30, true, setOf(permission), serviceDeclared = true) }?.code,
    )
    assertEquals(
      CoreError.Code.NOT_SUPPORTED,
      errorOf { CompanionDevices.checkPresence(33, false, setOf(permission), serviceDeclared = true) }?.code,
    )
    val missing = errorOf { CompanionDevices.checkPresence(33, true, emptySet(), serviceDeclared = false) }
    assertEquals(CoreError.Code.MISCONFIGURED, missing?.code)
    assertTrue(missing!!.message!!.contains(permission))
    assertTrue(missing.message!!.contains("presence service"))
    assertTrue(missing.message!!.contains("android.companionDevice"))
    assertNull(errorOf { CompanionDevices.checkPresence(31, true, setOf(permission), serviceDeclared = true) })
  }

  @Test
  fun `a task's events come from its persisted options`() {
    assertEquals(setOf("devicePresence"), CompanionDevices.events(mapOf("events" to listOf("devicePresence"))))
    assertEquals(emptySet<String>(), CompanionDevices.events(emptyMap()))
  }

  @Test
  fun `each presence change is reported once`() {
    val tracker = PresenceTracker()
    assertTrue(tracker.update("AA:BB:CC:DD:EE:FF", true))
    assertFalse("the same change from another callback", tracker.update("AA:BB:CC:DD:EE:FF", true))
    assertTrue(tracker.update("AA:BB:CC:DD:EE:FF", false))
    assertTrue(tracker.update("11:22:33:44:55:66", false))
  }

  @Test
  fun `an association settles once, with the normalized address`() {
    val results = mutableListOf<Result<String?>>()
    val association = CompanionAssociation { results.add(it) }
    association.finish("aa:bb:cc:dd:ee:ff")
    association.finish(null)
    association.fail(CoreError(CoreError.Code.INTERNAL, "late"))
    assertEquals(listOf(Result.success<String?>("AA:BB:CC:DD:EE:FF")), results)
    assertTrue(association.finished)

    val failed = mutableListOf<Result<String?>>()
    CompanionAssociation { failed.add(it) }.apply {
      fail(CoreError(CoreError.Code.MISCONFIGURED, "no feature"))
      finish("AA:BB:CC:DD:EE:FF")
    }
    assertEquals(1, failed.size)
    assertTrue(failed[0].isFailure)
  }
}
