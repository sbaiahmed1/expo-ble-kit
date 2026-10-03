import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P2-04: native notification batching per subscriber, and the overflow policy, on iOS.
final class BatchingTests: XCTestCase {
  private let testService = "0c6c1000-b347-4cfa-9827-1c5a13658519"
  private let stream = "0c6c1007-b347-4cfa-9827-1c5a13658519"

  private var scheduler: TestScheduler!
  private var central: FakeCentralManager!
  private var engine: CentralEngine!
  private var peripheral: FakePeripheral!
  private var session: PeripheralSession!
  private var single: [Data] = []
  private var batches: [(id: Int, batch: NotificationBatch)] = []
  private var warnings: [CoreError] = []
  private var log: [String] = []

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
    engine.onNotification = { [unowned self] _, _, _, value, _ in single.append(value) }
    engine.onNotificationBatch = { [unowned self] _, id, batch in
      batches.append((id, batch))
      log.append("batch \(id)")
    }
    engine.onWarning = { [unowned self] in warnings.append($0) }
    engine.onConnectionStateChange = { [unowned self] _, state, _ in log.append(state.js) }
    engine.activateIfAuthorized()
    central.simulateState(.poweredOn)
    peripheral.respondsAutomatically = true
    try engine.connect(peripheral.identifier.uuidString, spec: ConnectSpec(timeout: 15)) { _ in }
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
    session = engine.session(peripheral.identifier.uuidString) { (_: Result<Void, CoreError>) in }
    log.removeAll()
  }

  private func subscribe(_ id: Int, _ batch: BatchSpec?) {
    var result: Result<Void, CoreError>?
    let path = AttributePath(service: testService, characteristic: stream)
    session.subscribe(path, mode: .auto, subscriptionId: id, timeout: nil, batch: batch) { result = $0 }
    scheduler.runUntilIdle()
    XCTAssertNoThrow(try result?.get())
  }

  private func notify(_ bytes: UInt8...) {
    peripheral.notify(peripheral.characteristic(stream)!, value: Data(bytes))
  }

  private func firstBytes(_ batch: NotificationBatch) -> [UInt8] {
    batch.values.map { $0.first! }
  }

  func testValuesWithinOneIntervalComeAsOneBatchWithTheirArrivalTimes() throws {
    subscribe(1, BatchSpec(interval: 0.016))
    notify(1)
    scheduler.advance(by: 0.005)
    notify(2)
    scheduler.advance(by: 0.010)
    XCTAssertTrue(batches.isEmpty, "not before the interval")
    scheduler.advance(by: 0.001)
    let batch = try XCTUnwrap(batches.first?.batch)
    XCTAssertEqual(firstBytes(batch), [1, 2])
    XCTAssertEqual(batch.timestamps[1] - batch.timestamps[0], 5, accuracy: 0.001)
    XCTAssertEqual(batch.dropped, 0)
    XCTAssertTrue(single.isEmpty, "no single events for a batched subscriber")

    scheduler.advance(by: 1)
    XCTAssertEqual(batches.count, 1, "nothing while idle")
  }

  func testBatchedAndUnbatchedSubscribersShareACharacteristic() {
    subscribe(1, BatchSpec(interval: 0.016))
    subscribe(2, nil)
    subscribe(3, BatchSpec(interval: 0.1))
    notify(7)
    scheduler.advance(by: 0.1)
    XCTAssertEqual(single, [Data([7])])
    XCTAssertEqual(batches.map(\.id), [1, 3])
  }

  func testAFullBatchDropsItsOldestValuesCountsThemAndWarnsOnce() {
    subscribe(1, BatchSpec(interval: 0.1, maxItems: 3))
    (1...5).forEach { notify($0) }
    scheduler.advance(by: 0.1)
    XCTAssertEqual(batches.last.map { firstBytes($0.batch) }, [3, 4, 5])
    XCTAssertEqual(batches.last?.batch.dropped, 2)
    XCTAssertEqual(warnings.map(\.code), [.bufferOverflow])

    (1...4).forEach { notify($0) }
    scheduler.advance(by: 0.1)
    XCTAssertEqual(batches.last?.batch.dropped, 1)
    XCTAssertEqual(warnings.count, 1, "the warning comes once per subscription")
  }

  func testUnsubscribingStopsDeliveryAtOnce() {
    subscribe(1, BatchSpec(interval: 0.016))
    subscribe(2, nil)
    notify(1)
    session.unsubscribe(1, timeout: nil) { _ in }
    scheduler.advance(by: 0.1)
    XCTAssertTrue(batches.isEmpty)
  }

  func testADisconnectDeliversTheCollectedValuesBeforeTheStateChanges() {
    subscribe(1, BatchSpec(interval: 1))
    notify(1)
    central.simulateDisconnection(of: peripheral, error: NSError(domain: CBErrorDomain, code: 7))
    scheduler.runUntilIdle()
    XCTAssertEqual(log, ["batch 1", "disconnected"])
    scheduler.advance(by: 2)
    XCTAssertEqual(batches.count, 1, "nothing after the end")
  }

  func test100HzOf20BytesFor10MinutesWith16MsBatches() {
    subscribe(1, BatchSpec(interval: 0.016))
    let count = 100 * 60 * 10
    for index in 0..<count {
      var frame = Data(repeating: 0, count: 20)
      frame[0] = UInt8(index & 0xFF)
      peripheral.notify(peripheral.characteristic(stream)!, value: frame)
      scheduler.advance(by: 0.01)
    }
    scheduler.advance(by: 0.016)
    XCTAssertLessThanOrEqual(Double(batches.count) / 600, 63)
    XCTAssertEqual(batches.reduce(0) { $0 + $1.batch.dropped }, 0)
    XCTAssertEqual(batches.flatMap { firstBytes($0.batch) }, (0..<count).map { UInt8($0 & 0xFF) })
    XCTAssertTrue(warnings.isEmpty)
  }
}
