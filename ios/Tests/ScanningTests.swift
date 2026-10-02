import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P1-04: advertisement parsing, session filters and multiplexing on iOS.
final class ScanningTests: XCTestCase {
  private let testService = "0c6c1000-b347-4cfa-9827-1c5a13658519"
  private let heartRate = "0000180d-0000-1000-8000-00805f9b34fb"
  private let battery = "0000180f-0000-1000-8000-00805f9b34fb"

  /// What CoreBluetooth reports for the test peripheral (test-peripherals/profile.json).
  private var testAdvertisement: [String: Any] {
    [
      CBAdvertisementDataLocalNameKey: "BleKit-Test",
      CBAdvertisementDataServiceUUIDsKey: [CBUUID(string: testService)],
      CBAdvertisementDataServiceDataKey: [CBUUID(string: "180D"): Data([0x01, 0x02])],
      CBAdvertisementDataTxPowerLevelKey: NSNumber(value: 0),
      CBAdvertisementDataManufacturerDataKey: Data([0xFF, 0xFF, 0x42, 0x4B, 0x00, 0x01]),
      CBAdvertisementDataIsConnectable: NSNumber(value: true)
    ]
  }

  private var scheduler: TestScheduler!
  private var controller: ScanController!
  private var central: FakeCentralManager!
  private var delivered: [Int: [[String]]] = [:]
  private var ended: [Int: CoreError] = [:]

  override func setUp() {
    super.setUp()
    scheduler = TestScheduler()
    controller = ScanController(scheduler: scheduler, clock: EpochClock(wallAtStartMs: 1_000_000, monotonicAtStart: 0))
    central = FakeCentralManager()
    delivered = [:]
    ended = [:]
    controller.onResults = { [unowned self] sessionId, results in
      delivered[sessionId, default: []].append(results.compactMap { $0["name"] as? String })
    }
    controller.onError = { [unowned self] sessionId, error in ended[sessionId] = error }
  }

  private func discover(_ name: String, services: [String] = [], rssi: Int = -60, id: UUID = UUID()) {
    let peripheral = FakePeripheral(identifier: id, name: nil)
    controller.deliver(
      peripheral,
      advertisementData: [
        CBAdvertisementDataLocalNameKey: name,
        CBAdvertisementDataServiceUUIDsKey: services.map(CBUUID.init(string:))
      ],
      rssi: rssi
    )
  }

  private func names(_ sessionId: Int) -> [String] {
    delivered[sessionId, default: []].flatMap { $0 }
  }

  func testParsesTheTestPeripheralAdvertisement() {
    let id = UUID()
    let record = ScanRecord(
      identifier: id,
      peripheralName: "Cached",
      advertisementData: testAdvertisement,
      rssi: -48,
      timestamp: 1_700_000_000_000
    )
    XCTAssertEqual(record.id, id.uuidString)
    XCTAssertEqual(record.name, "BleKit-Test")
    XCTAssertEqual(record.txPowerLevel, 0)
    XCTAssertEqual(record.isConnectable, true)
    XCTAssertEqual(record.serviceUUIDs, [testService])
    XCTAssertEqual(record.serviceData, [heartRate: Data([0x01, 0x02])])
    XCTAssertEqual(record.manufacturerData, [0xFFFF: Data([0x42, 0x4B, 0x00, 0x01])])

    let dictionary = record.dictionary
    XCTAssertEqual(
      Set(dictionary.keys),
      [
        "id", "name", "rssi", "txPowerLevel", "isConnectable", "serviceUUIDs", "serviceData",
        "manufacturerData", "rawAdvertisement", "timestamp"
      ]
    )
    XCTAssertEqual(dictionary["manufacturerData"] as? [String: Data], ["65535": Data([0x42, 0x4B, 0x00, 0x01])])
    XCTAssertTrue(dictionary["rawAdvertisement"] is NSNull)

    let bare = ScanRecord(identifier: id, peripheralName: "Cached", advertisementData: [:], rssi: -90, timestamp: 0)
    XCTAssertEqual(bare.name, "Cached")
    XCTAssertTrue(bare.dictionary["txPowerLevel"] is NSNull)
  }

  func testUUIDsAreLowercase128Bit() {
    XCTAssertEqual(CBUUID(string: "180D").fullUUIDString, heartRate)
    XCTAssertEqual(CBUUID(string: "1234ABCD").fullUUIDString, "1234abcd-0000-1000-8000-00805f9b34fb")
    XCTAssertEqual(CBUUID(string: testService.uppercased()).fullUUIDString, testService)
  }

