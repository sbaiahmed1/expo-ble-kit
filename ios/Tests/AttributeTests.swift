import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P1-07: reads, writes and descriptors on iOS, through the queue.
final class AttributeTests: XCTestCase {
  private let testService = "0c6c1000-b347-4cfa-9827-1c5a13658519"
  private let staticRead = "0c6c1001-b347-4cfa-9827-1c5a13658519"
  private let echoWrite = "0c6c1003-b347-4cfa-9827-1c5a13658519"
  private let sink = "0c6c1005-b347-4cfa-9827-1c5a13658519"
  private let stream = "0c6c1007-b347-4cfa-9827-1c5a13658519"
  private let userDescription = "00002901-0000-1000-8000-00805f9b34fb"

  private var scheduler: TestScheduler!
  private var central: FakeCentralManager!
  private var engine: CentralEngine!
  private var peripheral: FakePeripheral!
  private var session: PeripheralSession!

  override func setUpWithError() throws {
    try super.setUpWithError()
    scheduler = TestScheduler()
    central = FakeCentralManager()
    peripheral = FakePeripheral(services: [
      FakeService(uuid: testService, characteristics: [
        FakeCharacteristic(uuid: staticRead, properties: [.read], value: Data(0..<20)),
        FakeCharacteristic(uuid: echoWrite, properties: [.write]),
        FakeCharacteristic(uuid: sink, properties: [.writeWithoutResponse]),
        FakeCharacteristic(uuid: stream, properties: [.notify], descriptors: [
          FakeDescriptor(uuid: "2902"),
          FakeDescriptor(uuid: "2901", value: Data("Stream".utf8))
        ])
      ])
    ])
    central.knownPeripherals[peripheral.identifier] = peripheral
    let environment = CentralEngine.Environment(
      authorization: { .allowedAlways },
      infoDictionary: { [CentralEngine.usageDescriptionKey: "Uses Bluetooth"] },
      makeCentral: { [unowned self] _, _ in central }
    )
    engine = CentralEngine(queue: DispatchQueue(label: "test"), environment: environment, scheduler: scheduler)
    engine.activateIfAuthorized()
    central.simulateState(.poweredOn)
    peripheral.respondsAutomatically = true
    try engine.connect(peripheral.identifier.uuidString, spec: ConnectSpec(timeout: 15)) { _ in }
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
    session = engine.session(peripheral.identifier.uuidString) { (_: Result<Void, CoreError>) in }
    XCTAssertEqual(session.state, .ready)
    peripheral.respondsAutomatically = false
  }

  // MARK: Helpers: start an operation, run the queue, and return a reader for its result

  private typealias Outcome<T> = () -> Result<T, CoreError>?

  private func outcome<T>(_ start: (@escaping (Result<T, CoreError>) -> Void) -> Void) -> Outcome<T> {
    var result: Result<T, CoreError>?
    start { result = $0 }
    scheduler.runUntilIdle()
    return { result }
  }

  private func path(_ characteristic: String, _ descriptor: String? = nil, service: String? = nil) -> AttributePath {
    AttributePath(service: service ?? testService, characteristic: characteristic, descriptor: descriptor)
  }

  private func read(_ characteristic: String, service: String? = nil) -> Outcome<Data> {
    outcome { session.read(path(characteristic, service: service), timeout: nil, completion: $0) }
  }

  private func write(_ characteristic: String, _ value: Data, withResponse: Bool = true) -> Outcome<Void> {
    outcome {
      session.write(path(characteristic), value: value, withResponse: withResponse, timeout: nil, completion: $0)
    }
  }

  /// The values the peripheral received on SINK_NO_RSP, in order.
  private func sinkWrites() -> [Data] {
    peripheral.calls.compactMap { call in
      if case let .write(uuid, value, withResponse: false) = call, uuid == CBUUID(string: sink) {
        return value
      }
      return nil
    }
  }

