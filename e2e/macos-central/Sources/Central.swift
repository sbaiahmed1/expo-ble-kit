import CoreBluetooth
import Foundation

/// One pending CoreBluetooth call, used on the central's queue only. A timeout that fires after
/// the call ended can't end a later call on the same slot.
final class Slot<Value>: @unchecked Sendable {
  private var continuation: CheckedContinuation<Value, Error>?
  private var generation = 0

  func begin(_ continuation: CheckedContinuation<Value, Error>) -> Int {
    self.continuation = continuation
    generation += 1
    return generation
  }

  func finish(_ result: Result<Value, Error>, generation: Int? = nil) {
    if let generation, generation != self.generation { return }
    guard let continuation else { return }
    self.continuation = nil
    continuation.resume(with: result)
  }
}

/// A device that may serve the TEST service.
struct Candidate {
  let peripheral: CBPeripheral
  var rssi: Int
  let advertisesTest: Bool
  /// What a TEST-service advertisement carried, for the log (P4-03).
  let advertisement: String?
}

/// The central: finds the server, then runs the checks (Checks.swift). Its state lives on `queue`,
/// where CoreBluetooth calls the delegates (hence `@unchecked Sendable`).
final class Central: NSObject, @unchecked Sendable {
  let profile: Profile
  let streamSeconds: Double
  let queue = DispatchQueue(label: "blekit.central")
  var manager: CBCentralManager?
  var peripheral: CBPeripheral?
  var characteristics: [CBUUID: CBCharacteristic] = [:]
  var candidates: [UUID: Candidate] = [:]
  var handlers: [CBUUID: (Data) -> Void] = [:]
  var passed = 0
  var failed = 0

  let power = Slot<Void>()
  let connection = Slot<Void>()
  let discovery = Slot<Void>()
  let reading = Slot<Data>()
  let writing = Slot<Void>()
  let notifying = Slot<Void>()
  let sending = Slot<Void>()
  let opening = Slot<CBL2CAPChannel>()

  init(profile: Profile, streamSeconds: Double) {
    self.profile = profile
    self.streamSeconds = streamSeconds
  }

  /// Starts a call on the queue and waits for its delegate callback, at most `timeout` seconds.
  func call<Value>(
    _ slot: Slot<Value>,
    _ what: String,
    timeout: Double = 10,
    start: @escaping () throws -> Void
  ) async throws -> Value {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        let generation = slot.begin(continuation)
        do {
          try start()
        } catch {
          return slot.finish(.failure(error))
        }
        self.queue.asyncAfter(deadline: .now() + timeout) {
          slot.finish(.failure(Failure("\(what) timed out after \(Int(timeout)) s")), generation: generation)
        }
      }
    }
  }

  func run() async {
    do {
      try await call(power, "Bluetooth (allow it for BleKitCentral)", timeout: 180) {
        self.manager = CBCentralManager(delegate: self, queue: self.queue)
      }
      for candidate in try await scan() {
        guard await open(candidate) else { continue }
        await runChecks()
        queue.sync { manager?.cancelPeripheralConnection(candidate.peripheral) }
        Log.write("DONE: \(passed) passed, \(failed) failed")
        exit(failed == 0 ? 0 : 1)
      }
      Log.write("FAILED: no device serves the TEST service (is the server open and the app in front?)")
      exit(1)
    } catch {
      Log.write("FAILED: \(error)")
      exit(1)
    }
  }

  /// Devices advertising the TEST service come first (a test peripheral, or a phone once it
  /// advertises), then connectable Apple advertisements by signal: an iPhone serves its apps'
  /// services behind its own advertisement.
  func scan() async throws -> [Candidate] {
    Log.write("scanning 8 s")
    queue.async { self.manager?.scanForPeripherals(withServices: nil, options: nil) }
    try await Task.sleep(nanoseconds: 8_000_000_000)
    return queue.sync {
      manager?.stopScan()
      let sorted = candidates.values.sorted {
        ($0.advertisesTest ? 1 : 0, $0.rssi) > ($1.advertisesTest ? 1 : 0, $1.rssi)
      }
      Log.write("\(sorted.count) candidates")
      for candidate in sorted where candidate.advertisement != nil {
        Log.write("advertises TEST: \(candidate.advertisement ?? "")")
      }
      return Array(sorted.prefix(12))
    }
  }

  /// Connects and looks for the TEST service; false (and disconnected) when it isn't there.
  func open(_ candidate: Candidate) async -> Bool {
    let target = candidate.peripheral
    Log.write("trying \(target.name ?? target.identifier.uuidString) (\(candidate.rssi) dBm)")
    do {
      try await call(connection, "connect", timeout: 6) {
        self.peripheral = target
        target.delegate = self
        self.manager?.connect(target)
      }
      try await call(discovery, "service discovery") { target.discoverServices([self.profile.service]) }
      guard let service = target.services?.first(where: { $0.uuid == profile.service }) else {
        throw Failure("no TEST service")
      }
      try await call(discovery, "characteristic discovery") { target.discoverCharacteristics(nil, for: service) }
      queue.sync {
        for characteristic in service.characteristics ?? [] {
          characteristics[characteristic.uuid] = characteristic
        }
      }
      let limit = target.maximumWriteValueLength(for: .withoutResponse)
      Log.write("found the TEST service: \(characteristics.count) characteristics, MTU \(limit + 3)")
      return true
    } catch {
      Log.write("  \(error)")
      queue.sync { manager?.cancelPeripheralConnection(target) }
      return false
    }
  }

  // MARK: Operations

  func characteristic(_ key: String) throws -> CBCharacteristic {
    guard let characteristic = characteristics[try profile.uuid(key)] else { throw Failure("the server has no \(key)") }
    return characteristic
  }

  func read(_ key: String) async throws -> Data {
    let target = try characteristic(key)
    return try await call(reading, "read \(key)") { self.peripheral?.readValue(for: target) }
  }

  func write(_ key: String, _ value: Data) async throws {
    let target = try characteristic(key)
    try await call(writing, "write \(key)") { self.peripheral?.writeValue(value, for: target, type: .withResponse) }
  }

  /// Waits while CoreBluetooth can't take another write without response.
  func writeWithoutResponse(_ key: String, _ value: Data) async throws {
    let target = try characteristic(key)
    try await call(sending, "ready to send") {
      if self.peripheral?.canSendWriteWithoutResponse == true { self.sending.finish(.success(())) }
    }
    queue.sync { peripheral?.writeValue(value, for: target, type: .withoutResponse) }
  }

  func control(_ name: String, _ parameters: [UInt8] = []) async throws {
    try await write("CONTROL", Data([try profile.opcode(name)] + parameters))
  }

  /// `handler` runs on the central's queue for each notification or indication.
  func subscribe(_ key: String, _ handler: @escaping (Data) -> Void) async throws {
    let target = try characteristic(key)
    queue.sync { handlers[target.uuid] = handler }
    try await call(notifying, "subscribe to \(key)") { self.peripheral?.setNotifyValue(true, for: target) }
  }

  func unsubscribe(_ key: String) async throws {
    let target = try characteristic(key)
    try await call(notifying, "unsubscribe from \(key)") { self.peripheral?.setNotifyValue(false, for: target) }
    queue.sync { handlers[target.uuid] = nil }
  }
}

