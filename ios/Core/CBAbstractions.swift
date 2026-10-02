import CoreBluetooth
import Foundation

// Protocols over the CoreBluetooth types the core uses (plan §4.3, CBAbstractions), so XCTest can
// drive the core with fakes. Real implementations live in CBAdapters.swift.
//
// Threading (plan §4.7): every call and every delegate callback happens on the engine's serial
// queue. Nothing here is thread-safe on its own.

// MARK: - GATT attributes

/// A discovered GATT service. Implemented by `CBService` and by test fakes.
protocol ServiceLike: AnyObject {
  var uuid: CBUUID { get }
  var isPrimary: Bool { get }
  /// Discovered characteristics; empty before characteristic discovery.
  var characteristicList: [CharacteristicLike] { get }
}

/// A discovered characteristic. Implemented by `CBCharacteristic` and by test fakes.
protocol CharacteristicLike: AnyObject {
  var uuid: CBUUID { get }
  var properties: CBCharacteristicProperties { get }
  var isNotifying: Bool { get }
  /// Discovered descriptors; empty before descriptor discovery.
  var descriptorList: [DescriptorLike] { get }
  var parentService: ServiceLike? { get }
}

/// A discovered descriptor. Implemented by `CBDescriptor` and by test fakes.
protocol DescriptorLike: AnyObject {
  var uuid: CBUUID { get }
  var parentCharacteristic: CharacteristicLike? { get }
}

// MARK: - Peripheral

/// The remote peripheral as seen by the central role. Mirrors the `CBPeripheral` API.
protocol PeripheralLike: AnyObject {
  var identifier: UUID { get }
  var name: String? { get }
  var state: CBPeripheralState { get }
  /// Discovered services; empty before service discovery.
  var serviceList: [ServiceLike] { get }
  var canSendWriteWithoutResponse: Bool { get }
  var delegate: PeripheralLikeDelegate? { get set }

  func discoverServices(_ serviceUUIDs: [CBUUID]?)
  func discoverCharacteristics(_ characteristicUUIDs: [CBUUID]?, for service: ServiceLike)
  func discoverDescriptors(for characteristic: CharacteristicLike)
  func readValue(for characteristic: CharacteristicLike)
  func writeValue(_ data: Data, for characteristic: CharacteristicLike, type: CBCharacteristicWriteType)
  func readValue(for descriptor: DescriptorLike)
  func writeValue(_ data: Data, for descriptor: DescriptorLike)
  func setNotifyValue(_ enabled: Bool, for characteristic: CharacteristicLike)
  func readRSSI()
  func maximumWriteValueLength(for type: CBCharacteristicWriteType) -> Int
}

/// Callbacks from a `PeripheralLike`. Values are passed explicitly (instead of read back from the
/// attribute later) so the core always sees the value that arrived with the callback.
protocol PeripheralLikeDelegate: AnyObject {
  func peripheralDidDiscoverServices(_ peripheral: PeripheralLike, error: Error?)
  func peripheral(_ peripheral: PeripheralLike, didDiscoverCharacteristicsFor service: ServiceLike, error: Error?)
  func peripheral(
    _ peripheral: PeripheralLike,
    didDiscoverDescriptorsFor characteristic: CharacteristicLike,
    error: Error?
  )
  func peripheral(
    _ peripheral: PeripheralLike,
    didUpdateValue value: Data?,
    for characteristic: CharacteristicLike,
    error: Error?
  )
  func peripheral(_ peripheral: PeripheralLike, didWriteValueFor characteristic: CharacteristicLike, error: Error?)
  func peripheral(
    _ peripheral: PeripheralLike,
    didUpdateValue value: Data?,
    forDescriptor descriptor: DescriptorLike,
    error: Error?
  )
  func peripheral(_ peripheral: PeripheralLike, didWriteValueForDescriptor descriptor: DescriptorLike, error: Error?)
  func peripheral(
    _ peripheral: PeripheralLike,
    didUpdateNotificationStateFor characteristic: CharacteristicLike,
    error: Error?
  )
  func peripheral(_ peripheral: PeripheralLike, didReadRSSI rssi: Int, error: Error?)
  func peripheralIsReadyToSendWriteWithoutResponse(_ peripheral: PeripheralLike)
  func peripheral(_ peripheral: PeripheralLike, didModifyServices invalidatedServices: [ServiceLike])
  func peripheralDidUpdateName(_ peripheral: PeripheralLike)
}

