#if canImport(AccessorySetupKit) && os(iOS)
import AccessorySetupKit
import CoreBluetooth
import UIKit

/// `AccessorySessionLike` over `ASAccessorySession` (iOS 18+, P5-04).
@available(iOS 18.0, *)
final class ASAccessorySessionAdapter: AccessorySessionLike {
  private let session = ASAccessorySession()

  func activate(on queue: DispatchQueue, eventHandler: @escaping (AccessorySessionEvent) -> Void) {
    session.activate(on: queue) { event in
      switch event.eventType {
      case .activated:
        eventHandler(.activated)
      case .accessoryAdded:
        eventHandler(.accessoryAdded(bluetoothIdentifier: event.accessory?.bluetoothIdentifier))
      case .pickerDidDismiss:
        eventHandler(.pickerDidDismiss)
      case .invalidated:
        eventHandler(.invalidated)
      default:
        eventHandler(.other)
      }
    }
  }

  func showPicker(for items: [AccessoryPickerItemSpec], completion: @escaping (AccessoryPickerFailure?) -> Void) {
    let displayItems = items.compactMap(Self.displayItem)
    session.showPicker(for: displayItems) { error in
      completion(error.map(Self.failure))
    }
  }

  func invalidate() {
    session.invalidate()
  }

  private static func displayItem(_ item: AccessoryPickerItemSpec) -> ASPickerDisplayItem? {
    guard let image = UIImage(data: item.image) else { return nil }
    let descriptor = ASDiscoveryDescriptor()
    if let service = item.service { descriptor.bluetoothServiceUUID = service }
    if let company = item.companyId { descriptor.bluetoothCompanyIdentifier = ASBluetoothCompanyIdentifier(company) }
    if let name = item.nameSubstring { descriptor.bluetoothNameSubstring = name }
    if let manufacturer = item.manufacturerData {
      descriptor.bluetoothManufacturerDataBlob = manufacturer.data
      descriptor.bluetoothManufacturerDataMask = manufacturer.mask
    }
    if let serviceData = item.serviceData {
      descriptor.bluetoothServiceDataBlob = serviceData.data
      descriptor.bluetoothServiceDataMask = serviceData.mask
    }
    if item.immediateRange { descriptor.bluetoothRange = .immediate }
    return ASPickerDisplayItem(name: item.name, productImage: image, descriptor: descriptor)
  }

  private static func failure(_ error: Error) -> AccessoryPickerFailure {
    let nsError = error as NSError
    let kind: AccessoryPickerFailure.Kind
    switch (error as? ASError)?.code {
    case .userCancelled: kind = .userCancelled
    case .discoveryTimeout: kind = .discoveryTimeout
    case .pickerAlreadyActive: kind = .alreadyActive
    case .pickerRestricted, .userRestricted: kind = .restricted
    case .invalidRequest: kind = .invalidRequest
    default: kind = .other
    }
    return AccessoryPickerFailure(kind: kind, message: nsError.localizedDescription, code: nsError.code)
  }
}
#endif
