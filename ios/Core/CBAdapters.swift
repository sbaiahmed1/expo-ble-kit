import CoreBluetooth
import Foundation

// Real CoreBluetooth implementations of the CBAbstractions protocols.

// MARK: - Attributes

extension CBService: ServiceLike {
  var characteristicList: [CharacteristicLike] {
    characteristics ?? []
  }
}

extension CBCharacteristic: CharacteristicLike {
  var descriptorList: [DescriptorLike] {
    descriptors ?? []
  }

  var parentService: ServiceLike? {
    service
  }
}

extension CBDescriptor: DescriptorLike {
  var parentCharacteristic: CharacteristicLike? {
    characteristic
  }
}

enum DescriptorValue {
  /// CoreBluetooth reports descriptor values as `Data`, `String` (user description) or `NSNumber`
  /// (CCCD, extended properties). The core always works with bytes.
  static func data(from value: Any?) -> Data? {
    switch value {
    case let data as Data:
      return data
    case let string as String:
      return Data(string.utf8)
    case let number as NSNumber:
      let raw = number.uint16Value.littleEndian
      return withUnsafeBytes(of: raw) { Data($0) }
    default:
      return nil
    }
  }
}

// MARK: - Peripheral

final class CBPeripheralAdapter: NSObject, PeripheralLike, CBPeripheralDelegate {
  let peripheral: CBPeripheral
  weak var delegate: PeripheralLikeDelegate?
  /// The manager's queue, where L2CAP channel streams report too (P5-03).
  private let queue: DispatchQueue

  init(peripheral: CBPeripheral, queue: DispatchQueue) {
    self.peripheral = peripheral
    self.queue = queue
    super.init()
    peripheral.delegate = self
  }

  var identifier: UUID { peripheral.identifier }
  var name: String? { peripheral.name }
  var state: CBPeripheralState { peripheral.state }
  var serviceList: [ServiceLike] { peripheral.services ?? [] }
  var canSendWriteWithoutResponse: Bool { peripheral.canSendWriteWithoutResponse }

  func discoverServices(_ serviceUUIDs: [CBUUID]?) {
    peripheral.discoverServices(serviceUUIDs)
  }

  func discoverCharacteristics(_ characteristicUUIDs: [CBUUID]?, for service: ServiceLike) {
    peripheral.discoverCharacteristics(characteristicUUIDs, for: Self.cbService(service))
  }

  func discoverDescriptors(for characteristic: CharacteristicLike) {
    peripheral.discoverDescriptors(for: Self.cbCharacteristic(characteristic))
  }

  func readValue(for characteristic: CharacteristicLike) {
    peripheral.readValue(for: Self.cbCharacteristic(characteristic))
  }

  func writeValue(_ data: Data, for characteristic: CharacteristicLike, type: CBCharacteristicWriteType) {
    peripheral.writeValue(data, for: Self.cbCharacteristic(characteristic), type: type)
  }

  func readValue(for descriptor: DescriptorLike) {
    peripheral.readValue(for: Self.cbDescriptor(descriptor))
  }

  func writeValue(_ data: Data, for descriptor: DescriptorLike) {
    peripheral.writeValue(data, for: Self.cbDescriptor(descriptor))
  }

  func setNotifyValue(_ enabled: Bool, for characteristic: CharacteristicLike) {
    peripheral.setNotifyValue(enabled, for: Self.cbCharacteristic(characteristic))
  }

  func readRSSI() {
    peripheral.readRSSI()
  }

  func maximumWriteValueLength(for type: CBCharacteristicWriteType) -> Int {
    peripheral.maximumWriteValueLength(for: type)
  }

  func openL2CAPChannel(_ psm: CBL2CAPPSM) {
    peripheral.openL2CAPChannel(psm)
  }

  // Attributes handed to this adapter always come from its own discovery, so they are
  // CoreBluetooth objects. Anything else is a programming error.

  private static func cbService(_ service: ServiceLike) -> CBService {
    guard let service = service as? CBService else {
      preconditionFailure("CBPeripheralAdapter received a non-CoreBluetooth service")
    }
    return service
  }

  private static func cbCharacteristic(_ characteristic: CharacteristicLike) -> CBCharacteristic {
    guard let characteristic = characteristic as? CBCharacteristic else {
      preconditionFailure("CBPeripheralAdapter received a non-CoreBluetooth characteristic")
    }
    return characteristic
  }

  private static func cbDescriptor(_ descriptor: DescriptorLike) -> CBDescriptor {
    guard let descriptor = descriptor as? CBDescriptor else {
      preconditionFailure("CBPeripheralAdapter received a non-CoreBluetooth descriptor")
    }
    return descriptor
  }

