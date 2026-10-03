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
    case bufferOverflow = "BUFFER_OVERFLOW"
    case gattError = "GATT_ERROR"
    case bondFailed = "BOND_FAILED"
    case advertisingFailed = "ADVERTISING_FAILED"
    case l2capFailed = "L2CAP_FAILED"
    case `internal` = "INTERNAL"
  }

  let code: Code
  let message: String
  /// Whether retrying the same call can succeed without user action (plan §4.11).
  let retryable: Bool
  var nativeDomain: String?
  var nativeCode: Int?

  init(_ code: Code, _ message: String, retryable: Bool? = nil, nativeDomain: String? = nil, nativeCode: Int? = nil) {
    self.code = code
    self.message = message
    self.retryable = retryable ?? Self.defaultRetryable(code)
    self.nativeDomain = nativeDomain
    self.nativeCode = nativeCode
  }

  /// Retryability by code (plan §4.11). Codes marked "depends" there default to false; the
  /// mappings in ErrorMapping.swift set them per error.
  static func defaultRetryable(_ code: Code) -> Bool {
    switch code {
    case .bluetoothResetting, .scanThrottled, .connectionFailed, .connectionTimeout, .operationTimeout, .congested:
      return true
    default:
      return false
    }
  }
}

extension CoreError {
  /// Where MISCONFIGURED messages send developers.
  static let setupGuide = "see docs/guides/bare-setup.md in the expo-ble-kit repository"

  /// The message the binding gives JS: the text, then `[blekit]` and the details as flat JSON. This
  /// is the contract with `BleError.fromNative` in src/errors.ts.
  var jsMessage: String {
    var details: [String: Any] = ["retryable": retryable]
    if let nativeDomain {
      details["nativeDomain"] = nativeDomain
    }
    if let nativeCode {
      details["nativeCode"] = nativeCode
    }
    guard
      let data = try? JSONSerialization.data(withJSONObject: details, options: [.sortedKeys]),
      let json = String(data: data, encoding: .utf8)
    else {
      return message
    }
    return "\(message) [blekit]\(json)"
  }
}
