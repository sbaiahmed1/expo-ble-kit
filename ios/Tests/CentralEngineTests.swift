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

  func testJsMessageCarriesTheDetails() {
    let error = CoreError(.gattError, "Read failed", nativeDomain: "CBATTErrorDomain", nativeCode: 14)
    XCTAssertEqual(
      error.jsMessage,
      #"Read failed [blekit]{"nativeCode":14,"nativeDomain":"CBATTErrorDomain","retryable":false}"#
    )
    XCTAssertEqual(CoreError(.misconfigured, "No key").jsMessage, #"No key [blekit]{"retryable":false}"#)
  }
}
