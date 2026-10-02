import CoreBluetooth
import Foundation

/// ATT error codes (Bluetooth Core Spec Vol 3, Part F, 3.4.1.1). `CBATTError` raw values and Android
/// GATT operation statuses 0x01–0x11 are these same codes, so both platforms share this table.
enum AttErrorMapping {
  static func code(forAttError att: Int) -> CoreError.Code {
    switch att {
    case 0x02: return .readNotPermitted
    case 0x03: return .writeNotPermitted
    case 0x05: return .insufficientAuthentication
    case 0x06: return .notSupported // request not supported
    case 0x07: return .invalidOffset
    case 0x08: return .insufficientAuthorization
    case 0x0C, 0x0F: return .insufficientEncryption // encryption key size, encryption
    case 0x0D: return .invalidAttributeLength
    case 0x10: return .notSupported // unsupported group type
    default: return .gattError // invalid handle/PDU, prepare queue full, not found, unlikely, resources…
    }
  }

  /// Only "insufficient resources" (0x11) can succeed by simply trying again.
  static func isRetryable(attError att: Int) -> Bool {
    att == 0x11
  }
}

/// Maps CoreBluetooth errors to core errors (plan §4.11, Appendix A.2). Codes come from the iOS 27
/// SDK's CBError.h; they are matched by number so the table also covers codes missing on macOS.
enum CoreBluetoothErrorMapping {
  static func coreError(from error: Error) -> CoreError {
    let nsError = error as NSError
    let message = nsError.localizedDescription
    switch nsError.domain {
    case CBATTErrorDomain:
      return CoreError(
        AttErrorMapping.code(forAttError: nsError.code),
        message,
        retryable: AttErrorMapping.isRetryable(attError: nsError.code),
        nativeDomain: nsError.domain,
        nativeCode: nsError.code
      )
    case CBErrorDomain:
      let (code, retryable) = cbErrorCode(nsError.code)
      return CoreError(code, message, retryable: retryable, nativeDomain: nsError.domain, nativeCode: nsError.code)
    default:
      return CoreError(.internal, message, nativeDomain: nsError.domain, nativeCode: nsError.code)
    }
  }

  // swiftlint:disable:next cyclomatic_complexity
  static func cbErrorCode(_ rawValue: Int) -> (CoreError.Code, retryable: Bool) {
    switch rawValue {
    case 1: return (.invalidArgument, false) // invalidParameters
    case 3: return (.disconnected, false) // notConnected
    case 4: return (.gattError, true) // outOfSpace
    case 5: return (.operationCancelled, false) // operationCancelled
    case 6, 7: return (.disconnected, true) // connectionTimeout (link supervision), peripheralDisconnected
    case 8: return (.notSupported, false) // uuidNotAllowed
    case 9: return (.advertisingFailed, false) // alreadyAdvertising
    case 10: return (.connectionFailed, true) // connectionFailed
    case 11: return (.connectionFailed, false) // connectionLimitReached: free a connection first
    case 12: return (.peripheralNotFound, false) // unknownDevice
    case 13: return (.notSupported, false) // operationNotSupported
    case 14: return (.bondFailed, false) // peerRemovedPairingInformation: user must forget the device
    case 15: return (.bondFailed, true) // encryptionTimedOut
    case 16: return (.bondFailed, false) // tooManyLEPairedDevices
    case 19, 20: return (.notSupported, false) // channel sounding (iOS 27), not used by this library
    default: return (.gattError, false) // unknown (0), invalidHandle (2), watchOS-only 17–18, future codes
    }
  }
}
