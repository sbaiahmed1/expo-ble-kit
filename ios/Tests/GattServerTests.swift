import CoreBluetooth
import XCTest
@testable import BleKitCore

/// test-contracts/gatt-server-reads.json
private struct ReadContract: Decodable {
  let cases: [ReadContractCase]
}

private struct ReadContractCase: Decodable {
  let name: String
  let steps: [ReadContractStep]
}

private struct ReadContractRead: Decodable {
  let central: String
  let characteristic: String
  let offset: Int
}

private struct ReadContractExpect: Decodable {
  let handler: Int?
  let response: String
}

private struct ReadContractStep: Decodable {
  let read: ReadContractRead?
  let handlerValue: String?
  let expect: ReadContractExpect?
  let advance: Double?
  let disconnect: String?
}

private struct WriteSeen {
  let id: Int
  let value: Data
}

/// P4-01: the GATT server core with a fake peripheral manager; long reads run the shared contract.
final class GattServerTests: XCTestCase, GattServerListener {
  private let dynamic = CBUUID(string: "0c6c2001-b347-4cfa-9827-1c5a13658519")
  private let other = CBUUID(string: "0c6c2002-b347-4cfa-9827-1c5a13658519")
  private let notifying = CBUUID(string: "0c6c2003-b347-4cfa-9827-1c5a13658519")
  private let central = UUID()
  private var scheduler: TestScheduler!
  private var manager: FakePeripheralManager!
  private var server: GattServer!
  private var reads: [(id: Int, offset: Int)] = []
  private var writes: [WriteSeen] = []
  private var subscriptions: [String] = []
  private var warnings: [CoreError.Code] = []
  /// Answers reads at once with this value, when set.
  private var autoAnswer: Data?

  override func setUp() {
    super.setUp()
    scheduler = TestScheduler()
    manager = FakePeripheralManager()
    server = makeServer()
  }

  private func makeServer() -> GattServer {
    let properties: CBCharacteristicProperties = [.read, .write]
    let permissions: CBAttributePermissions = [.readable, .writeable]
    let characteristics = [dynamic, other].map {
      ServerCharacteristicSpec(uuid: $0, properties: properties, permissions: permissions, value: nil, descriptors: [])
    } + [ServerCharacteristicSpec(uuid: notifying, properties: .notify, permissions: [], value: nil, descriptors: [])]
    let service = ServerServiceSpec(uuid: CBUUID(string: "0c6c2000-b347-4cfa-9827-1c5a13658519"), primary: true,
                                    characteristics: characteristics)
    let server = GattServer(services: [service], manager: manager, scheduler: scheduler)
    server.listener = self
    return server
  }

  private func open() {
    var result: CoreError? = CoreError(.internal, "pending")
    server.open { result = $0 }
    XCTAssertNil(result)
  }

  func gattServer(_ server: GattServer, readRequest id: Int, central: UUID, characteristic: CBUUID, offset: Int) {
    reads.append((id, offset))
    if let autoAnswer { server.respondToRead(requestId: id, value: autoAnswer, attError: nil) }
  }

  // swiftlint:disable:next function_parameter_count
  func gattServer(
    _ server: GattServer,
    writeRequest id: Int,
    central: UUID,
    characteristic: CBUUID,
    offset: Int,
    value: Data,
    withResponse: Bool
  ) {
    writes.append(WriteSeen(id: id, value: value))
  }

  func gattServer(_ server: GattServer, central: UUID, characteristic: CBUUID, subscribed: Bool) {
    subscriptions.append(subscribed ? "on" : "off")
  }

  func gattServer(_ server: GattServer, warning: CoreError) {
    warnings.append(warning.code)
  }

  private func hex(_ data: Data?) -> String? {
    data.map { $0.map { String(format: "%02x", $0) }.joined() }
  }

  private func bytes(_ hex: String) -> Data {
    Data(stride(from: 0, to: hex.count, by: 2).map {
      UInt8(hex[hex.index(hex.startIndex, offsetBy: $0)..<hex.index(hex.startIndex, offsetBy: $0 + 2)], radix: 16)!
    })
  }

