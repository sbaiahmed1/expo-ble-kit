import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P1-05: connect, timeouts with cancel, disconnect and link loss on iOS, through the engine.
final class PeripheralSessionTests: XCTestCase {
  private var scheduler: TestScheduler!
  private var central: FakeCentralManager!
  private var engine: CentralEngine!
  private var peripheral: FakePeripheral!
  /// State changes and completions, in order.
  private var log: [String] = []
  private var connectError: CoreError?

  override func setUp() {
    super.setUp()
    scheduler = TestScheduler()
    central = FakeCentralManager()
    peripheral = FakePeripheral(name: "BleKit-Test")
    central.knownPeripherals[peripheral.identifier] = peripheral
    log = []
    connectError = nil
    let environment = CentralEngine.Environment(
      authorization: { .allowedAlways },
      infoDictionary: { [CentralEngine.usageDescriptionKey: "Uses Bluetooth"] },
      makeCentral: { [unowned self] _, _ in central }
    )
    engine = CentralEngine(queue: DispatchQueue(label: "test"), environment: environment, scheduler: scheduler)
    engine.onConnectionStateChange = { [unowned self] _, state, error in
      log.append("state \(state.js)" + (error.map { " \($0.code.rawValue)" } ?? ""))
    }
    engine.activateIfAuthorized()
    central.simulateState(.poweredOn)
  }

  private var id: String { peripheral.identifier.uuidString }

  private func connect(timeout: TimeInterval? = 15, id: String? = nil) throws {
    try engine.connect(id ?? self.id, spec: ConnectSpec(timeout: timeout)) { [unowned self] error in
      connectError = error
      log.append("connect " + (error?.code.rawValue ?? "ok"))
    }
  }

  private func disconnect() {
    engine.disconnect(id) { [unowned self] in log.append("disconnect ok") }
  }

  func testTheStateListenerSeesConnectedBeforeConnectResolves() throws {
    try connect()
    XCTAssertEqual(central.calls, [.connect(peripheral.identifier)])
    XCTAssertEqual(engine.connectionState(id), "connecting")
    central.simulateConnection(of: peripheral)
    XCTAssertEqual(log, ["state connecting", "state connected", "connect ok"])
    XCTAssertEqual(engine.connectionState(id.lowercased()), "connected")

    try connect()
    XCTAssertEqual(log.last, "connect ok", "already connected resolves at once")
    XCTAssertEqual(central.calls.count, 1)
  }

  func testATimedOutConnectIsCancelled() throws {
    try connect(timeout: 5)
    scheduler.advance(by: 4.999)
    XCTAssertNil(connectError)
    scheduler.advance(by: 0.001)
    XCTAssertEqual(connectError?.code, .connectionTimeout)
    XCTAssertEqual(central.calls.last, .cancelConnection(peripheral.identifier))

    // CoreBluetooth connects late: the link is dropped again.
    central.simulateConnection(of: peripheral)
    XCTAssertEqual(engine.connectionState(id), "disconnected")
    XCTAssertEqual(central.calls.filter { $0 == .cancelConnection(peripheral.identifier) }.count, 2)
  }

  func testWithoutATimeoutTheConnectWaitsUntilDisconnectCancelsIt() throws {
    try connect(timeout: nil)
    scheduler.advance(by: 3600)
    XCTAssertNil(connectError)
    disconnect()
    XCTAssertEqual(connectError?.code, .operationCancelled)
    XCTAssertEqual(central.calls.last, .cancelConnection(peripheral.identifier))
    XCTAssertEqual(log, ["state connecting", "state disconnected", "connect OPERATION_CANCELLED", "disconnect ok"])
  }

  func testFailedConnectsAreConnectionFailedWithTheNativeCode() throws {
    try connect()
    central.simulateConnectionFailure(of: peripheral, error: NSError(domain: CBErrorDomain, code: 10))
    XCTAssertEqual(connectError?.code, .connectionFailed)
    XCTAssertEqual(connectError?.nativeCode, 10)
    XCTAssertEqual(connectError?.retryable, true)
    XCTAssertEqual(log.last, "connect CONNECTION_FAILED")
  }

  func testDisconnectWaitsForCoreBluetoothOrTimesOut() throws {
    try connect()
    central.simulateConnection(of: peripheral)
    log.removeAll()
    disconnect()
    XCTAssertEqual(log, ["state disconnecting"])
    central.simulateDisconnection(of: peripheral)
    XCTAssertEqual(log, ["state disconnecting", "state disconnected", "disconnect ok"])

    try connect()
    central.simulateConnection(of: peripheral)
    disconnect()
    scheduler.advance(by: PeripheralSession.disconnectTimeout)
    XCTAssertEqual(log.last, "disconnect ok")
  }

  func testLinkLossReportsTheMappedError() throws {
    try connect()
    central.simulateConnection(of: peripheral)
    let sessions = engine.diagnostics()["sessions"] as? [[String: Any]]
    XCTAssertEqual(sessions?.first?["state"] as? String, "connected")
    central.simulateDisconnection(of: peripheral, error: NSError(domain: CBErrorDomain, code: 7))
    XCTAssertEqual(log.last, "state disconnected DISCONNECTED")
    XCTAssertEqual(engine.connectionState(id), "disconnected")
  }

  func testBluetoothOffDropsSessionsAndWaitingConnects() throws {
    try connect()
    central.simulateConnection(of: peripheral)
    central.simulateState(.poweredOff)
    XCTAssertEqual(log.last, "state disconnected BLUETOOTH_POWERED_OFF")
    XCTAssertEqual(engine.connectionState(id), "disconnected")
    XCTAssertThrowsError(try connect()) { error in
      XCTAssertEqual((error as? CoreError)?.code, .bluetoothPoweredOff)
    }
  }

  func testConnectsWaitWhileANewManagerIsUnknown() throws {
    central.simulateState(.unknown)
    try connect()
    XCTAssertTrue(central.calls.isEmpty, "nothing reaches CoreBluetooth before poweredOn")
    central.simulateState(.poweredOn)
    XCTAssertEqual(central.calls, [.connect(peripheral.identifier)])

    // A disconnect while still waiting cancels the connect.
    central.simulateState(.unknown)
    let other = FakePeripheral()
    central.knownPeripherals[other.identifier] = other
    try connect(id: other.identifier.uuidString)
    engine.disconnect(other.identifier.uuidString) {}
    XCTAssertEqual(connectError?.code, .operationCancelled)
    central.simulateState(.poweredOn)
    XCTAssertFalse(central.calls.contains(.connect(other.identifier)))
  }

  func testUnknownAndInvalidIds() throws {
    try connect(id: UUID().uuidString)
    XCTAssertEqual(connectError?.code, .peripheralNotFound)
    XCTAssertThrowsError(try connect(id: "C0:FF:EE:00:00:01")) { error in
      XCTAssertEqual((error as? CoreError)?.code, .invalidArgument)
    }
    var disconnected = false
    engine.disconnect(UUID().uuidString) { disconnected = true }
    XCTAssertTrue(disconnected, "unknown peripherals are already disconnected")
  }
}
