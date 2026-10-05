import CoreBluetooth
import Foundation

/// `PeripheralManaging` on a real `CBPeripheralManager`, created on the peripheral queue (plan §4.4).
final class CBPeripheralManagerAdapter: NSObject, PeripheralManaging {
  weak var delegate: PeripheralManagingDelegate?
  private var manager: CBPeripheralManager!

  init(queue: DispatchQueue) {
    super.init()
    manager = CBPeripheralManager(
      delegate: self,
      queue: queue,
      options: [CBPeripheralManagerOptionShowPowerAlertKey: false]
    )
  }

  var state: CBManagerState { manager.state }

  func add(_ service: ServerServiceSpec) {
    manager.add(service.mutableService())
  }

  func removeAllServices() {
    manager.removeAllServices()
  }

  func respond(to request: ATTRequestLike, withResult result: CBATTError.Code) {
    guard let request = request as? ATTRequestAdapter else { return }
    manager.respond(to: request.request, withResult: result)
  }
}

extension CBPeripheralManagerAdapter: CBPeripheralManagerDelegate {
  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    delegate?.peripheralManagerDidUpdateState(self)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    delegate?.peripheralManager(self, didAdd: service.uuid, error: error)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    delegate?.peripheralManager(self, didReceiveRead: ATTRequestAdapter(request))
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    delegate?.peripheralManager(self, didReceiveWrite: requests.map(ATTRequestAdapter.init))
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    delegate?.peripheralManager(self, central: central.identifier, didSubscribeTo: characteristic.uuid)
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    delegate?.peripheralManager(self, central: central.identifier, didUnsubscribeFrom: characteristic.uuid)
  }
}

/// `ATTRequestLike` over a `CBATTRequest`.
final class ATTRequestAdapter: ATTRequestLike {
  let request: CBATTRequest

  init(_ request: CBATTRequest) {
    self.request = request
  }

  var centralId: UUID { request.central.identifier }
  var characteristicUUID: CBUUID { request.characteristic.uuid }
  var offset: Int { request.offset }
  var value: Data? {
    get { request.value }
    set { request.value = newValue }
  }
}

extension ServerServiceSpec {
  /// The CoreBluetooth service. A static value is cached by iOS, which makes the characteristic
  /// read-only; iOS adds the CCCD of notifiable characteristics itself.
  func mutableService() -> CBMutableService {
    let service = CBMutableService(type: uuid, primary: primary)
    service.characteristics = characteristics.map { spec in
      let characteristic = CBMutableCharacteristic(
        type: spec.uuid,
        properties: spec.properties,
        value: spec.value,
        permissions: spec.permissions
      )
      characteristic.descriptors = spec.descriptors.map { descriptor in
        // A user description descriptor takes a string, a format descriptor the bytes.
        let isDescription = descriptor.uuid == CBUUID(string: CBUUIDCharacteristicUserDescriptionString)
        let value: Any = isDescription ? String(bytes: descriptor.value, encoding: .utf8) ?? "" : descriptor.value
        return CBMutableDescriptor(type: descriptor.uuid, value: value)
      }
      return characteristic
    }
    return service
  }
}
