import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P2-01: reconnection policies, the `reconnecting` state and subscription restore on iOS.
final class ReconnectTests: XCTestCase {
  private let testService = "0c6c1000-b347-4cfa-9827-1c5a13658519"
  private let stream = "0c6c1007-b347-4cfa-9827-1c5a13658519"

  private var scheduler: TestScheduler!
  private var central: FakeCentralManager!
  private var engine: CentralEngine!
  private var peripheral: FakePeripheral!
  private var log: [String] = []
  private var ended: [String] = []
  private var received: [Data] = []
  private var id: String { peripheral.identifier.uuidString }

  override func setUpWithError() throws {
    try super.setUpWithError()
    scheduler = TestScheduler()
    central = FakeCentralManager()
    peripheral = FakePeripheral(services: [
      FakeService(uuid: testService, characteristics: [FakeCharacteristic(uuid: stream, properties: [.notify])])
    ])
    central.knownPeripherals[peripheral.identifier] = peripheral
    let environment = CentralEngine.Environment(
      authorization: { .allowedAlways },
      infoDictionary: { [CentralEngine.usageDescriptionKey: "Uses Bluetooth"] },
      makeCentral: { [unowned self] _, _ in central }
    )
    engine = CentralEngine(queue: DispatchQueue(label: "test"), environment: environment, scheduler: scheduler)
    engine.onConnectionStateChange = { [unowned self] _, state, error in
      log.append(error.map { "\(state.js) \($0.code.rawValue)" } ?? state.js)
    }
    engine.onSubscriptionEnded = { [unowned self] _, subscriptionId, error in
      ended.append("\(subscriptionId) \(error.code.rawValue)")
    }
    engine.onNotification = { [unowned self] _, _, _, value, _ in received.append(value) }
    engine.activateIfAuthorized()
    central.simulateState(.poweredOn)
    peripheral.respondsAutomatically = true
  }

  private func connect(
    policy: ReconnectPolicy? = ReconnectPolicy(maxAttempts: 3),
    restore: Bool = true,
    autoReconnect: Bool = false
  ) throws {
    var spec = ConnectSpec(timeout: 5)
    spec.reconnect = policy
    spec.restoreSubscriptions = restore
    spec.enableAutoReconnect = autoReconnect
    try engine.connect(id, spec: spec) { [unowned self] error in log.append("connect \(error?.code.rawValue ?? "ok")") }
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
  }

  private var session: PeripheralSession {
    engine.session(id) { (_: Result<Void, CoreError>) in }!
  }

  private func connectCalls() -> Int {
    central.calls.filter { $0 == .connect(peripheral.identifier) }.count
  }

  private func loseLink(isReconnecting: Bool = false) {
    let error = NSError(domain: CBErrorDomain, code: 7)
    central.simulateDisconnection(of: peripheral, isReconnecting: isReconnecting, error: error)
    scheduler.runUntilIdle()
  }

  private func subscribe(_ subscriptionId: Int) -> Result<Void, CoreError>? {
    var result: Result<Void, CoreError>?
    let path = AttributePath(service: testService, characteristic: stream)
    session.subscribe(path, mode: .auto, subscriptionId: subscriptionId, timeout: nil) { result = $0 }
    scheduler.runUntilIdle()
    return result
  }

  private func notifyCalls() -> [Bool] {
    peripheral.calls.compactMap { call in
      if case let .setNotify(enabled, _) = call {
        return enabled
      }
      return nil
    }
  }

  func testALostLinkReconnectsAfterTheFirstDelay() throws {
    try connect()
    XCTAssertEqual(log, ["connecting", "connected", "connect ok"])
    loseLink()
    XCTAssertEqual(log.last, "reconnecting DISCONNECTED")
    XCTAssertEqual(connectCalls(), 1, "nothing before the delay")

    scheduler.advance(by: 1)
    XCTAssertEqual(connectCalls(), 2)
    XCTAssertEqual(session.visibleState, .reconnecting, "attempts read as reconnecting")
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
    XCTAssertEqual(log, ["connecting", "connected", "connect ok", "reconnecting DISCONNECTED", "connected"])
    XCTAssertEqual(engine.connectionState(id), "connected")
    XCTAssertEqual(session.services.map(\.uuid), [testService], "discovered again")
  }

