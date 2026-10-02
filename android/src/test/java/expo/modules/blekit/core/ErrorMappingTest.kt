package expo.modules.blekit.core

import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** P1-10: every Android status maps to a library code (plan §4.11, Appendix A.1). */
class ErrorMappingTest {
  @Test
  fun `operation statuses follow Appendix A`() {
    val expected =
      mapOf(
        BluetoothGatt.GATT_READ_NOT_PERMITTED to CoreError.Code.READ_NOT_PERMITTED,
        BluetoothGatt.GATT_WRITE_NOT_PERMITTED to CoreError.Code.WRITE_NOT_PERMITTED,
        BluetoothGatt.GATT_INSUFFICIENT_AUTHENTICATION to CoreError.Code.INSUFFICIENT_AUTHENTICATION,
        BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED to CoreError.Code.NOT_SUPPORTED,
        BluetoothGatt.GATT_INVALID_OFFSET to CoreError.Code.INVALID_OFFSET,
        BluetoothGatt.GATT_INSUFFICIENT_AUTHORIZATION to CoreError.Code.INSUFFICIENT_AUTHORIZATION,
        BluetoothGatt.GATT_INVALID_ATTRIBUTE_LENGTH to CoreError.Code.INVALID_ATTRIBUTE_LENGTH,
        BluetoothGatt.GATT_INSUFFICIENT_ENCRYPTION to CoreError.Code.INSUFFICIENT_ENCRYPTION,
        BluetoothGatt.GATT_CONNECTION_CONGESTED to CoreError.Code.CONGESTED,
        BluetoothGatt.GATT_FAILURE to CoreError.Code.GATT_ERROR,
        BluetoothGatt.GATT_CONNECTION_TIMEOUT to CoreError.Code.DISCONNECTED,
        0x85 to CoreError.Code.GATT_ERROR,
      )
    for ((status, code) in expected) {
      val error = AndroidErrorMapping.operationError(status, "read")!!
      assertEquals("status $status", code, error.code)
      assertEquals(status, error.gattStatus)
    }
    assertNull(AndroidErrorMapping.operationError(BluetoothGatt.GATT_SUCCESS, "read"))
    assertTrue(AndroidErrorMapping.operationError(BluetoothGatt.GATT_CONNECTION_CONGESTED, "write")!!.retryable)
    assertFalse(AndroidErrorMapping.operationError(BluetoothGatt.GATT_INSUFFICIENT_ENCRYPTION, "read")!!.retryable)
  }

  @Test
  fun `every ATT error code maps like on iOS`() {
    // Same table as ios/Tests/ErrorMappingTests.swift.
    val expected =
      mapOf(
        0x01 to CoreError.Code.GATT_ERROR,
        0x02 to CoreError.Code.READ_NOT_PERMITTED,
        0x03 to CoreError.Code.WRITE_NOT_PERMITTED,
        0x04 to CoreError.Code.GATT_ERROR,
        0x05 to CoreError.Code.INSUFFICIENT_AUTHENTICATION,
        0x06 to CoreError.Code.NOT_SUPPORTED,
        0x07 to CoreError.Code.INVALID_OFFSET,
        0x08 to CoreError.Code.INSUFFICIENT_AUTHORIZATION,
        0x09 to CoreError.Code.GATT_ERROR,
        0x0A to CoreError.Code.GATT_ERROR,
        0x0B to CoreError.Code.GATT_ERROR,
        0x0C to CoreError.Code.INSUFFICIENT_ENCRYPTION,
        0x0D to CoreError.Code.INVALID_ATTRIBUTE_LENGTH,
        0x0E to CoreError.Code.GATT_ERROR,
        0x0F to CoreError.Code.INSUFFICIENT_ENCRYPTION,
        0x10 to CoreError.Code.NOT_SUPPORTED,
        0x11 to CoreError.Code.GATT_ERROR,
      )
    for (att in 0x01..0x11) {
      assertEquals("ATT $att", expected[att], AttErrorMapping.code(att))
      assertEquals("ATT $att retryable", att == 0x11, AttErrorMapping.isRetryable(att))
    }
  }

