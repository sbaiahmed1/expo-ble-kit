import CoreBluetooth
import Foundation

/// The test peripheral (test-peripherals/profile.json).
private enum Profile {
  static let test = CBUUID(string: "0c6c1000-b347-4cfa-9827-1c5a13658519")
  static let echoWrite = CBUUID(string: "0c6c1003-b347-4cfa-9827-1c5a13658519")
  static let sink = CBUUID(string: "0c6c1005-b347-4cfa-9827-1c5a13658519")
  static let sinkCounter = CBUUID(string: "0c6c1006-b347-4cfa-9827-1c5a13658519")
  static let stream = CBUUID(string: "0c6c1007-b347-4cfa-9827-1c5a13658519")
  static let control = CBUUID(string: "0c6c100b-b347-4cfa-9827-1c5a13658519")
  static let resetCounters = Data([0x04])

  static func setStream(rateHz: Int, frameSize: Int) -> Data {
    Data([0x01, UInt8(rateHz & 0xFF), UInt8(rateHz >> 8), UInt8(frameSize & 0xFF), UInt8(frameSize >> 8)])
  }
}

/// One measured transfer, in the same shape as the example's Throughput screen (docs/benchmarks.md).
struct TransferResult: CustomStringConvertible {
  let name: String
  let bytes: Int
  let seconds: Double
  let note: String

  var kilobytesPerSecond: Double { Double(bytes) / 1024 / seconds }

  var description: String {
    String(format: "%@: %d B in %.2f s = %.1f KB/s (%@)", name, bytes, seconds, kilobytesPerSecond, note)
  }
}

struct BenchmarkError: LocalizedError {
  let errorDescription: String?

  init(_ message: String) {
    errorDescription = message
  }
}

/// The three transfers of docs/benchmarks.md with CoreBluetooth and nothing else: writes without
/// response (1 MiB to SINK_NO_RSP, paced by `canSendWriteWithoutResponse`), writes with response
/// (256 KiB to ECHO_WRITE), and notifications (STREAM at 1000 Hz for 10 s). Everything runs on the
/// main queue; one awaited callback at a time.
@MainActor
final class Benchmark: NSObject {
  private enum Event {
    case poweredOn, found, connected, services, characteristics, wrote, notifying, read, readyToSend
  }

  private let log: (String) -> Void
  private var central: CBCentralManager?
  private var peripheral: CBPeripheral?
  private var characteristics: [CBUUID: CBCharacteristic] = [:]
  /// The one callback awaited now; `token` tells a stale timeout from the current wait.
  private struct Waiter {
    let event: Event
    let token: Int
    let continuation: CheckedContinuation<Data?, Error>
  }

  private var waiting: Waiter?
  private var token = 0
  private var notified = 0
  private var frames = 0
  private var gaps = 0
  private var expected: UInt32 = 0

  init(log: @escaping (String) -> Void) {
    self.log = log
  }

  func runAll() async throws -> [TransferResult] {
    let peripheral = try await connect()
    defer { central?.cancelPeripheralConnection(peripheral) }
    var results: [TransferResult] = []
    for transfer in [writeWithoutResponse, writeWithResponse, notifications] {
      let result = try await transfer()
      log("RESULT \(result)")
      results.append(result)
    }
    return results
  }

  private func connect() async throws -> CBPeripheral {
    let central = CBCentralManager(delegate: self, queue: .main)
    self.central = central
    if central.state != .poweredOn {
      try await wait(.poweredOn)
    }
    central.scanForPeripherals(withServices: [Profile.test])
    try await wait(.found)
    central.stopScan()
    guard let peripheral else {
      throw BenchmarkError("No test peripheral found")
    }
    log("Connecting to \(peripheral.identifier.uuidString)")
    central.connect(peripheral)
    try await wait(.connected, seconds: 15)
    peripheral.discoverServices([Profile.test])
    try await wait(.services, seconds: 30)
    guard let service = peripheral.services?.first(where: { $0.uuid == Profile.test }) else {
      throw BenchmarkError("No TEST service")
    }
    peripheral.discoverCharacteristics(nil, for: service)
    try await wait(.characteristics, seconds: 30)
    for characteristic in service.characteristics ?? [] {
      characteristics[characteristic.uuid] = characteristic
    }
    log("Connected, MTU \(packetSize + 3)")
    return peripheral
  }

  private var packetSize: Int { peripheral?.maximumWriteValueLength(for: .withoutResponse) ?? 20 }

  private func characteristic(_ uuid: CBUUID) throws -> CBCharacteristic {
    guard let found = characteristics[uuid] else {
      throw BenchmarkError("Missing characteristic \(uuid)")
    }
    return found
  }

  private func writeWithResponse(_ value: Data, to uuid: CBUUID) async throws {
    peripheral?.writeValue(value, for: try characteristic(uuid), type: .withResponse)
    try await wait(.wrote)
  }

  private func readCounter() async throws -> Int {
    peripheral?.readValue(for: try characteristic(Profile.sinkCounter))
    let value = try await wait(.read) ?? Data()
    return value.prefix(4).enumerated().reduce(0) { $0 | Int($1.element) << (8 * $1.offset) }
  }

