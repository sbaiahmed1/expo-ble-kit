import CoreBluetooth
import Foundation
@testable import BleKitCore

/// Scriptable `PeripheralLike`. Every call is recorded in `calls`. With `respondsAutomatically`,
/// operations complete immediately; otherwise the test completes them with the `complete…` helpers,
/// which lets it hold an operation in flight.
final class FakePeripheral: PeripheralLike {
  enum Call: Equatable {
    case discoverServices([CBUUID]?)
    case discoverCharacteristics([CBUUID]?, service: CBUUID)
    case discoverDescriptors(characteristic: CBUUID)
    case read(CBUUID)
    case write(CBUUID, Data, withResponse: Bool)
    case readDescriptor(CBUUID)
    case writeDescriptor(CBUUID, Data)
    case setNotify(Bool, CBUUID)
    case readRSSI
  }

  let identifier: UUID
  var name: String?
  var state: CBPeripheralState = .disconnected
  /// The peripheral's GATT database. `serviceList` only shows what discovery returned.
  var services: [FakeService]
  var discoveredServices: [FakeService] = []
  var canSendWriteWithoutResponse = true
  var maximumWriteLength: [CBCharacteristicWriteType: Int] = [.withResponse: 512, .withoutResponse: 20]
  var rssi = -60
  var respondsAutomatically = false
  weak var delegate: PeripheralLikeDelegate?
  private(set) var calls: [Call] = []

  init(identifier: UUID = UUID(), name: String? = nil, services: [FakeService] = []) {
    self.identifier = identifier
    self.name = name
    self.services = services
  }

  var serviceList: [ServiceLike] { discoveredServices }

  func maximumWriteValueLength(for type: CBCharacteristicWriteType) -> Int {
    maximumWriteLength[type] ?? 20
  }

  // MARK: PeripheralLike

  func discoverServices(_ serviceUUIDs: [CBUUID]?) {
    calls.append(.discoverServices(serviceUUIDs))
    if respondsAutomatically { completeServiceDiscovery(serviceUUIDs) }
  }

  func discoverCharacteristics(_ characteristicUUIDs: [CBUUID]?, for service: ServiceLike) {
    calls.append(.discoverCharacteristics(characteristicUUIDs, service: service.uuid))
    if respondsAutomatically { completeCharacteristicDiscovery(characteristicUUIDs, for: fake(service)) }
  }

  func discoverDescriptors(for characteristic: CharacteristicLike) {
    calls.append(.discoverDescriptors(characteristic: characteristic.uuid))
    if respondsAutomatically { completeDescriptorDiscovery(for: fake(characteristic)) }
  }

  func readValue(for characteristic: CharacteristicLike) {
    calls.append(.read(characteristic.uuid))
    if respondsAutomatically { completeRead(fake(characteristic)) }
  }

  func writeValue(_ data: Data, for characteristic: CharacteristicLike, type: CBCharacteristicWriteType) {
    calls.append(.write(characteristic.uuid, data, withResponse: type == .withResponse))
    fake(characteristic).value = data
    if respondsAutomatically, type == .withResponse { completeWrite(fake(characteristic)) }
  }

  func readValue(for descriptor: DescriptorLike) {
    calls.append(.readDescriptor(descriptor.uuid))
    if respondsAutomatically { completeDescriptorRead(fake(descriptor)) }
  }

  func writeValue(_ data: Data, for descriptor: DescriptorLike) {
    calls.append(.writeDescriptor(descriptor.uuid, data))
    fake(descriptor).value = data
    if respondsAutomatically { completeDescriptorWrite(fake(descriptor)) }
  }

  func setNotifyValue(_ enabled: Bool, for characteristic: CharacteristicLike) {
    calls.append(.setNotify(enabled, characteristic.uuid))
    if respondsAutomatically { completeSetNotify(enabled, for: fake(characteristic)) }
  }

  func readRSSI() {
    calls.append(.readRSSI)
    if respondsAutomatically { delegate?.peripheral(self, didReadRSSI: rssi, error: nil) }
  }

  // MARK: Test drivers

  func completeServiceDiscovery(_ serviceUUIDs: [CBUUID]? = nil, error: Error? = nil) {
    if error == nil {
      discoveredServices = services.filter { serviceUUIDs?.contains($0.uuid) ?? true }
    }
    delegate?.peripheralDidDiscoverServices(self, error: error)
  }

  func completeCharacteristicDiscovery(_ uuids: [CBUUID]? = nil, for service: FakeService, error: Error? = nil) {
    if error == nil {
      service.discoveredCharacteristics = service.characteristics.filter { uuids?.contains($0.uuid) ?? true }
    }
    delegate?.peripheral(self, didDiscoverCharacteristicsFor: service, error: error)
  }

  func completeDescriptorDiscovery(for characteristic: FakeCharacteristic, error: Error? = nil) {
    if error == nil {
      characteristic.discoveredDescriptors = characteristic.descriptors
    }
    delegate?.peripheral(self, didDiscoverDescriptorsFor: characteristic, error: error)
  }

  func completeRead(_ characteristic: FakeCharacteristic, error: Error? = nil) {
    delegate?.peripheral(
      self,
      didUpdateValue: error == nil ? characteristic.value : nil,
      for: characteristic,
      error: error
    )
  }

  func completeWrite(_ characteristic: FakeCharacteristic, error: Error? = nil) {
    delegate?.peripheral(self, didWriteValueFor: characteristic, error: error)
  }

  func completeDescriptorRead(_ descriptor: FakeDescriptor, error: Error? = nil) {
    delegate?.peripheral(
      self,
      didUpdateValue: error == nil ? descriptor.value : nil,
      forDescriptor: descriptor,
      error: error
    )
  }

  func completeDescriptorWrite(_ descriptor: FakeDescriptor, error: Error? = nil) {
    delegate?.peripheral(self, didWriteValueForDescriptor: descriptor, error: error)
  }

  func completeSetNotify(_ enabled: Bool, for characteristic: FakeCharacteristic, error: Error? = nil) {
    if error == nil {
      characteristic.isNotifying = enabled
    }
    delegate?.peripheral(self, didUpdateNotificationStateFor: characteristic, error: error)
  }

  /// A notification or indication from the peripheral.
  func notify(_ characteristic: FakeCharacteristic, value: Data) {
    characteristic.value = value
    delegate?.peripheral(self, didUpdateValue: value, for: characteristic, error: nil)
  }

  func characteristic(_ uuid: String) -> FakeCharacteristic? {
    let target = CBUUID(string: uuid)
    return services.lazy.flatMap(\.characteristics).first { $0.uuid == target }
  }

  // Attributes passed in always come from this peripheral's own fakes.

  private func fake(_ service: ServiceLike) -> FakeService {
    guard let service = service as? FakeService else { preconditionFailure("expected FakeService") }
    return service
  }

  private func fake(_ characteristic: CharacteristicLike) -> FakeCharacteristic {
    guard let characteristic = characteristic as? FakeCharacteristic else {
      preconditionFailure("expected FakeCharacteristic")
    }
    return characteristic
  }

  private func fake(_ descriptor: DescriptorLike) -> FakeDescriptor {
    guard let descriptor = descriptor as? FakeDescriptor else { preconditionFailure("expected FakeDescriptor") }
    return descriptor
  }
}
