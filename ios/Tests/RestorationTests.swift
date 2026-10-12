import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P3-01: state restoration. iOS hands back the peripherals it kept for the app to the manager
/// created with the same restore identifier, before the first state update.
final class RestorationTests: XCTestCase {
  private let heartRate = "0000180d-0000-1000-8000-00805f9b34fb"
  private let measurement = "00002a37-0000-1000-8000-00805f9b34fb"
  private let bodyLocation = "00002a38-0000-1000-8000-00805f9b34fb"

  private var scheduler: TestScheduler!
  private var central: FakeCentralManager!
  private var engine: CentralEngine!
  private var infoPlist: [String: Any] = [:]
  private var createOptions: [String: Any]?
  private var restored: [RestoredPeripheral] = []
  private var received: [(characteristic: String, value: Data)] = []

  override func setUp() {
    super.setUp()
    scheduler = TestScheduler()
    central = FakeCentralManager()
    infoPlist = [
      CentralEngine.usageDescriptionKey: "Uses Bluetooth",
      CentralEngine.restoreIdentifierKey: "test-restore",
      "UIBackgroundModes": ["bluetooth-central"]
    ]
    restored = []
    received = []
    makeEngine()
  }

  private func makeEngine() {
    let environment = CentralEngine.Environment(
      authorization: { .allowedAlways },
      infoDictionary: { [unowned self] in infoPlist },
      makeCentral: { [unowned self] _, options in
        createOptions = options
        return central
      }
    )
    engine = CentralEngine(queue: DispatchQueue(label: "test"), environment: environment, scheduler: scheduler)
    engine.onRestored = { [unowned self] in restored.append(contentsOf: $0) }
    engine.onNotification = { [unowned self] _, _, characteristic, value, _ in
      received.append((characteristic, value))
    }
  }

  /// A heart rate monitor as iOS restores it: `state`, with its database discovered when connected.
  private func monitor(_ state: CBPeripheralState, discovered: Bool = true, notifying: Bool = true) -> FakePeripheral {
    let peripheral = FakePeripheral(services: [
      FakeService(uuid: heartRate, characteristics: [
        FakeCharacteristic(uuid: measurement, properties: [.notify]),
        FakeCharacteristic(uuid: bodyLocation, properties: [.read])
      ])
    ])
    peripheral.state = state
    if discovered {
      peripheral.discoveredServices = peripheral.services
      for service in peripheral.services {
        service.discoveredCharacteristics = service.characteristics
      }
      peripheral.characteristic(measurement)?.isNotifying = notifying
    }
    central.knownPeripherals[peripheral.identifier] = peripheral
    return peripheral
  }

  private func restore(_ peripherals: [FakePeripheral]) {
    engine.activateIfAuthorized()
    central.delegate?.central(central, willRestoreState: [:], peripherals: peripherals)
    central.simulateState(.poweredOn)
    scheduler.runUntilIdle()
  }

  func testTheManagerGetsTheRestoreIdentifierOnlyWithTheBackgroundMode() {
    engine.activateIfAuthorized()
    XCTAssertEqual(createOptions?[CBCentralManagerOptionRestoreIdentifierKey] as? String, "test-restore")

    infoPlist["UIBackgroundModes"] = ["bluetooth-peripheral"]
    makeEngine()
    engine.activateIfAuthorized()
    XCTAssertNil(createOptions?[CBCentralManagerOptionRestoreIdentifierKey])
    XCTAssertNil(engine.restoreIdentifier)
  }

  func testAConnectedPeripheralIsReadyAndKeepsDeliveringItsNotifications() throws {
    let peripheral = monitor(.connected)
    restore([peripheral])

    let id = peripheral.identifier.uuidString
    XCTAssertEqual(restored.map(\.id), [id])
    XCTAssertEqual(restored.first?.state, "connected")
    XCTAssertEqual(restored.first?.subscriptions, ["\(heartRate)/\(measurement)"])
    XCTAssertEqual(engine.connectionState(id), "connected")
    XCTAssertEqual(engine.services(id).count, 1, "the discovery cache comes from what iOS kept")
    XCTAssertTrue(peripheral.calls.isEmpty, "nothing is discovered or enabled again")

    let value = Data([0x00, 72])
    peripheral.notify(try XCTUnwrap(peripheral.characteristic(measurement)), value: value)
    XCTAssertEqual(received.map(\.value), [value])
    XCTAssertEqual(received.first?.characteristic, measurement)
  }