  private func readDescriptor(_ characteristic: String, _ descriptor: String) -> Outcome<Data> {
    outcome { session.readDescriptor(path(characteristic, descriptor), timeout: nil, completion: $0) }
  }

  private func writeDescriptor(_ characteristic: String, _ descriptor: String, _ value: Data) -> Outcome<Void> {
    outcome { session.writeDescriptor(path(characteristic, descriptor), value: value, timeout: nil, completion: $0) }
  }

  private func code<T>(_ result: Result<T, CoreError>?) -> CoreError.Code? {
    if case let .failure(error) = result {
      return error.code
    }
    return nil
  }

  private func written(_ characteristic: String, _ value: Data, withResponse: Bool) -> Bool {
    peripheral.calls.contains(.write(CBUUID(string: characteristic), value, withResponse: withResponse))
  }

  // MARK: Tests

  func testReadsReturnTheValue() {
    peripheral.respondsAutomatically = true
    XCTAssertEqual(try read(staticRead)()?.get(), Data(0..<20))
  }

  func testAttErrorsMapToCodes() {
    let result = read(staticRead)
    peripheral.completeRead(peripheral.characteristic(staticRead)!, error: NSError(domain: CBATTErrorDomain, code: 5))
    XCTAssertEqual(code(result()), .insufficientAuthentication)
  }

  func testChecksComeBeforeTheRadio() {
    let calls = peripheral.calls.count
    XCTAssertEqual(code(read(echoWrite)()), .readNotPermitted)
    XCTAssertEqual(code(write(staticRead, Data([1]))()), .writeNotPermitted)
    XCTAssertEqual(code(write(echoWrite, Data([1]), withResponse: false)()), .writeNotPermitted)
    XCTAssertEqual(code(read(staticRead, service: "180d")()), .serviceNotFound)
    XCTAssertEqual(code(read("2a37")()), .characteristicNotFound)
    XCTAssertEqual(code(readDescriptor(stream, "2904")()), .descriptorNotFound)
    XCTAssertEqual(peripheral.calls.count, calls)

    central.simulateDisconnection(of: peripheral, error: NSError(domain: CBErrorDomain, code: 7))
    XCTAssertEqual(code(read(staticRead)()), .disconnected)
  }

  func testWritesWithResponseTakeUpTo512Bytes() {
    peripheral.respondsAutomatically = true
    let long = Data((0..<512).map { UInt8(($0 * 31 + 7) % 256) })
    XCTAssertNoThrow(try write(echoWrite, long)()?.get())
    XCTAssertTrue(written(echoWrite, long, withResponse: true))
    XCTAssertEqual(code(write(echoWrite, Data(count: 513))()), .invalidAttributeLength)
  }

  func testWritesWithoutResponseFitOnePacketAndWaitUntilTheyCanBeSent() {
    let tooLong = write(sink, Data(count: 21), withResponse: false)
    XCTAssertEqual(code(tooLong()), .invalidAttributeLength, "maximumWriteValueLength(.withoutResponse) is 20")

    peripheral.canSendWriteWithoutResponse = false
    let result = write(sink, Data(count: 20), withResponse: false)
    XCTAssertNil(result())
    XCTAssertFalse(written(sink, Data(count: 20), withResponse: false))
    peripheral.canSendWriteWithoutResponse = true
    peripheral.delegate?.peripheralIsReadyToSendWriteWithoutResponse(peripheral)
    XCTAssertTrue(written(sink, Data(count: 20), withResponse: false))
    XCTAssertNoThrow(try result()?.get())
  }

  func testAWaitingPacketIsNeverSentOnceItsOperationEnded() {
    peripheral.canSendWriteWithoutResponse = false
    let timedOut = outcome {
      session.write(path(sink), value: Data([1]), withResponse: false, timeout: 1, completion: $0)
    }
    scheduler.advance(by: 1)
    XCTAssertEqual(code(timedOut()), .operationTimeout)

    peripheral.canSendWriteWithoutResponse = true
    let next = write(sink, Data([2]), withResponse: false)
    XCTAssertNoThrow(try next()?.get())
    peripheral.drainWritesWithoutResponse()
    XCTAssertEqual(sinkWrites(), [Data([2])])
  }

