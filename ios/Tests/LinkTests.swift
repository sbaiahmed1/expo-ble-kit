import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P1-09: the derived MTU, requestMtu() and readRssi() on iOS.
final class LinkTests: XCTestCase {
  private var scheduler: TestScheduler!
  private var central: FakeCentralManager!
  private var engine: CentralEngine!
  private var peripheral: FakePeripheral!
  private var id: String { peripheral.identifier.uuidString }
  private var mtuChanges: [Int] = []

  override func setUpWithError() throws {
    try super.setUpWithError()
    scheduler = TestScheduler()
    central = FakeCentralManager()
    peripheral = FakePeripheral(services: [FakeService(uuid: "180d", characteristics: [])])
    peripheral.maximumWriteLength[.withoutResponse] = 182
    central.knownPeripherals[peripheral.identifier] = peripheral
    let environment = CentralEngine.Environment(
      authorization: { .allowedAlways },
      infoDictionary: { [CentralEngine.usageDescriptionKey: "Uses Bluetooth"] },
      makeCentral: { [unowned self] _, _ in central }
    )
    engine = CentralEngine(queue: DispatchQueue(label: "test"), environment: environment, scheduler: scheduler)
    engine.onMtuChange = { [unowned self] _, mtu in mtuChanges.append(mtu) }
    engine.activateIfAuthorized()
    central.simulateState(.poweredOn)
    peripheral.respondsAutomatically = true
  }

  private func connect() throws -> PeripheralSession {
    try engine.connect(id, spec: ConnectSpec(timeout: 15)) { _ in }
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
    let session = engine.session(id) { (_: Result<Void, CoreError>) in }
    XCTAssertEqual(session?.state, .ready)
    return try XCTUnwrap(session)
  }

  private func requestMtu(_ session: PeripheralSession, _ mtu: Int) -> Result<Int, CoreError>? {
    var result: Result<Int, CoreError>?
    session.requestMtu(mtu) { result = $0 }
    return result
  }

  private func readRssi(_ session: PeripheralSession) -> () -> Result<Int, CoreError>? {
    var result: Result<Int, CoreError>?
    session.readRssi(timeout: nil) { result = $0 }
    scheduler.runUntilIdle()
    return { result }
  }

  private func code<T>(_ result: Result<T, CoreError>?) -> CoreError.Code? {
    if case let .failure(error) = result {
      return error.code
    }
    return nil
  }

  func testTheMtuIsDerivedWhenTheConnectionIsReady() throws {
    XCTAssertEqual(engine.mtu(id), 23)
    _ = try connect()
    XCTAssertEqual(engine.mtu(id), 185, "maximumWriteValueLength(.withoutResponse) + 3")
    XCTAssertEqual(mtuChanges, [], "no mtuChange for the value at connect")

    central.simulateDisconnection(of: peripheral, error: nil)
    XCTAssertEqual(engine.mtu(id), 23)
  }

  func testRequestMtuChecksTheRangeAndResolvesTheCurrentMtu() throws {
    let session = try connect()
    XCTAssertEqual(code(requestMtu(session, 22)), .invalidArgument)
    XCTAssertEqual(code(requestMtu(session, 518)), .invalidArgument)
    XCTAssertEqual(try requestMtu(session, 517)?.get(), 185)
    XCTAssertEqual(mtuChanges, [])

    // iOS finished its own exchange after the connection was ready.
    peripheral.maximumWriteLength[.withoutResponse] = 244
    XCTAssertEqual(try requestMtu(session, 23)?.get(), 247)
    XCTAssertEqual(mtuChanges, [247])
    XCTAssertEqual(engine.mtu(id), 247)
  }

  func testReadRssiReadsTheLinkRssi() throws {
    let session = try connect()
    peripheral.rssi = -71
    XCTAssertEqual(try readRssi(session)()?.get(), -71)
    XCTAssertTrue(peripheral.calls.contains(.readRSSI))

    peripheral.respondsAutomatically = false
    let failed = readRssi(session)
    session.peripheral(peripheral, didReadRSSI: 0, error: NSError(domain: CBErrorDomain, code: 0))
    XCTAssertNotNil(code(failed()))
  }

  func testMtuAndRssiNeedAConnection() throws {
    let session = try connect()
    central.simulateDisconnection(of: peripheral, error: nil)
    XCTAssertEqual(code(requestMtu(session, 185)), .disconnected)
    XCTAssertEqual(code(readRssi(session)()), .disconnected)
  }
}
