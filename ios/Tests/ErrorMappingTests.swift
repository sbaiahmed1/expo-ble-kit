import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P1-10: every CoreBluetooth and ATT error maps to a library code (plan §4.11, Appendix A.2).
final class ErrorMappingTests: XCTestCase {
  private func mapped(_ domain: String, _ code: Int) -> CoreError {
    CoreBluetoothErrorMapping.coreError(from: NSError(domain: domain, code: code))
  }

  func testEveryCBErrorMapsToTheExpectedCode() {
    // All CBError values in the iOS 27 SDK (CBError.h), 0–20.
    let expected: [Int: (CoreError.Code, Bool)] = [
      0: (.gattError, false), 1: (.invalidArgument, false), 2: (.gattError, false),
      3: (.disconnected, false), 4: (.gattError, true), 5: (.operationCancelled, false),
      6: (.disconnected, true), 7: (.disconnected, true), 8: (.notSupported, false),
      9: (.advertisingFailed, false), 10: (.connectionFailed, true), 11: (.connectionFailed, false),
      12: (.peripheralNotFound, false), 13: (.notSupported, false), 14: (.bondFailed, false),
      15: (.bondFailed, true), 16: (.bondFailed, false), 17: (.gattError, false),
      18: (.gattError, false), 19: (.notSupported, false), 20: (.notSupported, false)
    ]
    for raw in 0...20 {
      let error = mapped(CBErrorDomain, raw)
      XCTAssertEqual(error.code, expected[raw]?.0, "CBError \(raw)")
      XCTAssertEqual(error.retryable, expected[raw]?.1, "CBError \(raw) retryable")
      XCTAssertEqual(error.nativeDomain, CBErrorDomain)
      XCTAssertEqual(error.nativeCode, raw)
    }
    XCTAssertEqual(mapped(CBErrorDomain, 99).code, .gattError, "unknown future codes fall back to GATT_ERROR")
  }

  func testEveryAttErrorMapsToTheExpectedCode() {
    // All CBATTError values (1–0x11), which are the ATT error codes of the Bluetooth spec.
    let expected: [Int: CoreError.Code] = [
      0x01: .gattError, 0x02: .readNotPermitted, 0x03: .writeNotPermitted, 0x04: .gattError,
      0x05: .insufficientAuthentication, 0x06: .notSupported, 0x07: .invalidOffset,
      0x08: .insufficientAuthorization, 0x09: .gattError, 0x0A: .gattError, 0x0B: .gattError,
      0x0C: .insufficientEncryption, 0x0D: .invalidAttributeLength, 0x0E: .gattError,
      0x0F: .insufficientEncryption, 0x10: .notSupported, 0x11: .gattError
    ]
    for raw in 0x01...0x11 {
      let error = mapped(CBATTErrorDomain, raw)
      XCTAssertEqual(error.code, expected[raw], "ATT 0x\(String(raw, radix: 16))")
      XCTAssertEqual(error.retryable, raw == 0x11, "ATT 0x\(String(raw, radix: 16)) retryable")
      XCTAssertEqual(error.nativeDomain, CBATTErrorDomain)
    }
  }

  func testTheSwiftEnumsAgreeWithTheTable() {
    XCTAssertEqual(CBATTError.Code.insufficientEncryption.rawValue, 0x0F)
    XCTAssertEqual(CBATTError.Code.insufficientResources.rawValue, 0x11)
    XCTAssertEqual(CBError.Code.peripheralDisconnected.rawValue, 7)
    XCTAssertEqual(CBError.Code.tooManyLEPairedDevices.rawValue, 16)
  }

  func testOtherErrorsAreInternal() {
    let error = mapped(NSPOSIXErrorDomain, 12)
    XCTAssertEqual(error.code, .internal)
    XCTAssertEqual(error.nativeDomain, NSPOSIXErrorDomain)
  }

  func testDefaultRetryabilityFollowsThePlan() {
    let retryable: Set<CoreError.Code> = [
      .bluetoothResetting, .scanThrottled, .connectionFailed, .connectionTimeout, .operationTimeout, .congested
    ]
    for code in [CoreError.Code.bluetoothUnsupported, .disconnected, .gattError, .bondFailed] + retryable {
      XCTAssertEqual(CoreError(code, "x").retryable, retryable.contains(code), code.rawValue)
    }
  }
}