  @Test
  fun `connection statuses depend on whether the link was up`() {
    for (status in listOf(0x08, 0x13, 0x16, 0x3E, 0x85, BluetoothGatt.GATT_CONNECTION_TIMEOUT)) {
      val failed = AndroidErrorMapping.connectionError(status, wasConnected = false)
      assertEquals(CoreError.Code.CONNECTION_FAILED, failed.code)
      assertEquals(status, failed.gattStatus)
      val lost = AndroidErrorMapping.connectionError(status, wasConnected = true)
      assertEquals(CoreError.Code.DISCONNECTED, lost.code)
    }
    assertTrue("133 before connecting is retried", AndroidErrorMapping.connectionError(0x85, false).retryable)
    assertTrue("link loss may recover", AndroidErrorMapping.connectionError(0x08, true).retryable)
    assertFalse("a local disconnect is ours", AndroidErrorMapping.connectionError(0x16, true).retryable)
  }

  @Test
  fun `scan failures map to scan codes`() {
    assertEquals(
      CoreError.Code.SCAN_THROTTLED,
      AndroidErrorMapping.scanError(ScanCallback.SCAN_FAILED_SCANNING_TOO_FREQUENTLY).code,
    )
    assertEquals(
      CoreError.Code.NOT_SUPPORTED,
      AndroidErrorMapping.scanError(ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED).code,
    )
    for (code in listOf(1, 2, 3, 5)) {
      assertEquals(CoreError.Code.SCAN_FAILED, AndroidErrorMapping.scanError(code).code)
    }
    assertFalse(AndroidErrorMapping.scanError(ScanCallback.SCAN_FAILED_ALREADY_STARTED).retryable)
    assertTrue(AndroidErrorMapping.scanError(ScanCallback.SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES).retryable)
    assertTrue(AndroidErrorMapping.scanError(ScanCallback.SCAN_FAILED_SCANNING_TOO_FREQUENTLY).retryable)
    assertEquals(CoreError.Code.SCAN_FAILED, AndroidErrorMapping.scanError(99).code)
  }

  @Test
  fun `submit statuses map to codes`() {
    assertNull(AndroidErrorMapping.submitError(BluetoothStatusCodes.SUCCESS, "write"))
    val expected =
      mapOf(
        BluetoothStatusCodes.ERROR_BLUETOOTH_NOT_ENABLED to CoreError.Code.BLUETOOTH_POWERED_OFF,
        BluetoothStatusCodes.ERROR_MISSING_BLUETOOTH_CONNECT_PERMISSION to CoreError.Code.PERMISSION_DENIED,
        BluetoothStatusCodes.ERROR_GATT_WRITE_NOT_ALLOWED to CoreError.Code.WRITE_NOT_PERMITTED,
        BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY to CoreError.Code.GATT_ERROR,
        BluetoothStatusCodes.ERROR_PROFILE_SERVICE_NOT_BOUND to CoreError.Code.BLUETOOTH_RESETTING,
        BluetoothStatusCodes.ERROR_UNKNOWN to CoreError.Code.GATT_ERROR,
      )
    for ((status, code) in expected) {
      assertEquals("status $status", code, AndroidErrorMapping.submitError(status, "write")!!.code)
    }
    assertTrue(AndroidErrorMapping.submitError(BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY, "write")!!.retryable)
  }

  @Test
  fun `default retryability follows the plan`() {
    val retryable =
      setOf(
        CoreError.Code.BLUETOOTH_RESETTING,
        CoreError.Code.SCAN_THROTTLED,
        CoreError.Code.CONNECTION_FAILED,
        CoreError.Code.CONNECTION_TIMEOUT,
        CoreError.Code.OPERATION_TIMEOUT,
        CoreError.Code.CONGESTED,
      )
    for (code in CoreError.Code.entries) {
      assertEquals(code.value, code in retryable, CoreError(code, "x").retryable)
    }
  }
}
