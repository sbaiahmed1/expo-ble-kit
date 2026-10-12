import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P5-04: AccessorySetupKit's picker with a fake session, and the Info.plist check.
final class AccessorySetupTests: XCTestCase {
  private let test = CBUUID(string: "0c6c1000-b347-4cfa-9827-1c5a13658519")
  private var scheduler: TestScheduler!
  private var sessions: [FakeAccessorySession] = []
  private var picker: AccessoryPicker!

  override func setUp() {
    super.setUp()
    scheduler = TestScheduler()
    sessions = []
    // The picker hops to the queue for completions; the test drains it.
    picker = AccessoryPicker(queue: .main, scheduler: scheduler) { [unowned self] in
      let session = FakeAccessorySession()
      sessions.append(session)
      return session
    }
  }

  private func item(service: CBUUID? = nil, company: UInt16? = nil, name: String? = nil) -> AccessoryPickerItemSpec {
    AccessoryPickerItemSpec(
      name: "Test", image: Data([1]), service: service, companyId: company, nameSubstring: name,
      manufacturerData: nil, serviceData: nil, immediateRange: false
    )
  }

  private func show() -> () -> String? {
    var outcome: String?
    picker.show([item(service: test)], timeout: 300) { result in
      switch result {
      case let .success(identifier): outcome = identifier?.uuidString ?? "nothing"
      case let .failure(error): outcome = error.code.rawValue
      }
    }
    return { outcome }
  }

  /// Runs what the picker queued on the main queue.
  private func drain() {
    RunLoop.main.run(until: Date().addingTimeInterval(0.01))
  }

  func testInfoPlistMustDeclareWhatTheItemsUse() {
    let none = AccessoryDeclarations(infoDictionary: [:])
    XCTAssertThrowsError(try none.check([item(service: test)])) {
      XCTAssertEqual(($0 as? CoreError)?.code, .misconfigured)
    }

    let declared = AccessoryDeclarations(infoDictionary: [
      AccessoryDeclarations.supportsKey: ["Bluetooth"],
      AccessoryDeclarations.servicesKey: ["0C6C1000-B347-4CFA-9827-1C5A13658519", "180D"],
      AccessoryDeclarations.namesKey: ["BleKit"],
      AccessoryDeclarations.companyIdentifiersKey: ["004C", "0xFFFF", 1]
    ])
    XCTAssertNoThrow(try declared.check([
      item(service: test, name: "BleKit"),
      item(service: CBUUID(string: "0000180d-0000-1000-8000-00805f9b34fb")),
      item(company: 0x004C),
      item(company: 0xFFFF),
      item(company: 1)
    ]))
    let undeclaredItems = [
      item(service: CBUUID(string: "180F")), item(company: 0x0059), item(service: test, name: "Other")
    ]
    for undeclared in undeclaredItems {
      XCTAssertThrowsError(try declared.check([undeclared])) {
        XCTAssertEqual(($0 as? CoreError)?.code, .misconfigured)
      }
    }
  }

  func testAMalformedListIsRejectedBeforeIOSStopsTheApp() {
    let base: [String: Any] = [
      AccessoryDeclarations.supportsKey: ["Bluetooth"],
      AccessoryDeclarations.servicesKey: ["0C6C1000-B347-4CFA-9827-1C5A13658519"]
    ]
    let malformed: [(String, Any)] = [
      (AccessoryDeclarations.namesKey, [String]()),
      (AccessoryDeclarations.companyIdentifiersKey, [String]()),
      (AccessoryDeclarations.namesKey, "BleKit"),
      (AccessoryDeclarations.companyIdentifiersKey, ["Apple"]),
      (AccessoryDeclarations.namesKey, (0 ... AccessoryDeclarations.maxValues).map { "Name \($0)" })
    ]
    XCTAssertNoThrow(try AccessoryDeclarations(infoDictionary: base).check([item(service: test)]))
    for (key, value) in malformed {
      let declarations = AccessoryDeclarations(infoDictionary: base.merging([key: value]) { $1 })
      XCTAssertThrowsError(try declarations.check([item(service: test)]), key) {
        XCTAssertEqual(($0 as? CoreError)?.code, .misconfigured)
        XCTAssertTrue(($0 as? CoreError)?.message.contains(key) == true)
      }
    }
  }

  func testAnswersWithThePickedAccessoryOnceThePickerCloses() throws {
    let outcome = show()
    let session = try XCTUnwrap(sessions.first)
    XCTAssertTrue(session.shown.isEmpty, "waits for the session to activate")
    session.send(.activated)
    XCTAssertEqual(session.shown.first?.first?.service, test)
    let picked = UUID()
    session.send(.accessoryAdded(bluetoothIdentifier: picked))
    XCTAssertNil(outcome())
    session.send(.pickerDidDismiss)
    XCTAssertEqual(outcome(), picked.uuidString)

    // The next picker reuses the active session.
    let second = show()
    XCTAssertEqual(sessions.count, 1)
    session.complete(AccessoryPickerFailure(kind: .userCancelled, message: "cancelled", code: 700))
    drain()
    XCTAssertEqual(second(), "nothing")
  }

  func testOnePickerAtATimeAndErrors() throws {
    let first = show()
    XCTAssertEqual(show()(), "INVALID_ARGUMENT")
    let session = try XCTUnwrap(sessions.first)
    session.send(.activated)
    session.complete(AccessoryPickerFailure(kind: .restricted, message: "restricted", code: 500))
    drain()
    XCTAssertEqual(first(), "BLUETOOTH_UNAUTHORIZED")

    let ended = show()
    session.send(.invalidated)
    XCTAssertEqual(ended(), "OPERATION_CANCELLED")
    _ = show()
    XCTAssertEqual(sessions.count, 2, "an ended session is replaced")
  }

  func testAPickerLeftOpenTimesOutAndClosesTheSession() throws {
    let outcome = show()
    let session = try XCTUnwrap(sessions.first)
    session.send(.activated)
    scheduler.advance(by: 299)
    XCTAssertNil(outcome())
    scheduler.advance(by: 1)
    XCTAssertEqual(outcome(), "OPERATION_TIMEOUT")
    XCTAssertTrue(session.invalidated)
    _ = show()
    XCTAssertEqual(sessions.count, 2)
  }
}