extension Central: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    switch central.state {
    case .poweredOn: power.finish(.success(()))
    case .unauthorized: power.finish(.failure(Failure("Bluetooth isn't allowed for BleKitCentral (System Settings)")))
    case .poweredOff, .unsupported: power.finish(.failure(Failure("Bluetooth is off or unsupported")))
    default: break
    }
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    let services = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
    let connectable = (advertisementData[CBAdvertisementDataIsConnectable] as? NSNumber)?.boolValue ?? false
    let data = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data
    let apple = data.map { $0.count >= 2 && $0[0] == 0x4C && $0[1] == 0x00 } ?? false
    let advertisesTest = services.contains(profile.service)
    guard advertisesTest || (connectable && apple), RSSI.intValue < 0 else { return }
    let rssi = max(candidates[peripheral.identifier]?.rssi ?? -127, RSSI.intValue)
    let summary = advertisesTest ? describe(advertisementData, rssi: RSSI.intValue) : nil
    candidates[peripheral.identifier] = Candidate(
      peripheral: peripheral,
      rssi: rssi,
      advertisesTest: advertisesTest,
      advertisement: summary ?? candidates[peripheral.identifier]?.advertisement
    )
  }

  /// The fields an advertisement carried (the scan response included, as macOS merges them).
  private func describe(_ data: [String: Any], rssi: Int) -> String {
    let name = data[CBAdvertisementDataLocalNameKey] as? String
    let services = (data[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []).map(\.uuidString)
    let overflow = (data[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID] ?? []).map(\.uuidString)
    let manufacturer = (data[CBAdvertisementDataManufacturerDataKey] as? Data).map(hex)
    let serviceData = (data[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data] ?? [:])
      .map { "\($0.key.uuidString)=\(hex($0.value))" }
    let txPower = data[CBAdvertisementDataTxPowerLevelKey] as? NSNumber
    let connectable = (data[CBAdvertisementDataIsConnectable] as? NSNumber)?.boolValue ?? false
    return [
      "name \(name.map { "'\($0)'" } ?? "none")",
      "services \(services)",
      overflow.isEmpty ? nil : "overflow \(overflow)",
      manufacturer.map { "manufacturer \($0)" },
      serviceData.isEmpty ? nil : "service data \(serviceData)",
      txPower.map { "TX power \($0) dBm" },
      "connectable \(connectable)",
      "\(rssi) dBm"
    ].compactMap { $0 }.joined(separator: ", ")
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    connection.finish(.success(()))
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    connection.finish(.failure(error ?? Failure("connect failed")))
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    guard peripheral == self.peripheral else { return }
    let failure = Failure("disconnected (\(error.map { "\($0)" } ?? "by the Mac"))")
    discovery.finish(.failure(failure))
    reading.finish(.failure(failure))
    writing.finish(.failure(failure))
    notifying.finish(.failure(failure))
    sending.finish(.failure(failure))
    opening.finish(.failure(failure))
  }
}

extension Central: CBPeripheralDelegate {
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    discovery.finish(error.map { .failure($0) } ?? .success(()))
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    discovery.finish(error.map { .failure($0) } ?? .success(()))
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    if error == nil, characteristic.isNotifying, let handler = handlers[characteristic.uuid] {
      return handler(characteristic.value ?? Data())
    }
    reading.finish(error.map { .failure($0) } ?? .success(characteristic.value ?? Data()))
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    writing.finish(error.map { .failure($0) } ?? .success(()))
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    notifying.finish(error.map { .failure($0) } ?? .success(()))
  }

  func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
    sending.finish(.success(()))
  }

  func peripheral(_ peripheral: CBPeripheral, didOpen channel: CBL2CAPChannel?, error: Error?) {
    if let channel, error == nil {
      opening.finish(.success(channel))
    } else {
      opening.finish(.failure(error ?? Failure("no L2CAP channel")))
    }
  }
}
