import CoreBluetooth
import Foundation
@testable import BleKitCore

/// A central's request, as the fake manager delivers it.
final class FakeATTRequest: ATTRequestLike {
  let centralId: UUID
  let characteristicUUID: CBUUID
  let offset: Int
  var value: Data?

  init(central: UUID, characteristic: CBUUID, offset: Int, value: Data? = nil) {
    centralId = central
    characteristicUUID = characteristic
    self.offset = offset
    self.value = value
  }
}

/// `PeripheralManaging` for tests: records services and answers, and confirms each `add` at once
/// unless `confirmsAdds` is false.
final class FakePeripheralManager: PeripheralManaging {
  var state: CBManagerState
  weak var delegate: PeripheralManagingDelegate?
  weak var advertisingDelegate: PeripheralAdvertisingDelegate?
  weak var l2capDelegate: PeripheralL2CAPDelegate?
  var confirmsAdds = true
  private(set) var added: [CBUUID] = []
  private(set) var answers: [(request: FakeATTRequest, result: CBATTError.Code)] = []
  private(set) var removedAll = false

  init(state: CBManagerState = .poweredOn) {
    self.state = state
  }

  func add(_ service: ServerServiceSpec) {
    added.append(service.uuid)
    if confirmsAdds { delegate?.peripheralManager(self, didAdd: service.uuid, error: nil) }
  }

  func removeAllServices() {
    removedAll = true
  }

  func respond(to request: ATTRequestLike, withResult result: CBATTError.Code) {
    if let request = request as? FakeATTRequest { answers.append((request, result)) }
  }

  /// What `updateValue` answers; false is a full transmit queue.
  var queueHasRoom = true
  var maximumUpdateValueLengths: [UUID: Int] = [:]
  struct Update {
    let count: Int
    let centrals: [UUID]
  }

  private(set) var updates: [Update] = []

  func updateValue(_ value: Data, for characteristic: CBUUID, onSubscribedCentrals centrals: [UUID]) -> Bool {
    guard queueHasRoom else { return false }
    updates.append(Update(count: value.count, centrals: centrals))
    return true
  }

  func maximumUpdateValueLength(for central: UUID) -> Int? {
    maximumUpdateValueLengths[central]
  }

  func becomes(_ state: CBManagerState) {
    self.state = state
    delegate?.peripheralManagerDidUpdateState(self)
    advertisingDelegate?.peripheralManagerStateChanged(self)
    l2capDelegate?.peripheralManagerStateChanged(self)
  }

  struct Advertisement: Equatable {
    let localName: String?
    let serviceUUIDs: [CBUUID]
  }

  /// What `startAdvertising` was asked; the test answers with `didStartAdvertising(error:)`.
  private(set) var advertisements: [Advertisement] = []
  private(set) var advertisingStops = 0

  func startAdvertising(localName: String?, serviceUUIDs: [CBUUID]) {
    advertisements.append(Advertisement(localName: localName, serviceUUIDs: serviceUUIDs))
  }

  func stopAdvertising() {
    advertisingStops += 1
  }

  func didStartAdvertising(error: Error? = nil) {
    advertisingDelegate?.peripheralManagerDidStartAdvertising(self, error: error)
  }

  /// What `publishL2CAPChannel` was asked (P5-03); the test answers with `didPublish`.
  private(set) var publishes: [Bool] = []
  private(set) var unpublished: [CBL2CAPPSM] = []

  func publishL2CAPChannel(withEncryption encryptionRequired: Bool) {
    publishes.append(encryptionRequired)
  }

  func unpublishL2CAPChannel(_ psm: CBL2CAPPSM) {
    unpublished.append(psm)
  }

  func didPublish(_ psm: CBL2CAPPSM, error: Error? = nil) {
    l2capDelegate?.peripheralManager(self, didPublishL2CAPChannel: psm, error: error)
  }

  /// A central opened a channel.
  func didOpen(_ channel: FakeL2CAPChannel?, error: Error? = nil) {
    l2capDelegate?.peripheralManager(self, didOpen: channel, error: error)
  }
}
