import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P1-03: adapter state, lazy manager creation, permissions and the Info.plist check.
final class CentralEngineTests: XCTestCase {
  private var authorization: CBManagerAuthorization = .notDetermined
  private var infoPlist: [String: Any]? = [CentralEngine.usageDescriptionKey: "Uses Bluetooth"]
  private var created: [FakeCentralManager] = []
  private var createOptions: [String: Any]?
  private var engine: CentralEngine!
  private var stateEvents: [BleState] = []

  override func setUp() {
    super.setUp()
    authorization = .notDetermined
    infoPlist = [CentralEngine.usageDescriptionKey: "Uses Bluetooth"]
    created = []
    createOptions = nil
    stateEvents = []
  }

  private func makeEngine() {
    let environment = CentralEngine.Environment(
      authorization: { [unowned self] in authorization },
      infoDictionary: { [unowned self] in infoPlist },
      makeCentral: { [unowned self] _, options in
        createOptions = options
        let central = FakeCentralManager()
        created.append(central)
        return central
      }
    )
    engine = CentralEngine(queue: DispatchQueue(label: "test"), environment: environment)
    engine.onStateChange = { [unowned self] in stateEvents.append($0) }
  }

  /// The user answers the prompt; CoreBluetooth then reports a state.
  private func answerPrompt(_ answer: CBManagerAuthorization, state: CBManagerState) {
    authorization = answer
    created.last?.simulateState(state)
  }

  func testMapsEveryManagerState() {
    let expected: [(CBManagerState, BleState)] = [
      (.unknown, .unknown), (.resetting, .resetting), (.unsupported, .unsupported),
      (.unauthorized, .unauthorized), (.poweredOff, .poweredOff), (.poweredOn, .poweredOn)
    ]
    for (native, expectedState) in expected {
      XCTAssertEqual(BleState(native), expectedState)
    }
  }

  func testStateBeforeTheManagerComesFromTheAuthorization() {
    makeEngine()
    XCTAssertEqual(engine.state, .unknown)
    authorization = .denied
    makeEngine()
    XCTAssertEqual(engine.state, .unauthorized)
    authorization = .restricted
    makeEngine()
    XCTAssertEqual(engine.state, .unauthorized)
    XCTAssertTrue(created.isEmpty)
  }

  func testNeverCreatesTheManagerWhenThatCouldPrompt() throws {
    makeEngine()
    engine.activateIfAuthorized()
    engine.refresh()
    XCTAssertEqual(try engine.permissions().scan, .undetermined)
    XCTAssertTrue(created.isEmpty)
  }

  func testCreatesTheManagerOnceWhenAlreadyAuthorized() throws {
    authorization = .allowedAlways
    makeEngine()
    engine.activateIfAuthorized()
    engine.activateIfAuthorized()
    XCTAssertEqual(created.count, 1)
    XCTAssertEqual(createOptions?[CBCentralManagerOptionShowPowerAlertKey] as? Bool, false)

    created[0].simulateState(.poweredOff)
    created[0].simulateState(.poweredOff)
    created[0].simulateState(.resetting)
    created[0].simulateState(.poweredOn)
    XCTAssertEqual(stateEvents, [.poweredOff, .resetting, .poweredOn])
    XCTAssertEqual(engine.state, .poweredOn)
  }

  func testRequestCreatesTheManagerAndWaitsForTheAnswer() {
    makeEngine()
    var results: [Result<BlePermissions, CoreError>] = []
    engine.requestPermissions { results.append($0) }
    engine.requestPermissions { results.append($0) }
    XCTAssertEqual(created.count, 1, "one manager, one prompt")

    // An update while the prompt is still showing doesn't answer the request.
    created[0].simulateState(.unknown)
    XCTAssertTrue(results.isEmpty)

    answerPrompt(.allowedAlways, state: .poweredOn)
    XCTAssertEqual(results.count, 2)
    let permissions = try? results[0].get()
    XCTAssertEqual(permissions?.scan, .granted)
    XCTAssertEqual(permissions?.backgroundScan, .granted)
    XCTAssertEqual(permissions?.canAskAgain, true)
    XCTAssertEqual(engine.state, .poweredOn)
  }

  func testDenyingThePromptReportsUnauthorized() {
    makeEngine()
    var result: Result<BlePermissions, CoreError>?
    engine.requestPermissions { result = $0 }
    answerPrompt(.denied, state: .unauthorized)
    let permissions = try? result?.get()
    XCTAssertEqual(permissions?.connect, .denied)
    XCTAssertEqual(permissions?.canAskAgain, false)
    XCTAssertEqual(engine.state, .unauthorized)
  }

  func testRequestAfterAnAnswerCompletesAtOnce() {
    authorization = .denied
    makeEngine()
    var result: Result<BlePermissions, CoreError>?
    engine.requestPermissions { result = $0 }
    XCTAssertEqual(try? result?.get().scan, .denied)
    XCTAssertTrue(created.isEmpty)

    authorization = .allowedAlways
    engine.requestPermissions { result = $0 }
    XCTAssertEqual(try? result?.get().scan, .granted)
    XCTAssertEqual(created.count, 1, "an authorized request starts reporting the adapter state")
  }