  func testSharedLongReadContract() throws {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../test-contracts/gatt-server-reads.json")
    let contract = try JSONDecoder().decode(ReadContract.self, from: Data(contentsOf: url))
    for contractCase in contract.cases {
      setUp()
      open()
      let centrals = ["A": UUID(), "B": UUID()]
      for (index, step) in contractCase.steps.enumerated() {
        let label = "\(contractCase.name), step \(index + 1)"
        if let seconds = step.advance {
          scheduler.advance(by: seconds / 1000)
        } else if let gone = step.disconnect {
          server.readCache.drop(central: centrals[gone]!)
        } else if let read = step.read, let expect = step.expect {
          reads = []
          autoAnswer = bytes(step.handlerValue ?? "")
          let request = FakeATTRequest(central: centrals[read.central]!,
                                       characteristic: read.characteristic == "c1" ? dynamic : other,
                                       offset: read.offset)
          server.peripheralManager(manager, didReceiveRead: request)
          XCTAssertEqual(reads.first?.offset, expect.handler, label)
          let answer = try XCTUnwrap(manager.answers.last, label)
          if expect.response == "INVALID_OFFSET" {
            XCTAssertEqual(answer.result, .invalidOffset, label)
          } else {
            XCTAssertEqual(answer.result, .success, label)
            XCTAssertEqual(hex(answer.request.value), expect.response, label)
          }
        }
      }
    }
  }

  func testA512ByteValueReadAtMtu23IsOneSnapshot() {
    open()
    var value = Data((0..<512).map { UInt8($0 & 0xFF) })
    var received = Data()
    var offset = 0
    while true {
      let request = FakeATTRequest(central: central, characteristic: dynamic, offset: offset)
      server.peripheralManager(manager, didReceiveRead: request)
      if let read = reads.last, read.offset == 0, offset == 0 {
        server.respondToRead(requestId: read.id, value: value, attError: nil)
      }
      value = Data((0..<512).map { UInt8(($0 + offset + 1) & 0xFF) })
      let part = (request.value ?? Data()).prefix(22)
      received.append(part)
      if part.count < 22 { break }
      offset += part.count
    }
    XCTAssertEqual(reads.count, 1, "the handler is asked once per sequence")
    XCTAssertEqual(received, Data((0..<512).map { UInt8($0 & 0xFF) }))
  }

  func testARequestArrayIsOneWritePerCharacteristic() {
    open()
    let parts = [
      FakeATTRequest(central: central, characteristic: dynamic, offset: 0, value: Data(repeating: 1, count: 18)),
      FakeATTRequest(central: central, characteristic: dynamic, offset: 18, value: Data(repeating: 2, count: 18)),
      FakeATTRequest(central: central, characteristic: other, offset: 0, value: Data([7]))
    ]
    server.peripheralManager(manager, didReceiveWrite: parts)
    XCTAssertEqual(writes.map { $0.value.count }, [36, 1])
    XCTAssertEqual(writes[0].value, Data(repeating: 1, count: 18) + Data(repeating: 2, count: 18))
    server.respondToWrite(requestId: writes[0].id, attError: nil)
    XCTAssertTrue(manager.answers.isEmpty, "waits for every characteristic")
    server.respondToWrite(requestId: writes[1].id, attError: 3)
    XCTAssertTrue(manager.answers.last?.request === parts[0], "answered through the first request")
    XCTAssertEqual(manager.answers.last?.result, .writeNotPermitted)

    let gap = FakeATTRequest(central: central, characteristic: dynamic, offset: 600, value: Data([1]))
    server.peripheralManager(manager, didReceiveWrite: [gap])
    XCTAssertEqual(manager.answers.last?.result, .invalidOffset)
  }

  func testAnUnansweredRequestGetsAnAttErrorAtTheDeadline() {
    open()
    let request = FakeATTRequest(central: central, characteristic: dynamic, offset: 0)
    server.peripheralManager(manager, didReceiveRead: request)
    scheduler.advance(by: GattServer.responseDeadline - 0.001)
    XCTAssertTrue(manager.answers.isEmpty)
    scheduler.advance(by: 0.001)
    XCTAssertEqual(manager.answers.map { $0.result }, [.unlikelyError])
    XCTAssertEqual(warnings, [.operationTimeout])
    server.respondToRead(requestId: reads[0].id, value: Data([1]), attError: nil)
    XCTAssertEqual(manager.answers.count, 1, "a late answer is ignored")
  }