extension PeripheralLikeDelegate {
  func peripheralDidDiscoverServices(_ peripheral: PeripheralLike, error: Error?) {}
  func peripheral(_ peripheral: PeripheralLike, didDiscoverCharacteristicsFor service: ServiceLike, error: Error?) {}
  func peripheral(
    _ peripheral: PeripheralLike,
    didDiscoverDescriptorsFor characteristic: CharacteristicLike,
    error: Error?
  ) {}
  func peripheral(
    _ peripheral: PeripheralLike,
    didUpdateValue value: Data?,
    for characteristic: CharacteristicLike,
    error: Error?
  ) {}
  func peripheral(_ peripheral: PeripheralLike, didWriteValueFor characteristic: CharacteristicLike, error: Error?) {}
  func peripheral(
    _ peripheral: PeripheralLike,
    didUpdateValue value: Data?,
    forDescriptor descriptor: DescriptorLike,
    error: Error?
  ) {}
  func peripheral(_ peripheral: PeripheralLike, didWriteValueForDescriptor descriptor: DescriptorLike, error: Error?) {}
  func peripheral(
    _ peripheral: PeripheralLike,
    didUpdateNotificationStateFor characteristic: CharacteristicLike,
    error: Error?
  ) {}
  func peripheral(_ peripheral: PeripheralLike, didReadRSSI rssi: Int, error: Error?) {}
  func peripheralIsReadyToSendWriteWithoutResponse(_ peripheral: PeripheralLike) {}
  func peripheral(_ peripheral: PeripheralLike, didModifyServices invalidatedServices: [ServiceLike]) {}
  func peripheralDidUpdateName(_ peripheral: PeripheralLike) {}
}

// MARK: - Central manager

/// The central role manager. Mirrors the `CBCentralManager` API.
protocol CentralManaging: AnyObject {
  var state: CBManagerState { get }
  var isScanning: Bool { get }
  var delegate: CentralManagingDelegate? { get set }

  func scanForPeripherals(withServices serviceUUIDs: [CBUUID]?, options: [String: Any]?)
  func stopScan()
  func connect(_ peripheral: PeripheralLike, options: [String: Any]?)
  func cancelPeripheralConnection(_ peripheral: PeripheralLike)
  func retrievePeripherals(withIdentifiers identifiers: [UUID]) -> [PeripheralLike]
  func retrieveConnectedPeripherals(withServices serviceUUIDs: [CBUUID]) -> [PeripheralLike]
}

protocol CentralManagingDelegate: AnyObject {
  func centralDidUpdateState(_ central: CentralManaging)
  func central(
    _ central: CentralManaging,
    didDiscover peripheral: PeripheralLike,
    advertisementData: [String: Any],
    rssi: Int
  )
  func central(_ central: CentralManaging, didConnect peripheral: PeripheralLike)
  func central(_ central: CentralManaging, didFailToConnect peripheral: PeripheralLike, error: Error?)
  /// `isReconnecting` is true when iOS 17+ auto-reconnect is already re-establishing the link.
  func central(
    _ central: CentralManaging,
    didDisconnect peripheral: PeripheralLike,
    isReconnecting: Bool,
    error: Error?
  )
  /// State restoration (plan §4.14). `peripherals` are the restored peripherals from `state`.
  func central(_ central: CentralManaging, willRestoreState state: [String: Any], peripherals: [PeripheralLike])
}

extension CentralManagingDelegate {
  func central(
    _ central: CentralManaging,
    didDiscover peripheral: PeripheralLike,
    advertisementData: [String: Any],
    rssi: Int
  ) {}
  func central(_ central: CentralManaging, didConnect peripheral: PeripheralLike) {}
  func central(_ central: CentralManaging, didFailToConnect peripheral: PeripheralLike, error: Error?) {}
  func central(
    _ central: CentralManaging,
    didDisconnect peripheral: PeripheralLike,
    isReconnecting: Bool,
    error: Error?
  ) {}
  func central(_ central: CentralManaging, willRestoreState state: [String: Any], peripherals: [PeripheralLike]) {}
}

/// Creates the central manager on the engine's queue. Injected so the engine can create it lazily
/// (creating it can show the permission prompt, plan §4.3) and so tests can supply a fake.
typealias CentralManagerFactory = (_ queue: DispatchQueue, _ options: [String: Any]?) -> CentralManaging