  private func payload(from offset: Int, count: Int) -> Data {
    Data((0..<count).map { UInt8((offset + $0) % 256) })
  }

  private func now() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds) / 1e9
  }

  private func writeWithoutResponse() async throws -> TransferResult {
    let total = 1 << 20
    try await writeWithResponse(Profile.resetCounters, to: Profile.control)
    let sink = try characteristic(Profile.sink)
    let packet = packetSize
    let started = now()
    var sent = 0
    while sent < total {
      if peripheral?.canSendWriteWithoutResponse == false {
        try await wait(.readyToSend)
      }
      let count = min(packet, total - sent)
      peripheral?.writeValue(payload(from: sent, count: count), for: sink, type: .withoutResponse)
      sent += count
    }
    let seconds = now() - started
    var counted = try await readCounter()
    for _ in 0..<10 where counted < total {
      try await Task.sleep(nanoseconds: 200_000_000)
      counted = try await readCounter()
    }
    let note = "\(packet)-byte packets, peripheral counted \(counted)"
    return TransferResult(name: "writeWithoutResponse", bytes: total, seconds: seconds, note: note)
  }

  private func writeWithResponse() async throws -> TransferResult {
    let total = 256 << 10
    let packet = packetSize
    let started = now()
    var sent = 0
    while sent < total {
      let count = min(packet, total - sent)
      try await writeWithResponse(payload(from: sent, count: count), to: Profile.echoWrite)
      sent += count
    }
    let seconds = now() - started
    return TransferResult(name: "writeWithResponse", bytes: total, seconds: seconds, note: "\(packet)-byte packets")
  }

  private func notifications() async throws -> TransferResult {
    peripheral?.setNotifyValue(true, for: try characteristic(Profile.stream))
    try await wait(.notifying)
    try await writeWithResponse(Profile.resetCounters, to: Profile.control)
    let frameSize = min(packetSize, 512)
    (notified, frames, gaps, expected) = (0, 0, 0, 0)
    let started = now()
    try await writeWithResponse(Profile.setStream(rateHz: 1000, frameSize: frameSize), to: Profile.control)
    try await Task.sleep(nanoseconds: 10_000_000_000)
    let bytes = notified
    let seconds = now() - started
    try await writeWithResponse(Profile.setStream(rateHz: 0, frameSize: frameSize), to: Profile.control)
    let note = "\(frames) frames of \(frameSize) B, \(gaps) gaps"
    return TransferResult(name: "notifications", bytes: bytes, seconds: seconds, note: note)
  }

  /// Frames start with their uint32 LE sequence number (profile.json stream.frame).
  private func count(frame: Data) {
    guard frame.count >= 4 else {
      return
    }
    let sequence = frame.prefix(4).enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * $1.offset) }
    if sequence > expected {
      gaps += Int(sequence - expected)
    }
    expected = sequence &+ 1
    frames += 1
    notified += frame.count
  }

  @discardableResult
  private func wait(_ event: Event, seconds: Double = 10) async throws -> Data? {
    token += 1
    let mine = token
    return try await withCheckedThrowingContinuation { continuation in
      waiting = Waiter(event: event, token: mine, continuation: continuation)
      DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
        guard let self, let pending = waiting, pending.token == mine else {
          return
        }
        waiting = nil
        pending.continuation.resume(throwing: BenchmarkError("Timed out waiting for \(event)"))
      }
    }
  }

  private func signal(_ event: Event, _ value: Data? = nil, error: Error? = nil) {
    guard let pending = waiting, pending.event == event else {
      return
    }
    waiting = nil
    if let error {
      pending.continuation.resume(throwing: error)
    } else {
      pending.continuation.resume(returning: value)
    }
  }
}

// CoreBluetooth calls these on the main queue (the manager was created with `queue: .main`).

extension Benchmark: CBCentralManagerDelegate, CBPeripheralDelegate {
  nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
    MainActor.assumeIsolated {
      if central.state == .poweredOn {
        signal(.poweredOn)
      }
    }
  }

  nonisolated func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    MainActor.assumeIsolated {
      if self.peripheral == nil {
        self.peripheral = peripheral
        peripheral.delegate = self
        signal(.found)
      }
    }
  }

  nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    MainActor.assumeIsolated { signal(.connected) }
  }

  nonisolated func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    MainActor.assumeIsolated { signal(.connected, error: error ?? BenchmarkError("Connect failed")) }
  }

  nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    MainActor.assumeIsolated { signal(.services, error: error) }
  }

  nonisolated func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    MainActor.assumeIsolated { signal(.characteristics, error: error) }
  }

  nonisolated func peripheral(
    _ peripheral: CBPeripheral,
    didWriteValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    MainActor.assumeIsolated { signal(.wrote, error: error) }
  }

  nonisolated func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    MainActor.assumeIsolated { signal(.notifying, error: error) }
  }

  nonisolated func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    let value = characteristic.value ?? Data()
    let isStream = characteristic.uuid == Profile.stream
    MainActor.assumeIsolated {
      if isStream {
        count(frame: value)
      } else {
        signal(.read, value, error: error)
      }
    }
  }

  nonisolated func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
    MainActor.assumeIsolated { signal(.readyToSend) }
  }
}
