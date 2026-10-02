import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P1-08: subscriptions, the shared CCCD, and notification delivery on iOS.
final class SubscriptionTests: XCTestCase {
  private let testService = "0c6c1000-b347-4cfa-9827-1c5a13658519"
  private let stream = "0c6c1007-b347-4cfa-9827-1c5a13658519"
  private let indicateOnly = "0c6c1008-b347-4cfa-9827-1c5a13658519"
  private let both = "0c6c100c-b347-4cfa-9827-1c5a13658519"
  private let readOnly = "0c6c1001-b347-4cfa-9827-1c5a13658519"

  private var scheduler: TestScheduler!
  private var central: FakeCentralManager!
  private var engine: CentralEngine!
  private var peripheral: FakePeripheral!
  private var session: PeripheralSession!
  private struct Received {
    let service: String
    let characteristic: String
    let value: Data
    let timestamp: Double
  }

  private var received: [Received] = []

  override func setUpWithError() throws {
    try super.setUpWithError()
    scheduler = TestScheduler()
    central = FakeCentralManager()
    peripheral = FakePeripheral(services: [
      FakeService(uuid: testService, characteristics: [
        FakeCharacteristic(uuid: stream, properties: [.read, .notify]),
        FakeCharacteristic(uuid: indicateOnly, properties: [.indicate]),
        FakeCharacteristic(uuid: both, properties: [.notify, .indicate]),
        FakeCharacteristic(uuid: readOnly, properties: [.read], value: Data([1]))
      ])
    ])
    central.knownPeripherals[peripheral.identifier] = peripheral
    let environment = CentralEngine.Environment(
      authorization: { .allowedAlways },
      infoDictionary: { [CentralEngine.usageDescriptionKey: "Uses Bluetooth"] },
      makeCentral: { [unowned self] _, _ in central }
    )
    engine = CentralEngine(queue: DispatchQueue(label: "test"), environment: environment, scheduler: scheduler)
    engine.onNotification = { [unowned self] _, service, characteristic, value, timestamp in
      received.append(Received(service: service, characteristic: characteristic, value: value, timestamp: timestamp))
    }
    engine.activateIfAuthorized()
    central.simulateState(.poweredOn)
    peripheral.respondsAutomatically = true
    try engine.connect(peripheral.identifier.uuidString, spec: ConnectSpec(timeout: 15)) { _ in }
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
    session = engine.session(peripheral.identifier.uuidString) { (_: Result<Void, CoreError>) in }
    XCTAssertEqual(session.state, .ready)
  }

  // MARK: Helpers

  private typealias Outcome = () -> Result<Void, CoreError>?

  private func subscribe(_ id: Int, _ characteristic: String? = nil, mode: SubscribeMode = .auto) -> Outcome {
    var result: Result<Void, CoreError>?
    let path = AttributePath(service: testService, characteristic: characteristic ?? stream)
    session.subscribe(path, mode: mode, subscriptionId: id, timeout: nil) { result = $0 }
    scheduler.runUntilIdle()
    return { result }
  }

  private func unsubscribe(_ id: Int) -> Outcome {
    var result: Result<Void, CoreError>?
    session.unsubscribe(id, timeout: nil) { result = $0 }
    scheduler.runUntilIdle()
    return { result }
  }

  private func code(_ result: Result<Void, CoreError>?) -> CoreError.Code? {
    if case let .failure(error) = result {
      return error.code
    }
    return nil
  }

  private func succeeded(_ result: Result<Void, CoreError>?) -> Bool {
    if case .success = result {
      return true
    }
    return false
  }

  private func notifyCalls() -> [Bool] {
    peripheral.calls.compactMap { call in
      if case let .setNotify(enabled, _) = call {
        return enabled
      }
      return nil
    }
  }

  private func fake(_ uuid: String) -> FakeCharacteristic {
    peripheral.characteristic(uuid)!
  }

  // MARK: Tests