  /// P5-04: measured on iOS 27.0.1, an app that declares AccessorySetupKit never sees the prompt
  /// and stays `.notDetermined`, while its manager reaches the picked accessories.
  func testAccessorySetupKitAppsUseTheManagerWithoutThePrompt() throws {
    infoPlist?[AccessoryDeclarations.supportsKey] = ["Bluetooth"]
    makeEngine()
    engine.activateIfAuthorized()
    XCTAssertEqual(created.count, 1, "creating the manager can't show the prompt")
    XCTAssertNoThrow(try engine.authorizedCentral())
    XCTAssertEqual(created.count, 1)

    let permissions = try engine.permissions()
    XCTAssertEqual(permissions.scan, .granted)
    XCTAssertEqual(permissions.connect, .granted)
    XCTAssertEqual(permissions.advertise, .undetermined)
    XCTAssertEqual(permissions.backgroundScan, .undetermined)
    XCTAssertEqual(permissions.canAskAgain, false, "there is no prompt to show")

    var result: Result<BlePermissions, CoreError>?
    engine.requestPermissions { result = $0 }
    XCTAssertEqual(try result?.get(), permissions, "completes at once")

    // A denial from before the app adopted AccessorySetupKit still counts.
    authorization = .denied
    makeEngine()
    XCTAssertThrowsError(try engine.authorizedCentral()) {
      XCTAssertEqual(($0 as? CoreError)?.code, .bluetoothUnauthorized)
    }
    XCTAssertEqual(try engine.permissions().connect, .denied)
  }

  func testMissingUsageDescriptionIsMisconfiguredAndNeverCreatesTheManager() {
    for plist in [nil, [:], [CentralEngine.usageDescriptionKey: ""]] as [[String: Any]?] {
      infoPlist = plist
      authorization = .notDetermined
      makeEngine()
      XCTAssertThrowsError(try engine.permissions()) { error in
        XCTAssertEqual((error as? CoreError)?.code, .misconfigured)
        XCTAssertTrue((error as? CoreError)?.message.contains(CentralEngine.usageDescriptionKey) ?? false)
      }
      var result: Result<BlePermissions, CoreError>?
      engine.requestPermissions { result = $0 }
      guard case let .failure(error) = result else {
        return XCTFail("expected MISCONFIGURED")
      }
      XCTAssertEqual(error.code, .misconfigured)

      authorization = .allowedAlways
      engine.activateIfAuthorized()
      XCTAssertTrue(created.isEmpty)
    }
  }

  func testRefreshPicksUpAnAuthorizationChangedInSettings() {
    authorization = .denied
    makeEngine()
    authorization = .allowedAlways
    engine.refresh()
    XCTAssertEqual(created.count, 1)
    created[0].simulateState(.poweredOn)
    XCTAssertEqual(stateEvents, [.unknown, .poweredOn])
  }

  func testScanningNeedsTheKeyAndAnAuthorizationAndNeverPrompts() {
    makeEngine()
    XCTAssertThrowsError(try engine.startScan(1, spec: ScanSpec())) { error in
      XCTAssertEqual((error as? CoreError)?.code, .bluetoothUnauthorized)
    }
    XCTAssertTrue(created.isEmpty, "no manager, so no prompt")

    infoPlist = [:]
    authorization = .allowedAlways
    makeEngine()
    XCTAssertThrowsError(try engine.startScan(1, spec: ScanSpec())) { error in
      XCTAssertEqual((error as? CoreError)?.code, .misconfigured)
    }
    XCTAssertTrue(created.isEmpty)
  }

  func testScanSessionsFollowTheAdapter() throws {
    authorization = .allowedAlways
    makeEngine()
    var ended: [Int: CoreError.Code] = [:]
    var found: [String] = []
    engine.scanController.onError = { ended[$0] = $1.code }
    engine.scanController.onResults = { _, results in found += results.compactMap { $0["name"] as? String } }

    // The new manager still reports `unknown`: the session waits instead of failing.
    try engine.startScan(1, spec: ScanSpec())
    XCTAssertEqual(created.count, 1)
    XCTAssertTrue(created[0].calls.isEmpty)
    created[0].simulateState(.poweredOn)
    XCTAssertEqual(created[0].calls, [.scan(nil)])
    created[0].simulateDiscovery(of: FakePeripheral(name: "Pulse"))
    XCTAssertEqual(found, ["Pulse"])
    XCTAssertThrowsError(try engine.startScan(1, spec: ScanSpec())) { error in
      XCTAssertEqual((error as? CoreError)?.code, .invalidArgument)
    }

    created[0].simulateState(.poweredOff)
    XCTAssertEqual(ended, [1: .bluetoothPoweredOff])
    XCTAssertThrowsError(try engine.startScan(2, spec: ScanSpec())) { error in
      XCTAssertEqual((error as? CoreError)?.code, .bluetoothPoweredOff)
    }
    created[0].simulateState(.poweredOn)
    try engine.startScan(3, spec: ScanSpec(services: ["0000180d-0000-1000-8000-00805f9b34fb"]))
    XCTAssertEqual(created[0].calls.last, .scan([CBUUID(string: "180D")]))
  }

  func testJsMessageCarriesTheDetails() {
    let error = CoreError(.gattError, "Read failed", nativeDomain: "CBATTErrorDomain", nativeCode: 14)
    XCTAssertEqual(
      error.jsMessage,
      #"Read failed [blekit]{"nativeCode":14,"nativeDomain":"CBATTErrorDomain","retryable":false}"#
    )
    XCTAssertEqual(CoreError(.misconfigured, "No key").jsMessage, #"No key [blekit]{"retryable":false}"#)
  }
}
