import CoreBluetooth
import XCTest
@testable import BleKitCore

/// P5-03: L2CAP channels and servers (plan §5.5 L2CAP rules).
final class L2CAPTests: XCTestCase {
  private var scheduler: TestScheduler!
  private var central: FakeCentralManager!
  private var engine: CentralEngine!
  private var peripheral: FakePeripheral!
  private var id: String { peripheral.identifier.uuidString }

  override func setUpWithError() throws {
    try super.setUpWithError()
    scheduler = TestScheduler()
    central = FakeCentralManager()
    peripheral = FakePeripheral(services: [])
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
  }

  private func connect() throws -> PeripheralSession {
    try engine.connect(id, spec: ConnectSpec(timeout: 15)) { _ in }
    central.simulateConnection(of: peripheral)
    scheduler.runUntilIdle()
    return try XCTUnwrap(engine.session(id) { (_: Result<Void, CoreError>) in })
  }

  private func open(_ psm: Int, timeout: TimeInterval? = nil, operationId: Int? = nil)
    -> () -> Result<L2CAPChannel, CoreError>? {
    var result: Result<L2CAPChannel, CoreError>?
    engine.openL2CAPChannel(id, psm: psm, timeout: timeout, operationId: operationId) { result = $0 }
    return { result }
  }

  private func code<T>(_ result: Result<T, CoreError>?) -> String? {
    switch result {
    case .success: return "ok"
    case let .failure(error): return error.code.rawValue
    case nil: return nil
    }
  }

  private func openChannel(_ psm: Int = 0x81) throws -> (L2CAPChannel, FakeL2CAPChannel) {
    let pending = open(psm)
    let fake = FakeL2CAPChannel(psm: CBL2CAPPSM(psm), peer: peripheral.identifier)
    peripheral.completeL2CAPOpen(fake)
    return try (XCTUnwrap(pending()).get(), fake)
  }

  func testOpensOneChannelAtATimeOnAReadyConnection() throws {
    XCTAssertEqual(code(open(0x81)()), "DISCONNECTED")
    _ = try connect()
    XCTAssertEqual(code(open(0)()), "INVALID_ARGUMENT")
    let first = open(0x81)
    let second = open(0x82)
    XCTAssertEqual(peripheral.calls.filter { if case .openL2CAPChannel = $0 { return true } else { return false } },
                   [.openL2CAPChannel(0x81)])
    let channel = FakeL2CAPChannel(psm: 0x81, peer: peripheral.identifier)
    peripheral.completeL2CAPOpen(channel)
    let opened = try XCTUnwrap(first()).get()
    XCTAssertEqual(opened.psm, 0x81)
    XCTAssertEqual(opened.peerId, id)
    XCTAssertTrue(channel.opened)
    XCTAssertEqual(peripheral.calls.last, .openL2CAPChannel(0x82))
    peripheral.completeL2CAPOpen(nil, error: CBError(.unknown))
    XCTAssertEqual(code(second()), "L2CAP_FAILED")
  }

  func testATimeoutOrACancelAnswersAtOnceAndAClosesTheLateChannel() throws {
    _ = try connect()
    let slow = open(0x81, timeout: 1)
    let cancelled = open(0x82, operationId: 7)
    engine.cancelOperation(id, operationId: 7)
    XCTAssertEqual(code(cancelled()), "OPERATION_CANCELLED")
    scheduler.advance(by: 1)
    XCTAssertEqual(code(slow()), "OPERATION_TIMEOUT")
    // CoreBluetooth was still working on the first one: its late channel is closed.
    let late = FakeL2CAPChannel(psm: 0x81)
    peripheral.completeL2CAPOpen(late)
    XCTAssertTrue(late.closed)
    XCTAssertEqual(peripheral.calls.filter { $0 == .openL2CAPChannel(0x82) }.count, 0)
  }