  // MARK: CBPeripheralDelegate

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    delegate?.peripheralDidDiscoverServices(self, error: error)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    delegate?.peripheral(self, didDiscoverCharacteristicsFor: service, error: error)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverDescriptorsFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    delegate?.peripheral(self, didDiscoverDescriptorsFor: characteristic, error: error)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    delegate?.peripheral(self, didUpdateValue: characteristic.value, for: characteristic, error: error)
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    delegate?.peripheral(self, didWriteValueFor: characteristic, error: error)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor descriptor: CBDescriptor, error: Error?) {
    delegate?.peripheral(
      self,
      didUpdateValue: DescriptorValue.data(from: descriptor.value),
      forDescriptor: descriptor,
      error: error
    )
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor descriptor: CBDescriptor, error: Error?) {
    delegate?.peripheral(self, didWriteValueForDescriptor: descriptor, error: error)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    delegate?.peripheral(self, didUpdateNotificationStateFor: characteristic, error: error)
  }

  func peripheral(_ peripheral: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
    delegate?.peripheral(self, didReadRSSI: RSSI.intValue, error: error)
  }

  func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
    delegate?.peripheralIsReadyToSendWriteWithoutResponse(self)
  }

  func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
    delegate?.peripheral(self, didModifyServices: invalidatedServices)
  }

  func peripheralDidUpdateName(_ peripheral: CBPeripheral) {
    delegate?.peripheralDidUpdateName(self)
  }

  func peripheral(_ peripheral: CBPeripheral, didOpen channel: CBL2CAPChannel?, error: Error?) {
    delegate?.peripheral(self, didOpen: channel.map { CBL2CAPChannelAdapter($0, queue: queue) }, error: error)
  }
}

// MARK: - Central manager

final class CBCentralManagerAdapter: NSObject, CentralManaging, CBCentralManagerDelegate {
  private var manager: CBCentralManager!
  private let queue: DispatchQueue
  /// One adapter per peripheral identifier, so the core always sees the same object.
  private var adapters: [UUID: CBPeripheralAdapter] = [:]
  weak var delegate: CentralManagingDelegate?

  /// Creates the CBCentralManager, which may show the Bluetooth permission prompt.
  init(queue: DispatchQueue, options: [String: Any]?) {
    self.queue = queue
    super.init()
    // With a restore identifier, CoreBluetooth asserts that the delegate it gets here implements
    // willRestoreState, so the adapter is the delegate from the start (P3-01).
    manager = CBCentralManager(delegate: self, queue: queue, options: options)
  }

  static let factory: CentralManagerFactory = { queue, options in
    CBCentralManagerAdapter(queue: queue, options: options)
  }

  var state: CBManagerState { manager.state }
  var isScanning: Bool { manager.isScanning }

  func scanForPeripherals(withServices serviceUUIDs: [CBUUID]?, options: [String: Any]?) {
    manager.scanForPeripherals(withServices: serviceUUIDs, options: options)
  }

  func stopScan() {
    manager.stopScan()
  }

  func connect(_ peripheral: PeripheralLike, options: [String: Any]?) {
    manager.connect(Self.cbPeripheral(peripheral), options: options)
  }

  func cancelPeripheralConnection(_ peripheral: PeripheralLike) {
    manager.cancelPeripheralConnection(Self.cbPeripheral(peripheral))
  }

  func retrievePeripherals(withIdentifiers identifiers: [UUID]) -> [PeripheralLike] {
    manager.retrievePeripherals(withIdentifiers: identifiers).map(adapter(for:))
  }

  func retrieveConnectedPeripherals(withServices serviceUUIDs: [CBUUID]) -> [PeripheralLike] {
    manager.retrieveConnectedPeripherals(withServices: serviceUUIDs).map(adapter(for:))
  }

  private func adapter(for peripheral: CBPeripheral) -> CBPeripheralAdapter {
    if let existing = adapters[peripheral.identifier] {
      return existing
    }
    let created = CBPeripheralAdapter(peripheral: peripheral, queue: queue)
    adapters[peripheral.identifier] = created
    return created
  }

  private static func cbPeripheral(_ peripheral: PeripheralLike) -> CBPeripheral {
    guard let adapter = peripheral as? CBPeripheralAdapter else {
      preconditionFailure("CBCentralManagerAdapter received a non-CoreBluetooth peripheral")
    }
    return adapter.peripheral
  }

  // MARK: CBCentralManagerDelegate

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    delegate?.centralDidUpdateState(self)
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                      advertisementData: [String: Any], rssi RSSI: NSNumber) {
    delegate?.central(
      self,
      didDiscover: adapter(for: peripheral),
      advertisementData: advertisementData,
      rssi: RSSI.intValue
    )
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    delegate?.central(self, didConnect: adapter(for: peripheral))
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    delegate?.central(self, didFailToConnect: adapter(for: peripheral), error: error)
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    delegate?.central(self, didDisconnect: adapter(for: peripheral), isReconnecting: false, error: error)
  }

  // iOS 17+: called instead of the method above when implemented; older systems never call it.
  // The SDK requires it without an @available restriction. ⚠️ VERIFY call precedence (plan §4.3).
  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                      timestamp: CFAbsoluteTime, isReconnecting: Bool, error: Error?) {
    delegate?.central(self, didDisconnect: adapter(for: peripheral), isReconnecting: isReconnecting, error: error)
  }

  func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
    let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral]) ?? []
    delegate?.central(self, willRestoreState: dict, peripherals: restored.map(adapter(for:)))
  }
}
