import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P1-01: the CoreBluetooth abstractions, their real adapters and the fakes used by later tests.
final class AbstractionsTests: XCTestCase {
  private let heartRate = "180D"
  private let measurement = "2A37"
  private let bodySensorLocation = "2A38"

  // MARK: Real CoreBluetooth types

  func testCoreBluetoothAttributesConformToTheAbstractions() {
    let characteristic = CBMutableCharacteristic(
      type: CBUUID(string: measurement), properties: [.notify], value: nil, permissions: []
    )
    let service = CBMutableService(type: CBUUID(string: heartRate), primary: true)
    service.characteristics = [characteristic]

    let serviceLike: ServiceLike = service
    XCTAssertEqual(serviceLike.uuid, CBUUID(string: heartRate))
    XCTAssertTrue(serviceLike.isPrimary)
    XCTAssertEqual(serviceLike.characteristicList.map(\.uuid), [CBUUID(string: measurement)])

    let characteristicLike: CharacteristicLike = characteristic
    XCTAssertEqual(characteristicLike.properties, [.notify])
    XCTAssertTrue(characteristicLike.descriptorList.isEmpty)
  }

  func testDescriptorValuesBecomeBytes() {
    XCTAssertEqual(DescriptorValue.data(from: Data([1, 2])), Data([1, 2]))
    XCTAssertEqual(DescriptorValue.data(from: "Stream"), Data("Stream".utf8))
    // CCCD with notifications enabled, as CoreBluetooth reports it.
    XCTAssertEqual(DescriptorValue.data(from: NSNumber(value: 1)), Data([0x01, 0x00]))
    XCTAssertNil(DescriptorValue.data(from: nil))
  }

  // MARK: Fakes

  func testFakeCentralDrivesStateDiscoveryAndConnection() {
    let central = FakeCentralManager()
    let delegate = RecordingCentralDelegate()
    central.delegate = delegate
    let peripheral = FakePeripheral(name: "HRM")

    central.simulateState(.poweredOn)
    central.scanForPeripherals(withServices: [CBUUID(string: heartRate)], options: nil)
    central.simulateDiscovery(of: peripheral, rssi: -42)
    central.connect(peripheral, options: nil)
    central.simulateConnection(of: peripheral)
    central.simulateDisconnection(of: peripheral, error: nil)

    XCTAssertEqual(delegate.events, [
      "state poweredOn",
      "discover HRM -42",
      "connect HRM",
      "disconnect HRM reconnecting=false"
    ])
    XCTAssertEqual(central.calls, [.scan([CBUUID(string: heartRate)]), .connect(peripheral.identifier)])
    XCTAssertTrue(central.isScanning)
    XCTAssertIdentical(central.retrievePeripherals(withIdentifiers: [peripheral.identifier]).first, peripheral)
  }

  func testFakePeripheralHoldsOperationsUntilTheTestCompletesThem() {
    let measurementCharacteristic = FakeCharacteristic(uuid: measurement, properties: [.notify])
    let location = FakeCharacteristic(uuid: bodySensorLocation, properties: [.read], value: Data([0x01]))
    let peripheral = FakePeripheral(services: [
      FakeService(uuid: heartRate, characteristics: [measurementCharacteristic, location])
    ])
    let delegate = RecordingPeripheralDelegate()
    peripheral.delegate = delegate

    peripheral.discoverServices(nil)
    XCTAssertTrue(peripheral.serviceList.isEmpty, "nothing is discovered until the test completes the call")
    peripheral.completeServiceDiscovery()
    let service = peripheral.serviceList[0]
    peripheral.discoverCharacteristics(nil, for: service)
    peripheral.completeCharacteristicDiscovery(for: peripheral.services[0])

    peripheral.readValue(for: location)
    XCTAssertTrue(delegate.reads.isEmpty, "the read stays in flight")
    peripheral.completeRead(location)

    XCTAssertEqual(
      service.characteristicList.map(\.uuid),
      [CBUUID(string: measurement), CBUUID(string: bodySensorLocation)]
    )
    XCTAssertEqual(delegate.reads, [Data([0x01])])
    XCTAssertEqual(peripheral.calls, [
      .discoverServices(nil),
      .discoverCharacteristics(nil, service: CBUUID(string: heartRate)),
      .read(CBUUID(string: bodySensorLocation))
    ])
  }