  func testAJsSubscriptionTakesTheRestoredCharacteristicOver() throws {
    let peripheral = monitor(.connected)
    peripheral.respondsAutomatically = true
    restore([peripheral])
    let session = try XCTUnwrap(engine.sessions[peripheral.identifier])
    XCTAssertEqual(session.subscriptionCount, 0, "a restored subscription isn't a JS one")

    var subscribed: Result<Void, CoreError>?
    let path = AttributePath(service: heartRate, characteristic: measurement)
    session.subscribe(path, mode: .auto, subscriptionId: 1, timeout: 10) { subscribed = $0 }
    XCTAssertNotNil(try subscribed?.get(), "the CCCD is already on")
    XCTAssertEqual(session.subscriptionCount, 1)
    XCTAssertTrue(session.restoredSubscriptions.isEmpty)

    session.unsubscribe(1, timeout: 10) { _ in }
    scheduler.runUntilIdle()
    XCTAssertEqual(peripheral.calls.last, .setNotify(false, CBUUID(string: measurement)), "JS owns it now")
  }

  func testAConnectedPeripheralWithoutServicesIsDiscoveredFirst() {
    let peripheral = monitor(.connected, discovered: false)
    peripheral.respondsAutomatically = true
    restore([peripheral])

    XCTAssertEqual(peripheral.calls.first, .discoverServices(nil))
    XCTAssertEqual(engine.connectionState(peripheral.identifier.uuidString), "connected")
  }

  func testAPendingConnectionStaysPendingWithoutATimeout() {
    let peripheral = monitor(.connecting, discovered: false)
    peripheral.respondsAutomatically = true
    restore([peripheral])
    let id = peripheral.identifier.uuidString
    XCTAssertEqual(restored.first?.state, "connecting")

    scheduler.advance(by: 3600)
    XCTAssertEqual(engine.connectionState(id), "connecting")
    XCTAssertFalse(central.calls.contains(.cancelConnection(peripheral.identifier)), "iOS keeps the pending connect")

    peripheral.state = .connected
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
    XCTAssertEqual(engine.connectionState(id), "connected")
  }

  func testAJsConnectTakesARestoredPendingConnectionOverWithItsTimeout() throws {
    let peripheral = monitor(.connecting, discovered: false)
    restore([peripheral])
    var result: CoreError??
    try engine.connect(peripheral.identifier.uuidString, spec: ConnectSpec(timeout: 15)) { result = .some($0) }
    XCTAssertEqual(central.calls.last, .connect(peripheral.identifier), "CoreBluetooth's connect again")
    scheduler.advance(by: 15)
    XCTAssertEqual(result??.code, .connectionTimeout, "not an endless wait")
  }

  func testADisconnectedPeripheralIsDropped() {
    let peripheral = monitor(.disconnected, discovered: false)
    restore([peripheral])
    XCTAssertTrue(restored.isEmpty)
    XCTAssertNil(engine.sessions[peripheral.identifier])
  }

  func testRestoredPeripheralsWaitForTheManagerToPowerOn() {
    let peripheral = monitor(.connected)
    engine.activateIfAuthorized()
    central.delegate?.central(central, willRestoreState: [:], peripherals: [peripheral])
    XCTAssertTrue(restored.isEmpty)
    central.simulateState(.poweredOn)
    XCTAssertEqual(restored.count, 1)
  }

  // MARK: Journal

  func testTheJournalCountsRepeatsKeepsTheLastEntriesAndSurvivesARelaunch() throws {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathComponent("journal.json")
    let journal = RestorationJournal(url: url)
    journal.record("launched in the background", at: 1)
    journal.record("notification 1", at: 2, repeating: "hrm")
    journal.record("notification 2", at: 3, repeating: "hrm")
    XCTAssertEqual(journal.all.map(\.count), [1, 2])
    XCTAssertEqual(journal.all.last?.event, "notification 2")

    let relaunched = RestorationJournal(url: url)
    XCTAssertEqual(relaunched.all, journal.all)

    for index in 0..<(RestorationJournal.maxEntries + 5) {
      relaunched.record("entry \(index)", at: Double(index))
    }
    XCTAssertEqual(relaunched.all.count, RestorationJournal.maxEntries)
    XCTAssertEqual(relaunched.all.last?.event, "entry \(RestorationJournal.maxEntries + 4)")
    relaunched.clear()
    XCTAssertTrue(RestorationJournal(url: url).all.isEmpty)
  }
}