  func testWaitsGrowThenItGivesUpWithTheLastError() throws {
    try connect(policy: ReconnectPolicy(maxAttempts: 2, initialDelay: 1, maxDelay: 30))
    loseLink()
    scheduler.advance(by: 1)
    scheduler.advance(by: 5) // attempt 1 times out
    XCTAssertEqual(connectCalls(), 2)
    scheduler.advance(by: 1.9)
    XCTAssertEqual(connectCalls(), 2, "the second wait is 2 s")
    scheduler.advance(by: 0.1)
    XCTAssertEqual(connectCalls(), 3)
    scheduler.advance(by: 5) // attempt 2 times out: no attempts left
    XCTAssertEqual(log.last, "disconnected CONNECTION_TIMEOUT")
    scheduler.advance(by: 60)
    XCTAssertEqual(connectCalls(), 3, "no more attempts")
    let cancels = central.calls.filter { $0 == .cancelConnection(peripheral.identifier) }
    XCTAssertEqual(cancels.count, 2, "each attempt cancelled")
  }

  func testAConnectJoinsAndDisconnectStops() throws {
    try connect()
    loseLink()
    try engine.connect(id, spec: ConnectSpec(timeout: 5)) { [unowned self] error in
      log.append("join \(error?.code.rawValue ?? "ok")")
    }
    var disconnected = false
    engine.disconnect(id) { disconnected = true }
    XCTAssertTrue(disconnected)
    XCTAssertEqual(Array(log.suffix(2)), ["disconnected", "join OPERATION_CANCELLED"])
    scheduler.advance(by: 60)
    XCTAssertEqual(connectCalls(), 1)
  }

  func testSubscriptionsAreEnabledAgainBeforeConnected() throws {
    try connect()
    XCTAssertNoThrow(try subscribe(1)?.get())
    loseLink()
    XCTAssertTrue(ended.isEmpty)
    scheduler.advance(by: 1)
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
    XCTAssertEqual(notifyCalls(), [true, true], "enabled again")
    XCTAssertEqual(log.last, "connected")
    peripheral.notify(peripheral.characteristic(stream)!, value: Data([7]))
    XCTAssertEqual(received, [Data([7])])
  }

  func testWithoutRestoreSubscriptionsEndWhenTheLinkIsLost() throws {
    try connect(restore: false)
    XCTAssertNoThrow(try subscribe(1)?.get())
    loseLink()
    XCTAssertEqual(ended, ["1 DISCONNECTED"])
  }

  func testTheSystemReconnectsWithAutoReconnect() throws {
    try connect(autoReconnect: true)
    XCTAssertEqual(central.lastConnectOptions?[CBConnectPeripheralOptionEnableAutoReconnect] as? Bool, true)
    loseLink(isReconnecting: true)
    XCTAssertEqual(log.last, "reconnecting DISCONNECTED")
    scheduler.advance(by: 60)
    XCTAssertEqual(connectCalls(), 1, "the system connects, not us")
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
    XCTAssertEqual(log.last, "connected")
  }

  func testWhenTheSystemStopsOurAttemptsTakeOver() throws {
    try connect(autoReconnect: true)
    loseLink(isReconnecting: true)
    central.simulateConnectionFailure(of: peripheral, error: NSError(domain: CBErrorDomain, code: 14))
    scheduler.runUntilIdle()
    XCTAssertEqual(session.visibleState, .reconnecting)
    scheduler.advance(by: 2)
    XCTAssertEqual(connectCalls(), 2, "attempt 2 is ours")
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
    XCTAssertEqual(log.last, "connected")
  }

  func testBluetoothOffEndsTheReconnection() throws {
    try connect()
    loseLink()
    central.simulateState(.poweredOff)
    scheduler.runUntilIdle()
    XCTAssertEqual(log.last, "disconnected BLUETOOTH_POWERED_OFF")
    scheduler.advance(by: 60)
    XCTAssertEqual(connectCalls(), 1)
  }

  func testWithoutAPolicyALostLinkDisconnects() throws {
    try connect(policy: nil)
    loseLink()
    XCTAssertEqual(log.last, "disconnected DISCONNECTED")
    scheduler.advance(by: 60)
    XCTAssertEqual(connectCalls(), 1)
  }

  func testThePolicysWaits() {
    let exponential = ReconnectPolicy(initialDelay: 0.5, maxDelay: 3)
    XCTAssertEqual((1...5).map { exponential.delay(attempt: $0) }, [0.5, 1, 2, 3, 3])
    XCTAssertEqual(ReconnectPolicy().delay(attempt: 1_000), 30)
    let fixed = ReconnectPolicy(initialDelay: 0.7, exponential: false)
    XCTAssertEqual((1...3).map { fixed.delay(attempt: $0) }, [0.7, 0.7, 0.7])
    XCTAssertFalse(ReconnectPolicy(maxAttempts: 2).allows(3))
    XCTAssertTrue(ReconnectPolicy().allows(1_000_000))
  }
}