  func testSessionFilters() {
    let filter = ManufacturerFilter(companyId: 0xFFFF, data: Data([0x42, 0x4B]), mask: Data([0xFF, 0x0F]))
    XCTAssertTrue(filter.matches(Data([0x42, 0xFB, 0x00])))
    XCTAssertFalse(filter.matches(Data([0x43, 0x4B])))
    XCTAssertFalse(filter.matches(Data([0x42])))

    let record = ScanRecord(
      identifier: UUID(),
      peripheralName: nil,
      advertisementData: testAdvertisement,
      rssi: -50,
      timestamp: 0
    )
    XCTAssertTrue(ScanSpec().matches(record))
    let all = ScanSpec(services: [heartRate, testService], namePrefix: "BleKit", manufacturerData: [filter])
    XCTAssertTrue(all.matches(record))
    XCTAssertFalse(ScanSpec(services: [heartRate]).matches(record), "service data isn't an advertised service")
    XCTAssertFalse(ScanSpec(namePrefix: "blekit").matches(record))
    XCTAssertFalse(ScanSpec(manufacturerData: [ManufacturerFilter(companyId: 0x004C)]).matches(record))
  }

  func testUnionScansForEveryServiceUnlessASessionIsUnfiltered() {
    let union = PlatformScan.union([
      ScanSpec(services: [heartRate]),
      ScanSpec(services: [battery, heartRate], allowDuplicates: true, solicitedServices: [testService])
    ])
    XCTAssertEqual(union.services, [heartRate, battery])
    XCTAssertEqual(union.options[CBCentralManagerScanOptionAllowDuplicatesKey] as? Bool, true)
    XCTAssertEqual(
      union.options[CBCentralManagerScanOptionSolicitedServiceUUIDsKey] as? [CBUUID],
      [CBUUID(string: testService)]
    )
    XCTAssertNil(PlatformScan.union([ScanSpec(services: [heartRate]), ScanSpec(namePrefix: "x")]).services)
  }

  func testSessionsWaitForPoweredOnThenShareOneScan() {
    controller.start(1, spec: ScanSpec(services: [heartRate]))
    XCTAssertTrue(central.calls.isEmpty)
    controller.poweredOn(central)
    XCTAssertEqual(central.calls, [.scan([CBUUID(string: heartRate)])])

    controller.start(2, spec: ScanSpec(services: [battery]))
    XCTAssertEqual(central.calls.last, .scan([CBUUID(string: heartRate), CBUUID(string: battery)]))
    controller.start(3, spec: ScanSpec(services: [battery]))
    XCTAssertEqual(central.calls.count, 2, "same union, no new scan call")

    discover("Pulse", services: [heartRate])
    discover("Cell", services: [battery])
    XCTAssertEqual(names(1), ["Pulse"])
    XCTAssertEqual(names(2), ["Cell"])
    XCTAssertEqual(names(3), ["Cell"])

    controller.stop(1)
    XCTAssertEqual(central.calls.last, .scan([CBUUID(string: battery)]))
    discover("Cell 2", services: [battery])
    XCTAssertEqual(names(2), ["Cell", "Cell 2"], "stopping one session leaves the others running")
    controller.stop(2)
    controller.stop(3)
    XCTAssertEqual(central.calls.last, .stopScan)
  }

  func testDuplicatesAndBatching() {
    controller.poweredOn(central)
    let device = UUID()
    controller.start(1, spec: ScanSpec())
    controller.start(2, spec: ScanSpec(allowDuplicates: true, reportInterval: 0.5))
    discover("A", rssi: -70, id: device)
    scheduler.advance(by: 0.2)
    discover("A", rssi: -50, id: device)
    discover("B")
    discover("Ignored", rssi: 127)
    XCTAssertEqual(names(1), ["A", "B"])
    XCTAssertNil(delivered[2])
    scheduler.advance(by: 0.3)
    XCTAssertEqual(delivered[2], [["A", "B"]])
    scheduler.advance(by: 1)
    XCTAssertEqual(delivered[2]?.count, 1, "no empty batches")
  }

  func testTimestampsAreEpochMilliseconds() {
    var timestamps: [Double] = []
    controller.onResults = { _, results in timestamps += results.compactMap { $0["timestamp"] as? Double } }
    controller.poweredOn(central)
    controller.start(1, spec: ScanSpec())
    scheduler.advance(by: 0.005)
    discover("A")
    XCTAssertEqual(timestamps, [1_000_005])
  }

  func testStopAllEndsEverySession() {
    controller.poweredOn(central)
    controller.start(1, spec: ScanSpec())
    controller.start(2, spec: ScanSpec(services: [heartRate]))
    controller.stopAll(CoreError(.bluetoothPoweredOff, "Bluetooth is off"))
    XCTAssertEqual(Set(ended.keys), [1, 2])
    XCTAssertEqual(ended[1]?.code, .bluetoothPoweredOff)
    XCTAssertTrue(controller.activeSessionIds.isEmpty)
    XCTAssertNotEqual(central.calls.last, .stopScan, "CoreBluetooth already stopped it")
  }
}
