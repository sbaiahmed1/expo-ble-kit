import Foundation

/// Errors raised by the core. `code` values are the `BleErrorCode` strings of plan §4.11; the
/// binding turns them into coded JS exceptions. Mapping from CoreBluetooth errors is P1-10.
struct CoreError: Error, Equatable {
  enum Code: String {
    case bluetoothUnsupported = "BLUETOOTH_UNSUPPORTED"
    case bluetoothUnauthorized = "BLUETOOTH_UNAUTHORIZED"
    case bluetoothPoweredOff = "BLUETOOTH_POWERED_OFF"
    case bluetoothResetting = "BLUETOOTH_RESETTING"
    case permissionDenied = "PERMISSION_DENIED"
    case misconfigured = "MISCONFIGURED"
    case invalidArgument = "INVALID_ARGUMENT"
    case scanFailed = "SCAN_FAILED"
    case scanThrottled = "SCAN_THROTTLED"
    case peripheralNotFound = "PERIPHERAL_NOT_FOUND"
    case connectionFailed = "CONNECTION_FAILED"
    case connectionTimeout = "CONNECTION_TIMEOUT"
    case disconnected = "DISCONNECTED"
    case operationTimeout = "OPERATION_TIMEOUT"
    case operationCancelled = "OPERATION_CANCELLED"
    case serviceNotFound = "SERVICE_NOT_FOUND"
    case characteristicNotFound = "CHARACTERISTIC_NOT_FOUND"
    case descriptorNotFound = "DESCRIPTOR_NOT_FOUND"
    case notSupported = "NOT_SUPPORTED"
    case readNotPermitted = "READ_NOT_PERMITTED"
    case writeNotPermitted = "WRITE_NOT_PERMITTED"
    case insufficientAuthentication = "INSUFFICIENT_AUTHENTICATION"
    case insufficientEncryption = "INSUFFICIENT_ENCRYPTION"
    case insufficientAuthorization = "INSUFFICIENT_AUTHORIZATION"
    case invalidAttributeLength = "INVALID_ATTRIBUTE_LENGTH"
    case invalidOffset = "INVALID_OFFSET"
    case congested = "CONGESTED"
    case gattError = "GATT_ERROR"
    case bondFailed = "BOND_FAILED"
    case advertisingFailed = "ADVERTISING_FAILED"
    case l2capFailed = "L2CAP_FAILED"
    case `internal` = "INTERNAL"
  }

  let code: Code
  let message: String
  var nativeDomain: String?
  var nativeCode: Int?

  init(_ code: Code, _ message: String, nativeDomain: String? = nil, nativeCode: Int? = nil) {
    self.code = code
    self.message = message
    self.nativeDomain = nativeDomain
    self.nativeCode = nativeCode
  }
}