  func testReadingStartsWithReceive() throws {
    _ = try connect()
    let (channel, fake) = try openChannel()
    var received = Data()
    channel.onData = { received.append($0) }
    fake.send(Data([1, 2, 3]))
    XCTAssertTrue(received.isEmpty)
    channel.receive()
    XCTAssertEqual(received, Data([1, 2, 3]))
    fake.send(Data([4]))
    XCTAssertEqual(received, Data([1, 2, 3, 4]))

    var closes: [String] = []
    channel.onClose = { closes.append($0?.code.rawValue ?? "none") }
    fake.end()
    XCTAssertEqual(closes, ["none"])
    XCTAssertFalse(channel.isOpen)
    XCTAssertTrue(fake.closed)
  }

  func testWritesFollowTheStreamAndAStallClosesTheChannel() throws {
    _ = try connect()
    let (channel, fake) = try openChannel()
    fake.room = 3
    var results: [String] = []
    channel.write(Data([1, 2, 3, 4, 5])) { results.append($0?.code.rawValue ?? "ok") }
    channel.write(Data([6])) { results.append($0?.code.rawValue ?? "ok") }
    XCTAssertEqual(fake.written, Data([1, 2, 3]))
    scheduler.advance(by: 9)
    fake.makeRoom(10)
    XCTAssertEqual(fake.written, Data([1, 2, 3, 4, 5, 6]))
    XCTAssertEqual(results, ["ok", "ok"])

    fake.room = 0
    var closes: [String] = []
    channel.onClose = { closes.append($0?.code.rawValue ?? "none") }
    channel.write(Data([7])) { results.append($0?.code.rawValue ?? "ok") }
    scheduler.advance(by: L2CAPChannel.writeStallTimeout - 0.001)
    XCTAssertTrue(channel.isOpen)
    scheduler.advance(by: 0.001)
    XCTAssertEqual(results.last, "OPERATION_TIMEOUT")
    XCTAssertEqual(closes, ["OPERATION_TIMEOUT"])
    channel.write(Data([8])) { results.append($0?.code.rawValue ?? "ok") }
    XCTAssertEqual(results.last, "OPERATION_TIMEOUT")
  }

  func testAFailedWriteOrStreamIsL2CAPFailed() throws {
    _ = try connect()
    let (channel, fake) = try openChannel()
    fake.failsWrites = true
    var result: String?
    channel.write(Data([1])) { result = $0?.code.rawValue ?? "ok" }
    XCTAssertEqual(result, "L2CAP_FAILED")

    let (other, otherFake) = try openChannel(0x82)
    var closes: [String] = []
    other.onClose = { closes.append($0?.code.rawValue ?? "none") }
    otherFake.end(error: NSError(domain: NSPOSIXErrorDomain, code: 57))
    XCTAssertEqual(closes, ["L2CAP_FAILED"])
  }

  func testChannelsEndWithTheConnection() throws {
    let session = try connect()
    let (channel, fake) = try openChannel()
    var closes: [String] = []
    channel.onClose = { closes.append($0?.code.rawValue ?? "none") }
    let pending = open(0x82)
    session.disconnect {}
    XCTAssertEqual(closes, ["DISCONNECTED"])
    XCTAssertEqual(code(pending()), "DISCONNECTED")
    XCTAssertTrue(fake.closed)
    // The answer to the open that ended with the connection: closed on arrival.
    let late = FakeL2CAPChannel(psm: 0x82)
    peripheral.completeL2CAPOpen(late)
    XCTAssertTrue(late.closed)

    central.simulateDisconnection(of: peripheral, error: nil)
    scheduler.runUntilIdle()
    let again = try connect()
    let (second, _) = try openChannel()
    var secondCloses: [String] = []
    second.onClose = { secondCloses.append($0?.code.rawValue ?? "none") }
    again.forceDisconnected(CoreError(.bluetoothPoweredOff, "Bluetooth is off"))
    XCTAssertEqual(secondCloses, ["BLUETOOTH_POWERED_OFF"])
  }

