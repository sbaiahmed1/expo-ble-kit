import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P2-05: several connections at once, each with its own queue; one dropping leaves the others.
final class MultipleDevicesTests: XCTestCase {
  private let testService = "0c6c1000-b347-4cfa-9827-1c5a13658519"
  private let staticRead = "0c6c1001-b347-4cfa-9827-1c5a13658519"
  private let stream = "0c6c1007-b347-4cfa-9827-1c5a13658519"

  private var scheduler: TestScheduler!
  private var central: FakeCentralManager!
  private var engine: CentralEngine!
  private var peripherals: [FakePeripheral] = []
  private var states: [String: [String]] = [:]
  private var received: [String: Int] = [:]

  private var ids: [String] { peripherals.map(\.identifier.uuidString) }

  override func setUpWithError() throws {
    try super.setUpWithError()
    scheduler = TestScheduler()
    central = FakeCentralManager()
    peripherals = (0..<6).map { _ in
      FakePeripheral(services: [
        FakeService(uuid: testService, characteristics: [
          FakeCharacteristic(uuid: staticRead, properties: [.read], value: Data([1])),
          FakeCharacteristic(uuid: stream, properties: [.notify])
        ])
      ])
    }
    peripherals.forEach { central.knownPeripherals[$0.identifier] = $0 }
    let environment = CentralEngine.Environment(
      authorization: { .allowedAlways },
      infoDictionary: { [CentralEngine.usageDescriptionKey: "Uses Bluetooth"] },
      makeCentral: { [unowned self] _, _ in central }
    )
    engine = CentralEngine(queue: DispatchQueue(label: "test"), environment: environment, scheduler: scheduler)
    engine.onConnectionStateChange = { [unowned self] id, state, error in
      states[id, default: []].append(error.map { "\(state.js) \($0.code.rawValue)" } ?? state.js)
    }
    engine.onNotification = { [unowned self] id, _, _, _, _ in received[id, default: 0] += 1 }
    engine.activateIfAuthorized()
    central.simulateState(.poweredOn)

    var connected: [String] = []
    for id in ids {
      try engine.connect(id, spec: ConnectSpec(timeout: 15)) { error in
        if error == nil {
          connected.append(id)
        }
      }
    }
    // The links come up in another order than they were asked for.
    for peripheral in peripherals.reversed() {
      peripheral.respondsAutomatically = true
      central.simulateConnection(of: peripheral)
      scheduler.runUntilIdle()
    }
    XCTAssertEqual(connected, ids.reversed())
    for id in ids {
      var subscribed = false
      session(id).subscribe(path(stream), mode: .auto, subscriptionId: 1, timeout: nil) { result in
        subscribed = (try? result.get()) != nil
      }
      scheduler.runUntilIdle()
      XCTAssertTrue(subscribed)
    }
  }

  private func session(_ id: String) -> PeripheralSession {
    engine.session(id) { (_: Result<Void, CoreError>) in }!
  }

  private func path(_ characteristic: String) -> AttributePath {
    AttributePath(service: testService, characteristic: characteristic)
  }

  func testSixConnectionsAtOnceEachReady() throws {
    XCTAssertTrue(ids.allSatisfy { engine.connectionState($0) == "connected" })
    let sessions = try XCTUnwrap(engine.diagnostics()["sessions"] as? [[String: Any]])
    XCTAssertEqual(sessions.count, 6)
    XCTAssertTrue(sessions.allSatisfy { $0["subscriptions"] as? Int == 1 && $0["queueDepth"] as? Int == 0 })
  }

  func testAnOperationStuckOnOneDeviceDoesntHoldUpTheOthers() {
    peripherals[0].respondsAutomatically = false
    var stuck: Result<Data, CoreError>?
    session(ids[0]).read(path(staticRead), timeout: 5) { stuck = $0 }
    var reads: [String: Bool] = [:]
    for id in ids.dropFirst() {
      session(id).read(path(staticRead), timeout: 5) { reads[id] = (try? $0.get()) != nil }
    }
    scheduler.runUntilIdle()
    XCTAssertNil(stuck)
    XCTAssertEqual(reads, Dictionary(uniqueKeysWithValues: ids.dropFirst().map { ($0, true) }))
    scheduler.advance(by: 5)
    if case let .failure(error) = stuck {
      XCTAssertEqual(error.code, .operationTimeout)
    } else {
      XCTFail("the stuck read times out")
    }
  }

  func testOneDeviceDroppingLeavesTheOthersConnectedAndDelivering() {
    let dropped = ids[0]
    peripherals[0].respondsAutomatically = false
    var pending: Result<Data, CoreError>?
    session(dropped).read(path(staticRead), timeout: nil) { pending = $0 }
    scheduler.runUntilIdle()

    central.simulateDisconnection(of: peripherals[0], error: NSError(domain: CBErrorDomain, code: 7))
    scheduler.runUntilIdle()
    XCTAssertEqual(states[dropped]?.last, "disconnected DISCONNECTED")
    if case let .failure(error) = pending {
      XCTAssertEqual(error.code, .disconnected)
    } else {
      XCTFail("the pending read rejects")
    }

    for peripheral in peripherals.dropFirst() {
      peripheral.notify(peripheral.characteristic(stream)!, value: Data([1]))
    }
    scheduler.runUntilIdle()
    let others = Array(ids.dropFirst())
    XCTAssertEqual(received, Dictionary(uniqueKeysWithValues: others.map { ($0, 1) }))
    XCTAssertTrue(others.allSatisfy { states[$0] == ["connecting", "connected"] }, "their states didn't move")
    var reads = 0
    for id in others {
      session(id).read(path(staticRead), timeout: nil) { result in
        if (try? result.get()) != nil {
          reads += 1
        }
      }
    }
    scheduler.runUntilIdle()
    XCTAssertEqual(reads, 5)
  }
}
