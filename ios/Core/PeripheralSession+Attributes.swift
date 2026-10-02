import CoreBluetooth
import Foundation

// Reads, writes and descriptors (P1-07), through the session's queue (Appendix B rule 2).

/// Where an attribute operation goes: lowercase 128-bit UUIDs, as the TS layer normalizes them.
struct AttributePath {
  let service: String
  let characteristic: String
  var descriptor: String?
}

extension PeripheralSession {
  typealias ValueCompletion = (Result<Data, CoreError>) -> Void
  typealias WriteCompletion = (Result<Void, CoreError>) -> Void

  /// The ATT maximum for an attribute value.
  static let maxAttributeLength = 512
  static let cccd = CBUUID(string: "2902")

  /// Reads a characteristic. Long values are read in full by CoreBluetooth.
  func read(_ path: AttributePath, timeout: TimeInterval?, completion: @escaping ValueCompletion) {
    let target: CharacteristicLike
    do {
      target = try findCharacteristic(path, allowing: .read, otherwise: .readNotPermitted)
    } catch {
      return completion(.failure(Self.coreError(error)))
    }
    queue.enqueue(.read, target: Self.key(target), timeout: timeout) { [weak self] in
      self?.peripheral.readValue(for: target)
    } completion: { result in
      completion(result.map(Self.data))
    }
  }

  /// Writes a characteristic: with response up to 512 bytes (long writes by CoreBluetooth), without
  /// response one packet (`maximumWriteValueLength(for: .withoutResponse)`).
  func write(
    _ path: AttributePath,
    value: Data,
    withResponse: Bool,
    timeout: TimeInterval?,
    completion: @escaping WriteCompletion
  ) {
    let target: CharacteristicLike
    do {
      target = try findCharacteristic(
        path,
        allowing: withResponse ? .write : .writeWithoutResponse,
        otherwise: .writeNotPermitted
      )
      let max = withResponse
        ? Self.maxAttributeLength
        : peripheral.maximumWriteValueLength(for: .withoutResponse)
      try Self.checkLength(value, max: max)
    } catch {
      return completion(.failure(Self.coreError(error)))
    }
    let kind: GattOperation.Kind = withResponse ? .write : .writeWithoutResponse
    queue.enqueue(kind, target: Self.key(target), timeout: timeout) { [weak self] in
      self?.startWrite(value, to: target, withResponse: withResponse)
    } completion: { result in
      completion(result.map { _ in () })
    }
  }

  func readDescriptor(_ path: AttributePath, timeout: TimeInterval?, completion: @escaping ValueCompletion) {
    let target: DescriptorLike
    do {
      target = try findDescriptor(path)
    } catch {
      return completion(.failure(Self.coreError(error)))
    }
    queue.enqueue(.readDescriptor, target: Self.key(target), timeout: timeout) { [weak self] in
      self?.peripheral.readValue(for: target)
    } completion: { result in
      completion(result.map(Self.data))
    }
  }

  /// The CCCD is off limits: subscriptions own it (P1-08), and CoreBluetooth throws if it is written.
  func writeDescriptor(
    _ path: AttributePath,
    value: Data,
    timeout: TimeInterval?,
    completion: @escaping WriteCompletion
  ) {
    let target: DescriptorLike
    do {
      if let descriptor = path.descriptor, CBUUID(string: descriptor) == Self.cccd {
        throw CoreError(
          .invalidArgument,
          "The Client Characteristic Configuration descriptor (0x2902) is managed by subscribe()"
        )
      }
      try Self.checkLength(value, max: Self.maxAttributeLength)
      target = try findDescriptor(path)
    } catch {
      return completion(.failure(Self.coreError(error)))
    }
    queue.enqueue(.writeDescriptor, target: Self.key(target), timeout: timeout) { [weak self] in
      self?.peripheral.writeValue(value, for: target)
    } completion: { result in
      completion(result.map { _ in () })
    }
  }

  // MARK: PeripheralLikeDelegate (attributes)

  func peripheral(
    _ peripheral: PeripheralLike,
    didUpdateValue value: Data?,
    for characteristic: CharacteristicLike,
    error: Error?
  ) {
    // CoreBluetooth reports reads and notifications the same way: an update for a characteristic with
    // a read in flight answers the read; any other update is a notification or indication.
    let key = Self.key(characteristic)
    if queue.current?.kind == .read, queue.current?.target == key {
      complete(.read, key, error, output: .value(value))
    } else if error == nil, let value {
      deliverNotification(value, from: characteristic)
    }
  }

