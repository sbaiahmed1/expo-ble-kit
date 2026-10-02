import CoreBluetooth
import Foundation

/// A discovered characteristic: part of JS `Service` (plan §5.4).
struct DiscoveredCharacteristic: Equatable {
  let uuid: String
  let properties: [String]
  let descriptors: [String]
}

/// JS `Service` (plan §5.4). UUIDs are lowercase 128-bit.
struct DiscoveredService: Equatable {
  let uuid: String
  let isPrimary: Bool
  let characteristics: [DiscoveredCharacteristic]

  init(_ service: ServiceLike) {
    uuid = service.uuid.fullUUIDString
    isPrimary = service.isPrimary
    characteristics = service.characteristicList.map { characteristic in
      DiscoveredCharacteristic(
        uuid: characteristic.uuid.fullUUIDString,
        properties: Self.propertyNames(characteristic.properties),
        descriptors: characteristic.descriptorList.map(\.uuid.fullUUIDString)
      )
    }
  }

  /// JS `CharacteristicProperty` names, in declaration order. iOS's "encryption required" variants
  /// of notify and indicate count as notify and indicate.
  static func propertyNames(_ properties: CBCharacteristicProperties) -> [String] {
    let names: [(CBCharacteristicProperties, String)] = [
      (.broadcast, "broadcast"),
      (.read, "read"),
      (.writeWithoutResponse, "writeWithoutResponse"),
      (.write, "write"),
      ([.notify, .notifyEncryptionRequired], "notify"),
      ([.indicate, .indicateEncryptionRequired], "indicate"),
      (.authenticatedSignedWrites, "authenticatedSignedWrites"),
      (.extendedProperties, "extendedProperties")
    ]
    return names.filter { !properties.isDisjoint(with: $0.0) }.map(\.1)
  }

  var dictionary: [String: Any] {
    [
      "uuid": uuid,
      "isPrimary": isPrimary,
      "characteristics": characteristics.map { characteristic in
        [
          "uuid": characteristic.uuid,
          "serviceUUID": uuid,
          "properties": characteristic.properties,
          "descriptors": characteristic.descriptors.map { ["uuid": $0, "characteristicUUID": characteristic.uuid] }
        ] as [String: Any]
      }
    ]
  }
}
