package expo.modules.blekit.core

/**
 * Errors raised by the core. [code] values are the `BleErrorCode` strings of plan §4.11; the binding
 * turns them into coded JS exceptions. Mapping from Android GATT statuses is P1-10.
 */
class CoreError(val code: Code, message: String, val gattStatus: Int? = null, retryable: Boolean? = null) :
  Exception(message) {
  /** Whether retrying the same call can succeed without user action (plan §4.11). */
  val retryable: Boolean = retryable ?: defaultRetryable(code)

  /**
   * The message the binding gives JS: the text, then `[blekit]` and the details as flat JSON. This
   * is the contract with `BleError.fromNative` in src/errors.ts.
   */
  val jsMessage: String
    get() {
      val details = listOfNotNull(gattStatus?.let { "\"gattStatus\":$it" }, "\"retryable\":$retryable")
      return "$message [blekit]{${details.joinToString(",")}}"
    }

  companion object {
    /** Where MISCONFIGURED messages send developers. */
    const val SETUP_GUIDE = "see docs/guides/bare-setup.md in the expo-ble-kit repository"

    /**
     * Retryability by code (plan §4.11). Codes marked "depends" there default to false; the mappings
     * in ErrorMapping.kt set them per error.
     */
    fun defaultRetryable(code: Code): Boolean = when (code) {
      Code.BLUETOOTH_RESETTING, Code.SCAN_THROTTLED, Code.CONNECTION_FAILED, Code.CONNECTION_TIMEOUT,
      Code.OPERATION_TIMEOUT, Code.CONGESTED,
      -> true

      else -> false
    }
  }

  enum class Code(val value: String) {
    BLUETOOTH_UNSUPPORTED("BLUETOOTH_UNSUPPORTED"),
    BLUETOOTH_UNAUTHORIZED("BLUETOOTH_UNAUTHORIZED"),
    BLUETOOTH_POWERED_OFF("BLUETOOTH_POWERED_OFF"),
    BLUETOOTH_RESETTING("BLUETOOTH_RESETTING"),
    PERMISSION_DENIED("PERMISSION_DENIED"),
    MISCONFIGURED("MISCONFIGURED"),
    INVALID_ARGUMENT("INVALID_ARGUMENT"),
    SCAN_FAILED("SCAN_FAILED"),
    SCAN_THROTTLED("SCAN_THROTTLED"),
    PERIPHERAL_NOT_FOUND("PERIPHERAL_NOT_FOUND"),
    CONNECTION_FAILED("CONNECTION_FAILED"),
    CONNECTION_TIMEOUT("CONNECTION_TIMEOUT"),
    DISCONNECTED("DISCONNECTED"),
    OPERATION_TIMEOUT("OPERATION_TIMEOUT"),
    OPERATION_CANCELLED("OPERATION_CANCELLED"),
    SERVICE_NOT_FOUND("SERVICE_NOT_FOUND"),
    CHARACTERISTIC_NOT_FOUND("CHARACTERISTIC_NOT_FOUND"),
    DESCRIPTOR_NOT_FOUND("DESCRIPTOR_NOT_FOUND"),
    NOT_SUPPORTED("NOT_SUPPORTED"),
    READ_NOT_PERMITTED("READ_NOT_PERMITTED"),
    WRITE_NOT_PERMITTED("WRITE_NOT_PERMITTED"),
    INSUFFICIENT_AUTHENTICATION("INSUFFICIENT_AUTHENTICATION"),
    INSUFFICIENT_ENCRYPTION("INSUFFICIENT_ENCRYPTION"),
    INSUFFICIENT_AUTHORIZATION("INSUFFICIENT_AUTHORIZATION"),
    INVALID_ATTRIBUTE_LENGTH("INVALID_ATTRIBUTE_LENGTH"),
    INVALID_OFFSET("INVALID_OFFSET"),
    CONGESTED("CONGESTED"),
    GATT_ERROR("GATT_ERROR"),
    BOND_FAILED("BOND_FAILED"),
    ADVERTISING_FAILED("ADVERTISING_FAILED"),
    L2CAP_FAILED("L2CAP_FAILED"),
    INTERNAL("INTERNAL"),
  }
}
