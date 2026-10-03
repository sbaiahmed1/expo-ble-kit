import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P2-06: the peripheral's GATT database changes while connected (`didModifyServices`).
final class ServiceChangeTests: XCTestCase {
  private let testService = "0c6c1000-b347-4cfa-9827-1c5a13658519"
  private let stream = "0c6c1007-b347-4cfa-9827-1c5a13658519"
  private let secondary = "0c6c2000-b347-4cfa-9827-1c5a13658519"
  private let secondaryValue = "0c6c2001-b347-4cfa-9827-1c5a13658519"

  private var scheduler: TestScheduler!
  private var central: FakeCentralManager!
  private var engine: CentralEngine!
  private var peripheral: FakePeripheral!
  private var session: PeripheralSession!
  private var log: [String] = []

  private func testServiceObject() -> FakeService {
    FakeService(uuid: testService, characteristics: [FakeCharacteristic(uuid: stream, properties: [.notify])])
  }

  override func setUpWithError() throws {
    try super.setUpWithError()
    scheduler = TestScheduler()
    central = FakeCentralManager()
    peripheral = FakePeripheral(services: [
      testServiceObject(),
      FakeService(uuid: secondary, characteristics: [FakeCharacteristic(uuid: secondaryValue, properties: [.notify])])
    ])
    central.knownPeripherals[peripheral.identifier] = peripheral
    let environment = CentralEngine.Environment(
      authorization: { .allowedAlways },
      infoDictionary: { [CentralEngine.usageDescriptionKey: "Uses Bluetooth"] },
      makeCentral: { [unowned self] _, _ in central }
    )
    engine = CentralEngine(queue: DispatchQueue(label: "test"), environment: environment, scheduler: scheduler)
    engine.onServicesChanged = { [unowned self] _ in
      log.append("servicesChanged \(session.services.map(\.uuid))")
    }
    engine.onSubscriptionEnded = { [unowned self] _, id, error in log.append("ended \(id) \(error.code.rawValue)") }
    engine.activateIfAuthorized()
    central.simulateState(.poweredOn)
    peripheral.respondsAutomatically = true
  }

  private func connect() throws {
    try engine.connect(peripheral.identifier.uuidString, spec: ConnectSpec(timeout: 15)) { _ in }
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
    session = engine.session(peripheral.identifier.uuidString) { (_: Result<Void, CoreError>) in }
  }

  private func subscribe(_ id: Int, _ service: String, _ characteristic: String) {
    var ok = false
    let path = AttributePath(service: service, characteristic: characteristic)
    session.subscribe(path, mode: .auto, subscriptionId: id, timeout: nil) { ok = (try? $0.get()) != nil }
    scheduler.runUntilIdle()
    XCTAssertTrue(ok)
  }

  private func discoveries() -> Int {
    peripheral.calls.filter { if case .discoverServices = $0 { return true } else { return false } }.count
  }

  func testAServiceChangeDiscoversAgainRestoresWhatIsThereThenReportsIt() throws {
    try connect()
    subscribe(1, testService, stream)
    subscribe(2, secondary, secondaryValue)
    let before = discoveries()

    // The peripheral drops the secondary service; the remaining one comes back as new objects.
    peripheral.services = [testServiceObject()]
    peripheral.discoveredServices = []
    peripheral.delegate?.peripheral(peripheral, didModifyServices: [])
    scheduler.runUntilIdle()

    XCTAssertEqual(discoveries(), before + 1)
    XCTAssertEqual(log, ["ended 2 CHARACTERISTIC_NOT_FOUND", "servicesChanged [\"\(testService)\"]"])
    XCTAssertEqual(session.subscriptionCount, 1)
    XCTAssertEqual(peripheral.calls.last, .setNotify(true, CBUUID(string: stream)), "the CCCD is enabled again")
  }

  func testAServiceChangeDuringSetupIsLeftToTheDiscoveryUnderWay() throws {
    peripheral.respondsAutomatically = false
    try engine.connect(peripheral.identifier.uuidString, spec: ConnectSpec(timeout: 15)) { _ in }
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
    session = engine.session(peripheral.identifier.uuidString) { (_: Result<Void, CoreError>) in }
    peripheral.delegate?.peripheral(peripheral, didModifyServices: [])
    scheduler.runUntilIdle()
    XCTAssertEqual(discoveries(), 1)
    XCTAssertTrue(log.isEmpty)
  }
}
