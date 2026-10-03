import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P2-07: the core's log: levels, forwarding, and one debug line per GATT operation.
final class LoggingTests: XCTestCase {
  private var lines: [String] = []
  private var entries: [LogEntry] = []

  func testOnlyLinesAtOrAboveTheLevelAreWrittenAndBuilt() {
    let logger = BleLogger(clock: { 42 }, platform: { [unowned self] level, line in
      lines.append("\(level.rawValue) \(line)")
    })
    var built = 0
    logger.log(.debug) {
      built += 1
      return "debug"
    }
    logger.log(.warn, peripheralId: "A1", opId: 7) {
      built += 1
      return "warn"
    }
    XCTAssertEqual(lines, ["warn A1 op #7: warn"], "the default level is warn")
    XCTAssertEqual(built, 1, "messages below the level are never built")

    logger.level = .none
    logger.log(.error) { "error" }
    XCTAssertEqual(lines.count, 1)

    logger.level = .verbose
    logger.forward = { [unowned self] in entries.append($0) }
    logger.log(.verbose, peripheralId: "A1", opId: 3) { "values" }
    XCTAssertEqual(entries, [LogEntry(level: .verbose, message: "values", timestamp: 42, peripheralId: "A1", opId: 3)])
  }

  func testEveryGattOperationLogsItsIdKindStatusAndDurationAtDebug() throws {
    let testService = "0c6c1000-b347-4cfa-9827-1c5a13658519"
    let staticRead = "0c6c1001-b347-4cfa-9827-1c5a13658519"
    let scheduler = TestScheduler()
    let central = FakeCentralManager()
    let peripheral = FakePeripheral(services: [
      FakeService(uuid: testService, characteristics: [FakeCharacteristic(uuid: staticRead, properties: [.read])])
    ])
    central.knownPeripherals[peripheral.identifier] = peripheral
    let environment = CentralEngine.Environment(
      authorization: { .allowedAlways },
      infoDictionary: { [CentralEngine.usageDescriptionKey: "Uses Bluetooth"] },
      makeCentral: { _, _ in central }
    )
    let engine = CentralEngine(queue: DispatchQueue(label: "test"), environment: environment, scheduler: scheduler)
    engine.logger.level = .debug
    engine.logger.platform = { [unowned self] _, line in lines.append(line) }
    engine.activateIfAuthorized()
    central.simulateState(.poweredOn)
    peripheral.respondsAutomatically = true
    let id = peripheral.identifier.uuidString
    try engine.connect(id, spec: ConnectSpec(timeout: 15)) { _ in }
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
    let session = try XCTUnwrap(engine.session(id) { (_: Result<Void, CoreError>) in })
    XCTAssertTrue(lines.contains("\(id): connected"), "connection states at info")
    lines.removeAll()

    peripheral.respondsAutomatically = false
    let path = AttributePath(service: testService, characteristic: staticRead)
    session.read(path, timeout: nil) { _ in }
    scheduler.runUntilIdle()
    scheduler.advance(by: 0.034)
    peripheral.completeRead(peripheral.characteristic(staticRead)!)
    session.read(path, timeout: 1) { _ in }
    scheduler.advance(by: 1)
    XCTAssertEqual(lines.count, 2, "\(lines)")
    XCTAssertTrue(lines[0].hasPrefix("\(id) op #"), lines[0])
    XCTAssertTrue(lines[0].hasSuffix(": ok in 34 ms"), lines[0])
    XCTAssertTrue(lines[0].contains(": read "), lines[0])
    XCTAssertTrue(lines[1].hasSuffix("OPERATION_TIMEOUT (Operation read timed out after 1.0 s) in 1000 ms"), lines[1])
  }
}