  func testSubscribersShareOneCCCDAndTheLastOneOutDisablesIt() {
    XCTAssertTrue(succeeded(subscribe(1)()))
    XCTAssertTrue(succeeded(subscribe(2)()))
    XCTAssertEqual(notifyCalls(), [true], "the second subscriber shares the CCCD")

    scheduler.advance(by: 0.25)
    peripheral.notify(fake(stream), value: Data([7]))
    XCTAssertEqual(received.map(\.value), [Data([7])])
    XCTAssertEqual(received.first?.service, testService)
    XCTAssertEqual(received.first?.characteristic, stream)
    XCTAssertGreaterThan(received.first?.timestamp ?? 0, 1_600_000_000_000, "epoch milliseconds")

    XCTAssertTrue(succeeded(unsubscribe(1)()))
    peripheral.notify(fake(stream), value: Data([8]))
    XCTAssertEqual(received.count, 2, "the other subscriber keeps receiving")

    XCTAssertTrue(succeeded(unsubscribe(2)()))
    XCTAssertEqual(notifyCalls(), [true, false])
    peripheral.notify(fake(stream), value: Data([9]))
    XCTAssertEqual(received.count, 2, "nothing after the last subscriber")
  }

  func testAnUpdateDuringAReadAnswersTheRead() {
    XCTAssertTrue(succeeded(subscribe(1)()))
    peripheral.respondsAutomatically = false
    var read: Result<Data, CoreError>?
    session.read(AttributePath(service: testService, characteristic: stream), timeout: nil) { read = $0 }
    scheduler.runUntilIdle()
    peripheral.notify(fake(stream), value: Data([1]))
    XCTAssertEqual(try read?.get(), Data([1]))
    XCTAssertTrue(received.isEmpty)
    peripheral.notify(fake(stream), value: Data([2]))
    XCTAssertEqual(received.map(\.value), [Data([2])])
  }

  func testModesAndConflicts() {
    XCTAssertTrue(succeeded(subscribe(1, indicateOnly)()))
    XCTAssertEqual(code(subscribe(2, indicateOnly, mode: .notify)()), .notSupported)
    XCTAssertEqual(code(subscribe(3, both, mode: .indicate)()), .notSupported, "iOS picks notifications")
    XCTAssertEqual(code(subscribe(4, stream, mode: .indicate)()), .notSupported)
    XCTAssertTrue(succeeded(subscribe(5, stream, mode: .notify)()))
    XCTAssertEqual(code(subscribe(6, readOnly)()), .notSupported)
    XCTAssertEqual(code(subscribe(5)()), .invalidArgument, "an id already in use")
  }

  func testFailedCCCDWritesReject() {
    peripheral.respondsAutomatically = false
    let failed = subscribe(1)
    peripheral.completeSetNotify(true, for: fake(stream), error: NSError(domain: CBATTErrorDomain, code: 5))
    XCTAssertEqual(code(failed()), .insufficientAuthentication)
    peripheral.notify(fake(stream), value: Data([1]))
    XCTAssertTrue(received.isEmpty)

    peripheral.respondsAutomatically = true
    XCTAssertTrue(succeeded(subscribe(2)()))
    peripheral.respondsAutomatically = false
    let leaving = unsubscribe(2)
    peripheral.completeSetNotify(false, for: fake(stream), error: NSError(domain: CBATTErrorDomain, code: 3))
    XCTAssertEqual(code(leaving()), .writeNotPermitted)
  }

  func testADisconnectEndsEverySubscription() {
    XCTAssertTrue(succeeded(subscribe(1)()))
    central.simulateDisconnection(of: peripheral, error: NSError(domain: CBErrorDomain, code: 7))
    peripheral.notify(fake(stream), value: Data([1]))
    XCTAssertTrue(received.isEmpty)
    let calls = peripheral.calls.count
    XCTAssertTrue(succeeded(unsubscribe(1)()))
    XCTAssertEqual(peripheral.calls.count, calls, "nothing to write on a dead link")
    XCTAssertEqual(code(subscribe(2)()), .disconnected)
  }
}
