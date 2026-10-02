import CoreBluetooth
import Foundation
@testable import BleKitCore

final class FakeService: ServiceLike {
  let uuid: CBUUID
  let isPrimary: Bool
  let characteristics: [FakeCharacteristic]
  /// What `characteristicList` returns; filled by characteristic discovery.
  var discoveredCharacteristics: [FakeCharacteristic] = []

  init(uuid: String, isPrimary: Bool = true, characteristics: [FakeCharacteristic] = []) {
    self.uuid = CBUUID(string: uuid)
    self.isPrimary = isPrimary
    self.characteristics = characteristics
    for characteristic in characteristics {
      characteristic.service = self
    }
  }

  var characteristicList: [CharacteristicLike] { discoveredCharacteristics }
}

final class FakeCharacteristic: CharacteristicLike {
  let uuid: CBUUID
  let properties: CBCharacteristicProperties
  var value: Data?
  var isNotifying = false
  let descriptors: [FakeDescriptor]
  var discoveredDescriptors: [FakeDescriptor] = []
  weak var service: FakeService?

  init(uuid: String, properties: CBCharacteristicProperties, value: Data? = nil, descriptors: [FakeDescriptor] = []) {
    self.uuid = CBUUID(string: uuid)
    self.properties = properties
    self.value = value
    self.descriptors = descriptors
    for descriptor in descriptors {
      descriptor.characteristic = self
    }
  }

  var descriptorList: [DescriptorLike] { discoveredDescriptors }
  var parentService: ServiceLike? { service }
}

final class FakeDescriptor: DescriptorLike {
  let uuid: CBUUID
  var value: Data?
  weak var characteristic: FakeCharacteristic?

  init(uuid: String, value: Data? = nil) {
    self.uuid = CBUUID(string: uuid)
    self.value = value
  }

  var parentCharacteristic: CharacteristicLike? { characteristic }
}