  func testFakePeripheralCanRespondAutomaticallyAndNotify() {
    let measurementCharacteristic = FakeCharacteristic(uuid: measurement, properties: [.notify])
    let peripheral = FakePeripheral(
      services: [FakeService(uuid: heartRate, characteristics: [measurementCharacteristic])]
    )
    peripheral.respondsAutomatically = true
    let delegate = RecordingPeripheralDelegate()
    peripheral.delegate = delegate

    peripheral.setNotifyValue(true, for: measurementCharacteristic)
    peripheral.notify(measurementCharacteristic, value: Data([0x00, 72]))

    XCTAssertTrue(measurementCharacteristic.isNotifying)
    XCTAssertEqual(delegate.notificationStates, [true])
    XCTAssertEqual(delegate.reads, [Data([0x00, 72])])
  }

  // MARK: Scheduling

  func testTestSchedulerRunsDueWorkInOrderAndSkipsCancelledWork() {
    let scheduler = TestScheduler()
    var log: [String] = []

    scheduler.schedule(after: 2) { log.append("timeout 2s") }
    let cancelled = scheduler.schedule(after: 1) { log.append("cancelled") }
    scheduler.schedule { log.append("now") }
    scheduler.schedule(after: 1) {
      log.append("1s")
      scheduler.schedule { log.append("scheduled from 1s") }
    }
    cancelled.cancel()

    scheduler.runUntilIdle()
    XCTAssertEqual(log, ["now"])
    scheduler.advance(by: 1.5)
    XCTAssertEqual(log, ["now", "1s", "scheduled from 1s"])
    XCTAssertEqual(scheduler.now, 1.5)
    scheduler.advance(by: 1)
    XCTAssertEqual(log, ["now", "1s", "scheduled from 1s", "timeout 2s"])
    XCTAssertEqual(scheduler.pendingCount, 0)
  }

  func testQueueSchedulerRunsOnItsQueue() {
    let queue = DispatchQueue(label: "expo.blekit.test")
    let key = DispatchSpecificKey<Bool>()
    queue.setSpecific(key: key, value: true)
    let scheduler = QueueScheduler(queue: queue)
    let ran = expectation(description: "delayed work ran on the queue")

    scheduler.schedule(after: 0.01) {
      XCTAssertEqual(DispatchQueue.getSpecific(key: key), true)
      ran.fulfill()
    }
    wait(for: [ran], timeout: 2)
  }
}

private final class RecordingCentralDelegate: CentralManagingDelegate {
  private(set) var events: [String] = []

  func centralDidUpdateState(_ central: CentralManaging) {
    events.append("state \(central.state == .poweredOn ? "poweredOn" : "\(central.state.rawValue)")")
  }

  func central(
    _ central: CentralManaging,
    didDiscover peripheral: PeripheralLike,
    advertisementData: [String: Any],
    rssi: Int
  ) {
    events.append("discover \(peripheral.name ?? "?") \(rssi)")
  }

  func central(_ central: CentralManaging, didConnect peripheral: PeripheralLike) {
    events.append("connect \(peripheral.name ?? "?")")
  }

  func central(
    _ central: CentralManaging,
    didDisconnect peripheral: PeripheralLike,
    isReconnecting: Bool,
    error: Error?
  ) {
    events.append("disconnect \(peripheral.name ?? "?") reconnecting=\(isReconnecting)")
  }
}

private final class RecordingPeripheralDelegate: PeripheralLikeDelegate {
  private(set) var reads: [Data?] = []
  private(set) var notificationStates: [Bool] = []

  func peripheral(
    _ peripheral: PeripheralLike,
    didUpdateValue value: Data?,
    for characteristic: CharacteristicLike,
    error: Error?
  ) {
    reads.append(value)
  }

  func peripheral(
    _ peripheral: PeripheralLike,
    didUpdateNotificationStateFor characteristic: CharacteristicLike,
    error: Error?
  ) {
    notificationStates.append(characteristic.isNotifying)
  }
}