  func testSubscriptionsComeFromIOS() {
    open()
    server.peripheralManager(manager, central: central, didSubscribeTo: dynamic)
    server.peripheralManager(manager, central: central, didSubscribeTo: dynamic)
    XCTAssertEqual(server.subscribedCentrals(dynamic), [central])
    server.peripheralManager(manager, central: central, didUnsubscribeFrom: dynamic)
    XCTAssertEqual(subscriptions, ["on", "off"])
  }

  func testOpenWaitsForTheManagerAndReportsItsState() {
    manager = FakePeripheralManager(state: .unknown)
    server = makeServer()
    var result: CoreError?
    var done = false
    server.open { result = $0; done = true }
    XCTAssertFalse(done)
    manager.becomes(.poweredOff)
    XCTAssertEqual(result?.code, .bluetoothPoweredOff)

    manager = FakePeripheralManager()
    manager.confirmsAdds = false
    server = makeServer()
    server.open { result = $0 }
    scheduler.advance(by: GattServer.addServiceTimeout)
    XCTAssertEqual(result?.code, .operationTimeout)
    XCTAssertTrue(manager.removedAll)
  }

  private func notify(_ count: Int, to centrals: [UUID]? = nil, on characteristic: CBUUID? = nil) -> () -> String {
    var result = "pending"
    server.notify(characteristic ?? notifying, value: Data(count: count), centrals: centrals) {
      result = $0?.code.rawValue ?? "ok"
    }
    return { result }
  }

  func testNotificationsGoToSubscribersAndWaitWhenTheQueueIsFull() {
    open()
    let other = UUID()
    server.peripheralManager(manager, central: central, didSubscribeTo: notifying)
    server.peripheralManager(manager, central: other, didSubscribeTo: notifying)
    XCTAssertEqual(notify(20)(), "ok")
    XCTAssertEqual(Set(manager.updates.last?.centrals ?? []), [central, other])
    XCTAssertEqual(notify(1, to: [other, UUID()])(), "ok")
    XCTAssertEqual(manager.updates.last?.centrals, [other])

    manager.queueHasRoom = false
    let waiting = notify(5)
    let behind = notify(6)
    XCTAssertEqual(waiting(), "pending")
    manager.queueHasRoom = true
    server.peripheralManagerIsReady(toUpdateSubscribers: manager)
    XCTAssertEqual([waiting(), behind()], ["ok", "ok"])
    XCTAssertEqual(manager.updates.suffix(2).map { $0.count }, [5, 6], "in order")
  }

  func testNotificationLimitsTimeoutsAndErrors() {
    open()
    server.peripheralManager(manager, central: central, didSubscribeTo: notifying)
    XCTAssertEqual(notify(21)(), "INVALID_ATTRIBUTE_LENGTH", "20 bytes before the MTU is known")
    manager.maximumUpdateValueLengths[central] = 182
    XCTAssertEqual(notify(182)(), "ok")
    XCTAssertEqual(notify(1, on: dynamic)(), "NOT_SUPPORTED")
    XCTAssertEqual(notify(1, on: CBUUID(string: "1234"))(), "CHARACTERISTIC_NOT_FOUND")
    XCTAssertEqual(notify(1, to: [UUID()])(), "ok", "nobody to send to")

    manager.queueHasRoom = false
    let stuck = notify(1)
    let next = notify(2)
    scheduler.advance(by: ServerNotifier.timeout)
    XCTAssertEqual(stuck(), "OPERATION_TIMEOUT")
    XCTAssertEqual(next(), "pending", "waits for the queue in turn")
    server.close()
    XCTAssertEqual(next(), "DISCONNECTED")
    XCTAssertEqual(notify(1)(), "DISCONNECTED")
  }
}
