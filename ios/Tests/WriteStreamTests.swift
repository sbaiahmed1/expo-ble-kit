import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P2-03: writeStream on iOS: chunks through the queue, progress, abort, failures.
final class WriteStreamTests: XCTestCase {
  private let testService = "0c6c1000-b347-4cfa-9827-1c5a13658519"
  private let staticRead = "0c6c1001-b347-4cfa-9827-1c5a13658519"
  private let echoWrite = "0c6c1003-b347-4cfa-9827-1c5a13658519"
  private let sink = "0c6c1005-b347-4cfa-9827-1c5a13658519"

  private var scheduler: TestScheduler!
  private var central: FakeCentralManager!
  private var engine: CentralEngine!
  private var peripheral: FakePeripheral!
  private var session: PeripheralSession!
  private var progress: [[Int]] = []
  private var result: Result<Void, CoreError>?

  override func setUpWithError() throws {
    try super.setUpWithError()
    scheduler = TestScheduler()
    central = FakeCentralManager()
    peripheral = FakePeripheral(services: [
      FakeService(uuid: testService, characteristics: [
        FakeCharacteristic(uuid: staticRead, properties: [.read], value: Data(0..<20)),
        FakeCharacteristic(uuid: echoWrite, properties: [.write]),
        FakeCharacteristic(uuid: sink, properties: [.writeWithoutResponse])
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

  private func stream(
    _ data: Data,
    to characteristic: String? = nil,
    withResponse: Bool = false,
    chunkSize: Int? = nil,
    timeout: TimeInterval? = nil
  ) {
    let request = PeripheralSession.StreamRequest(
      data: data,
      withResponse: withResponse,
      chunkSize: chunkSize,
      timeout: timeout,
      operationId: 7
    )
    session.writeStream(
      AttributePath(service: testService, characteristic: characteristic ?? sink),
      request,
      onProgress: { [unowned self] sent, total in progress.append([sent, total]) },
      completion: { [unowned self] in result = $0 }
    )
    scheduler.runUntilIdle()
  }

  /// The values written to `characteristic`, in order.
  private func written(_ characteristic: String, withResponse: Bool) -> [Data] {
    peripheral.calls.compactMap { call in
      if case let .write(uuid, value, response) = call, uuid == CBUUID(string: characteristic),
         response == withResponse {
        return value
      }
      return nil
    }
  }

  /// The peripheral acknowledges the write with response in flight.
  private func acknowledge(error: Error? = nil) {
    peripheral.completeWrite(peripheral.characteristic(echoWrite)!, error: error)
    scheduler.runUntilIdle()
  }

  private var code: CoreError.Code? {
    if case let .failure(error) = result {
      return error.code
    }
    return nil
  }

  func testAPayloadGoesOutInPacketsInOrderWithAbout100ProgressReports() throws {
    peripheral.writeWithoutResponseBuffer = 4
    let data = Data((0..<65_536).map { UInt8(($0 * 7) % 256) })
    stream(data)
    while result == nil {
      peripheral.drainWritesWithoutResponse()
      scheduler.runUntilIdle()
    }
    XCTAssertNoThrow(try result?.get())
    let packets = written(sink, withResponse: false)
    XCTAssertEqual(packets.count, 65_536 / 20 + 1)
    XCTAssertEqual(Data(packets.joined()), data)
    XCTAssertEqual(peripheral.droppedWrites, 0)
    XCTAssertEqual(progress.last, [65_536, 65_536])
    XCTAssertTrue((90...101).contains(progress.count), "\(progress.count) reports")
  }

  func testAChunkSizeAndWritesWithResponse() {
    peripheral.respondsAutomatically = true
    stream(Data(count: 1_000), to: echoWrite, withResponse: true, chunkSize: 300)
    XCTAssertNoThrow(try result?.get())
    XCTAssertEqual(written(echoWrite, withResponse: true).map(\.count), [300, 300, 300, 100])
    XCTAssertEqual(progress, [[300, 1_000], [600, 1_000], [900, 1_000], [1_000, 1_000]])
  }

  func testOperationsIssuedDuringTheStreamWaitForItsEnd() {
    stream(Data(count: 60), to: echoWrite, withResponse: true, chunkSize: 20)
    var read: Result<Data, CoreError>?
    session.read(AttributePath(service: testService, characteristic: staticRead), timeout: nil) { read = $0 }
    scheduler.runUntilIdle()
    acknowledge()
    acknowledge()
    XCTAssertFalse(peripheral.calls.contains(.read(CBUUID(string: staticRead))))
    acknowledge()
    XCTAssertNoThrow(try result?.get())
    XCTAssertEqual(peripheral.calls.last, .read(CBUUID(string: staticRead)), "the read only starts now")
    XCTAssertNil(read)
  }

  func testCancellingStopsTheStreamWithinTheChunkInFlight() {
    stream(Data(count: 200), to: echoWrite, withResponse: true, chunkSize: 20)
    acknowledge()
    acknowledge()
    session.cancel(7)
    XCTAssertEqual(code, .operationCancelled)
    XCTAssertEqual(written(echoWrite, withResponse: true).count, 3)
    acknowledge()
    scheduler.advance(by: 60)
    XCTAssertEqual(written(echoWrite, withResponse: true).count, 3, "no chunk after the one in flight")
  }

  func testAFailedChunkEndsTheStreamAndSaysHowFarItGot() {
    stream(Data(count: 100), to: echoWrite, withResponse: true, chunkSize: 20)
    acknowledge()
    acknowledge(error: CBATTError(.writeNotPermitted))
    XCTAssertEqual(code, .writeNotPermitted)
    if case let .failure(error) = result {
      XCTAssertTrue(error.message.contains("after 20 of 100 bytes"), error.message)
    }
    scheduler.advance(by: 60)
    XCTAssertEqual(written(echoWrite, withResponse: true).count, 2)
  }

  func testTheTimeoutAppliesToEachChunk() {
    stream(Data(count: 60), to: echoWrite, withResponse: true, chunkSize: 20, timeout: 1)
    scheduler.advance(by: 0.9)
    acknowledge()
    scheduler.advance(by: 0.9)
    acknowledge()
    XCTAssertNil(result, "each chunk had its own second")
    scheduler.advance(by: 1)
    XCTAssertEqual(code, .operationTimeout)
  }

  func testADisconnectRejectsTheStream() {
    stream(Data(count: 100), to: echoWrite, withResponse: true, chunkSize: 20)
    acknowledge()
    central.simulateDisconnection(of: peripheral, error: NSError(domain: CBErrorDomain, code: 7))
    scheduler.runUntilIdle()
    XCTAssertEqual(code, .disconnected)
  }

  func testChunkSizesAreCheckedAndEmptyDataWritesNothing() {
    stream(Data(count: 100), chunkSize: 21)
    XCTAssertEqual(code, .invalidArgument, "one packet at most without response")
    stream(Data(count: 100), to: echoWrite, withResponse: true, chunkSize: 513)
    XCTAssertEqual(code, .invalidArgument)
    stream(Data(count: 100), to: echoWrite)
    XCTAssertEqual(code, .writeNotPermitted)
    stream(Data())
    XCTAssertNoThrow(try result?.get())
    XCTAssertTrue(written(sink, withResponse: false).isEmpty)
    XCTAssertTrue(progress.isEmpty)
  }
}
