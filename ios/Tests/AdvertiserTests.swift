import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P4-03: the advertiser core with a fake peripheral manager.
final class AdvertiserTests: XCTestCase {
  private let test = CBUUID(string: "0c6c1000-b347-4cfa-9827-1c5a13658519")
  private var scheduler: TestScheduler!
  private var manager: FakePeripheralManager!
  private var advertiser: Advertiser!
  private var warnings: [String] = []

  override func setUp() {
    super.setUp()
    scheduler = TestScheduler()
    manager = FakePeripheralManager()
    advertiser = Advertiser(manager: manager, scheduler: scheduler)
    advertiser.onWarning = { [unowned self] in self.warnings.append($0.message) }
  }

  private func spec(
    localName: String? = "BleKit-Test",
    manufacturer: Bool = false,
    serviceData: Bool = false,
    txPower: Bool = false,
    connectable: Bool = true
  ) -> AdvertisingSpec {
    AdvertisingSpec(localName: localName, serviceUUIDs: [test], hasManufacturerData: manufacturer,
                    hasServiceData: serviceData, includeTxPower: txPower, connectable: connectable)
  }

  private func start(_ spec: AdvertisingSpec) -> () -> String {
    var result = "pending"
    advertiser.start(spec) { outcome in
      switch outcome {
      case let .success(id): result = "id \(id)"
      case let .failure(error): result = error.code.rawValue
      }
    }
    return { result }
  }

  func testAdvertisesNameAndServicesOneAtATime() {
    let first = start(spec())
    XCTAssertEqual(manager.advertisements, [.init(localName: "BleKit-Test", serviceUUIDs: [test])])
    XCTAssertEqual(first(), "pending")
    manager.didStartAdvertising()
    XCTAssertEqual(first(), "id 1")
    XCTAssertEqual(start(spec())(), "ADVERTISING_FAILED")
    advertiser.stop(9)
    XCTAssertEqual(manager.advertisingStops, 0)
    advertiser.stop(1)
    XCTAssertEqual(manager.advertisingStops, 1)
    XCTAssertNil(advertiser.running)
    XCTAssertTrue(warnings.isEmpty)
  }

  func testWarnsAboutWhatIOSDoesNotAdvertise() {
    _ = start(spec(manufacturer: true, serviceData: true, txPower: true, connectable: false))
    XCTAssertEqual(warnings, [
      "iOS advertises only localName and serviceUUIDs: manufacturerData, serviceData, includeTxPower not advertised",
      "iOS can't advertise without accepting connections: connectable ignored"
    ])
  }

  func testWaitsForANewManagerAndMapsItsStates() {
    manager.becomes(.unknown)
    let waiting = start(spec())
    XCTAssertTrue(manager.advertisements.isEmpty)
    manager.becomes(.poweredOn)
    XCTAssertEqual(manager.advertisements.count, 1)
    manager.didStartAdvertising()
    XCTAssertEqual(waiting(), "id 1")
    manager.becomes(.poweredOff)
    XCTAssertNil(advertiser.running, "iOS stops advertising with Bluetooth")
    XCTAssertEqual(start(spec())(), "BLUETOOTH_POWERED_OFF")
    manager.becomes(.unauthorized)
    XCTAssertEqual(start(spec())(), "BLUETOOTH_UNAUTHORIZED")
  }

  func testErrorsTheDeadlineAndClose() {
    let refused = start(spec())
    manager.didStartAdvertising(error: NSError(domain: CBErrorDomain, code: CBError.alreadyAdvertising.rawValue))
    XCTAssertEqual(refused(), "ADVERTISING_FAILED")

    let silent = start(spec())
    scheduler.advance(by: Advertiser.startTimeout)
    XCTAssertEqual(silent(), "OPERATION_TIMEOUT")
    manager.didStartAdvertising() // too late: ignored
    XCTAssertNil(advertiser.running)

    let running = start(spec())
    manager.didStartAdvertising()
    XCTAssertEqual(running(), "id 3")
    advertiser.close(CoreError(.disconnected, "closed"))
    XCTAssertNil(advertiser.running)
    let pending = start(spec())
    advertiser.close(CoreError(.disconnected, "closed"))
    XCTAssertEqual(pending(), "DISCONNECTED")
  }
}