  func peripheral(_ peripheral: PeripheralLike, didWriteValueFor characteristic: CharacteristicLike, error: Error?) {
    complete(.write, Self.key(characteristic), error, output: .none)
  }

  func peripheral(
    _ peripheral: PeripheralLike,
    didUpdateValue value: Data?,
    forDescriptor descriptor: DescriptorLike,
    error: Error?
  ) {
    complete(.readDescriptor, Self.key(descriptor), error, output: .value(value))
  }

  func peripheral(_ peripheral: PeripheralLike, didWriteValueForDescriptor descriptor: DescriptorLike, error: Error?) {
    complete(.writeDescriptor, Self.key(descriptor), error, output: .none)
  }

  func peripheralIsReadyToSendWriteWithoutResponse(_ peripheral: PeripheralLike) {
    let pending = pendingWriteWithoutResponse
    pendingWriteWithoutResponse = nil
    pending?()
  }

  // MARK: Helpers

  func complete(_ kind: GattOperation.Kind, _ target: String, _ error: Error?, output: GattOperation.Output) {
    let result: Result<GattOperation.Output, CoreError> = error
      .map { .failure(CoreBluetoothErrorMapping.coreError(from: $0)) } ?? .success(output)
    _ = queue.complete(result) { $0.kind == kind && $0.target == target }
  }

  /// A write without response has no callback: it is done once CoreBluetooth takes it, which may
  /// mean waiting until it can send.
  private func startWrite(_ value: Data, to characteristic: CharacteristicLike, withResponse: Bool) {
    guard !withResponse else {
      return peripheral.writeValue(value, for: characteristic, type: .withResponse)
    }
    let key = Self.key(characteristic)
    let send = { [weak self] in
      guard let self else {
        return
      }
      peripheral.writeValue(value, for: characteristic, type: .withoutResponse)
      _ = queue.complete(.success(.none)) { $0.kind == .writeWithoutResponse && $0.target == key }
    }
    if peripheral.canSendWriteWithoutResponse {
      send()
    } else {
      pendingWriteWithoutResponse = send
    }
  }

  /// The first discovered instance of `characteristic` in `service`, if it allows `property`.
  /// The first discovered instance of the characteristic, if it allows `property`.
  private func findCharacteristic(
    _ path: AttributePath,
    allowing property: CBCharacteristicProperties,
    otherwise notPermitted: CoreError.Code
  ) throws -> CharacteristicLike {
    let target = try characteristic(at: path)
    guard !target.properties.isDisjoint(with: property) else {
      throw CoreError(notPermitted, "Characteristic \(path.characteristic) doesn't allow this")
    }
    return target
  }

  private func characteristic(at path: AttributePath) throws -> CharacteristicLike {
    guard state == .ready else {
      throw CoreError(.disconnected, "Not connected")
    }
    let serviceUUID = CBUUID(string: path.service)
    let characteristicUUID = CBUUID(string: path.characteristic)
    guard let found = peripheral.serviceList.first(where: { $0.uuid == serviceUUID }) else {
      throw CoreError(.serviceNotFound, "Service \(path.service) not found; discover() it first")
    }
    guard let target = found.characteristicList.first(where: { $0.uuid == characteristicUUID }) else {
      throw CoreError(.characteristicNotFound, "Characteristic \(path.characteristic) not found in \(path.service)")
    }
    return target
  }

  private func findDescriptor(_ path: AttributePath) throws -> DescriptorLike {
    guard let descriptor = path.descriptor else {
      throw CoreError(.invalidArgument, "No descriptor given")
    }
    let owner = try characteristic(at: path)
    let descriptorUUID = CBUUID(string: descriptor)
    guard let target = owner.descriptorList.first(where: { $0.uuid == descriptorUUID }) else {
      throw CoreError(.descriptorNotFound, "Descriptor \(descriptor) not found on \(path.characteristic)")
    }
    return target
  }

  private static func checkLength(_ value: Data, max: Int) throws {
    if value.count > max {
      throw CoreError(.invalidAttributeLength, "\(value.count) bytes is more than the \(max) allowed here")
    }
  }

  /// Callbacks are matched by attribute object, which also tells apart two instances of one UUID.
  static func key(_ attribute: AnyObject) -> String {
    String(describing: ObjectIdentifier(attribute))
  }

  private static func data(_ output: GattOperation.Output) -> Data {
    if case let .value(data) = output {
      return data ?? Data()
    }
    return Data()
  }

  static func coreError(_ error: Error) -> CoreError {
    error as? CoreError ?? CoreError(.internal, error.localizedDescription)
  }
}