  // MARK: Servers

  func testPublishesOneAtATimeAndHandsChannelsToTheirServer() throws {
    let manager = FakePeripheralManager()
    let publisher = L2CAPPublisher(manager: manager, scheduler: scheduler)
    var servers: [L2CAPServer] = []
    var failures: [String] = []
    let record: (Result<L2CAPServer, CoreError>) -> Void = { result in
      switch result {
      case let .success(server): servers.append(server)
      case let .failure(error): failures.append(error.code.rawValue)
      }
    }
    publisher.publish(secure: true, completion: record)
    publisher.publish(secure: false, completion: record)
    XCTAssertEqual(manager.publishes, [true])
    manager.didPublish(0x80)
    XCTAssertEqual(manager.publishes, [true, false])
    manager.didPublish(0x81)
    XCTAssertEqual(servers.map(\.psm), [0x80, 0x81])

    var accepted: [L2CAPChannel] = []
    servers[0].onChannel = { accepted.append($0) }
    let centralId = UUID()
    let incoming = FakeL2CAPChannel(psm: 0x80, peer: centralId)
    manager.didOpen(incoming)
    XCTAssertEqual(accepted.map(\.peerId), [centralId.uuidString])
    // No listener on the second server, and no server at all for a third PSM: closed.
    let unwanted = FakeL2CAPChannel(psm: 0x81)
    let stray = FakeL2CAPChannel(psm: 0x99)
    manager.didOpen(unwanted)
    manager.didOpen(stray)
    XCTAssertTrue(unwanted.closed)
    XCTAssertTrue(stray.closed)

    var closes: [String] = []
    accepted[0].onClose = { closes.append($0?.code.rawValue ?? "none") }
    servers[0].close()
    XCTAssertEqual(manager.unpublished, [0x80])
    XCTAssertEqual(closes, ["none"])
    XCTAssertTrue(incoming.closed)
    XCTAssertTrue(failures.isEmpty)
  }

  func testBluetoothOffClosesServersAndFailsPublishes() throws {
    let manager = FakePeripheralManager(state: .unknown)
    let publisher = L2CAPPublisher(manager: manager, scheduler: scheduler)
    var result: Result<L2CAPServer, CoreError>?
    publisher.publish(secure: false) { result = $0 }
    XCTAssertTrue(manager.publishes.isEmpty)
    manager.becomes(.poweredOn)
    XCTAssertEqual(manager.publishes, [false])
    manager.didPublish(0x80)
    let server = try XCTUnwrap(result).get()
    var closes: [String] = []
    server.onChannel = { channel in
      channel.onClose = { error in closes.append(error?.code.rawValue ?? "none") }
    }
    manager.didOpen(FakeL2CAPChannel(psm: 0x80))

    manager.becomes(.poweredOff)
    XCTAssertFalse(server.isOpen)
    XCTAssertEqual(closes, ["BLUETOOTH_POWERED_OFF"])
    XCTAssertTrue(manager.unpublished.isEmpty)
    var pending: Result<L2CAPServer, CoreError>?
    publisher.publish(secure: false) { pending = $0 }
    XCTAssertEqual(code(pending), "BLUETOOTH_POWERED_OFF")
  }

  func testAPublishIOSNeverConfirmsTimesOut() {
    let manager = FakePeripheralManager()
    let publisher = L2CAPPublisher(manager: manager, scheduler: scheduler)
    var result: Result<L2CAPServer, CoreError>?
    publisher.publish(secure: true) { result = $0 }
    scheduler.advance(by: L2CAPPublisher.publishTimeout)
    XCTAssertEqual(code(result), "OPERATION_TIMEOUT")
    // A late confirmation is unpublished.
    manager.didPublish(0x80)
    XCTAssertEqual(manager.unpublished, [0x80])
  }
}