  func testAReadyCallbackWhileItStillCannotSendKeepsWaiting() {
    peripheral.canSendWriteWithoutResponse = false
    let result = write(sink, Data([1]), withResponse: false)
    peripheral.delegate?.peripheralIsReadyToSendWriteWithoutResponse(peripheral)
    XCTAssertNil(result())
    XCTAssertEqual(peripheral.droppedWrites, 0)
    peripheral.drainWritesWithoutResponse()
    XCTAssertNoThrow(try result()?.get())
  }

  func testPacketsArePacedByTheBufferAndArriveCompleteAndInOrder() {
    peripheral.writeWithoutResponseBuffer = 4
    let packets = (0..<1_000).map { Data([UInt8($0 % 256), UInt8($0 / 256)]) }
    let results = packets.map { write(sink, $0, withResponse: false) }
    while results.contains(where: { $0() == nil }) {
      peripheral.drainWritesWithoutResponse()
      scheduler.runUntilIdle()
    }
    XCTAssertTrue(results.allSatisfy { (try? $0()?.get()) != nil })
    XCTAssertEqual(peripheral.droppedWrites, 0)
    XCTAssertEqual(sinkWrites(), packets)
  }

  func testDescriptorsAreReadAndWrittenButNotTheCCCD() {
    peripheral.respondsAutomatically = true
    XCTAssertEqual(try readDescriptor(stream, userDescription)()?.get(), Data("Stream".utf8))
    XCTAssertNoThrow(try writeDescriptor(stream, userDescription, Data("S".utf8))()?.get())
    XCTAssertEqual(code(writeDescriptor(stream, "2902", Data([1, 0]))()), .invalidArgument)
    XCTAssertFalse(peripheral.calls.contains(.writeDescriptor(CBUUID(string: "2902"), Data([1, 0]))))
  }

  func testOperationsWaitForEachOther() {
    let first = read(staticRead)
    let second = write(echoWrite, Data([1]))
    XCTAssertFalse(written(echoWrite, Data([1]), withResponse: true), "one operation at a time")
    peripheral.completeRead(peripheral.characteristic(staticRead)!)
    scheduler.runUntilIdle()
    XCTAssertEqual(try first()?.get(), Data(0..<20))
    peripheral.completeWrite(peripheral.characteristic(echoWrite)!)
    XCTAssertNoThrow(try second()?.get())
  }

  func testOperationsAreCancelledByTheIdJsGaveThem() {
    let running = outcome { session.read(path(staticRead), timeout: nil, operationId: 1, completion: $0) }
    let queued: Outcome<Void> = outcome {
      session.write(path(echoWrite), value: Data([1]), withResponse: true, timeout: nil, operationId: 2, completion: $0)
    }
    session.cancel(2)
    XCTAssertEqual(code(queued()), .operationCancelled)

    session.cancel(1)
    XCTAssertEqual(code(running()), .operationCancelled, "answered at once")
    let next = read(staticRead)
    XCTAssertEqual(peripheral.calls.filter { $0 == .read(CBUUID(string: staticRead)) }.count, 1, "the radio is busy")
    // The radio answers the cancelled read (discarded), then the next read runs.
    peripheral.completeRead(peripheral.characteristic(staticRead)!)
    scheduler.runUntilIdle()
    peripheral.completeRead(peripheral.characteristic(staticRead)!)
    XCTAssertEqual(try next()?.get(), Data(0..<20))
    XCTAssertFalse(written(echoWrite, Data([1]), withResponse: true), "the cancelled write never ran")

    session.cancel(1)
    session.cancel(42)
    XCTAssertEqual(code(running()), .operationCancelled, "finished and unknown ids do nothing")
  }
}
