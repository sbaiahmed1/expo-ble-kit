package expo.modules.blekit.core

import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback

/**
 * ATT error codes (Bluetooth Core Spec Vol 3, Part F, 3.4.1.1). Android GATT operation statuses
 * 0x01–0x11 and iOS `CBATTError` raw values are these same codes; ios/Core/ErrorMapping.swift has
 * the identical table.
 */
object AttErrorMapping {
  fun code(att: Int): CoreError.Code = when (att) {
    0x02 -> CoreError.Code.READ_NOT_PERMITTED

    0x03 -> CoreError.Code.WRITE_NOT_PERMITTED

    0x05 -> CoreError.Code.INSUFFICIENT_AUTHENTICATION

    0x06 -> CoreError.Code.NOT_SUPPORTED

    // request not supported
    0x07 -> CoreError.Code.INVALID_OFFSET

    0x08 -> CoreError.Code.INSUFFICIENT_AUTHORIZATION

    0x0C, 0x0F -> CoreError.Code.INSUFFICIENT_ENCRYPTION

    // encryption key size, encryption
    0x0D -> CoreError.Code.INVALID_ATTRIBUTE_LENGTH

    0x10 -> CoreError.Code.NOT_SUPPORTED

    // unsupported group type
    else -> CoreError.Code.GATT_ERROR
  }

  /** Only "insufficient resources" (0x11) can succeed by simply trying again. */
  fun isRetryable(att: Int): Boolean = att == 0x11
}

/** Maps Android Bluetooth statuses to core errors (plan §4.11, Appendix A.1). */
object AndroidErrorMapping {
  /** HCI reason "connection terminated by local host" in onConnectionStateChange (Appendix A.1). */
  private const val HCI_LOCAL_HOST_TERMINATED = 0x16

  /** GATT operation callback status (read, write, descriptor, MTU…). Null on success. */
  fun operationError(status: Int, operation: String): CoreError? {
    if (status == BluetoothGatt.GATT_SUCCESS) return null
    val message = "$operation failed with GATT status $status"
    return when (status) {
      BluetoothGatt.GATT_CONNECTION_CONGESTED -> CoreError(CoreError.Code.CONGESTED, message, status)
      BluetoothGatt.GATT_FAILURE -> CoreError(CoreError.Code.GATT_ERROR, message, status)
      BluetoothGatt.GATT_CONNECTION_TIMEOUT -> CoreError(CoreError.Code.DISCONNECTED, message, status, retryable = true)
      else -> CoreError(AttErrorMapping.code(status), message, status, retryable = AttErrorMapping.isRetryable(status))
    }
  }

  /**
   * Status of an `onConnectionStateChange` to DISCONNECTED. Before the link was up it is a failed
   * connection attempt; after, a lost link.
   */
  fun connectionError(status: Int, wasConnected: Boolean): CoreError {
    if (!wasConnected) {
      val retryable = status != HCI_LOCAL_HOST_TERMINATED
      return CoreError(CoreError.Code.CONNECTION_FAILED, "Connection failed with status $status", status, retryable)
    }
    // Link loss (supervision timeout 0x08, remote terminated 0x13, 133, …) may recover through the
    // reconnect policy; a local disconnect (0x16) is one we asked for.
    val retryable = status != HCI_LOCAL_HOST_TERMINATED
    return CoreError(CoreError.Code.DISCONNECTED, "Disconnected with status $status", status, retryable)
  }

  /** `ScanCallback.onScanFailed` code. */
  fun scanError(errorCode: Int): CoreError {
    val message = "Scan failed with error $errorCode"
    return when (errorCode) {
      ScanCallback.SCAN_FAILED_SCANNING_TOO_FREQUENTLY ->
        CoreError(CoreError.Code.SCAN_THROTTLED, "Android limits how often an app can start scans", errorCode)

      ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED -> CoreError(CoreError.Code.NOT_SUPPORTED, message, errorCode)

      ScanCallback.SCAN_FAILED_ALREADY_STARTED -> CoreError(
        CoreError.Code.SCAN_FAILED,
        message,
        errorCode,
        retryable = false,
      )

      ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED,
      ScanCallback.SCAN_FAILED_INTERNAL_ERROR,
      ScanCallback.SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES,
      -> CoreError(CoreError.Code.SCAN_FAILED, message, errorCode, retryable = true)

      else -> CoreError(CoreError.Code.SCAN_FAILED, message, errorCode, retryable = false)
    }
  }

  /** Result of submitting an operation (`BluetoothStatusCodes`, API 33+). Null on success. */
  fun submitError(status: Int, operation: String): CoreError? {
    val message = "$operation was refused with status $status"
    return when (status) {
      BluetoothStatusCodes.SUCCESS -> null

      BluetoothStatusCodes.ERROR_BLUETOOTH_NOT_ENABLED -> CoreError(
        CoreError.Code.BLUETOOTH_POWERED_OFF,
        message,
        status,
      )

      BluetoothStatusCodes.ERROR_MISSING_BLUETOOTH_CONNECT_PERMISSION ->
        CoreError(CoreError.Code.PERMISSION_DENIED, message, status)

      BluetoothStatusCodes.ERROR_GATT_WRITE_NOT_ALLOWED -> CoreError(
        CoreError.Code.WRITE_NOT_PERMITTED,
        message,
        status,
      )

      BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY -> CoreError(
        CoreError.Code.GATT_ERROR,
        message,
        status,
        retryable = true,
      )

      BluetoothStatusCodes.ERROR_PROFILE_SERVICE_NOT_BOUND ->
        CoreError(CoreError.Code.BLUETOOTH_RESETTING, message, status)

      else -> CoreError(CoreError.Code.GATT_ERROR, message, status)
    }
  }
}
