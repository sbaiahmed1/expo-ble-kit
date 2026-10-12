import CoreBluetooth
import Foundation

// The peripheral role's GATT server (plan §4.4, §5.5, P4-01): definitions, the abstraction over
// CBPeripheralManager for XCTest, and the long-read cache.

/// JS `ServiceDefinition` after the TS layer validated it (plan §5.5).
struct ServerServiceSpec {
  let uuid: CBUUID
  let primary: Bool
  let characteristics: [ServerCharacteristicSpec]
}

/// JS `CharacteristicDefinition`. A `value` makes it static: iOS caches it and answers reads itself.
struct ServerCharacteristicSpec {
  let uuid: CBUUID
  let properties: CBCharacteristicProperties
  let permissions: CBAttributePermissions
  let value: Data?
  let descriptors: [ServerDescriptorSpec]
}

/// A static descriptor: iOS only publishes user description (0x2901) and format (0x2904) descriptors.
struct ServerDescriptorSpec {
  let uuid: CBUUID
  let value: Data
}

/// A central's read or write request. Mirrors `CBATTRequest`.
protocol ATTRequestLike: AnyObject {
  var centralId: UUID { get }
  var characteristicUUID: CBUUID { get }
  var offset: Int { get }
  /// Nil for reads until answered; the written data for writes.
  var value: Data? { get set }
}

/// The peripheral manager as the GATT server uses it. Mirrors `CBPeripheralManager`.
protocol PeripheralManaging: AnyObject {
  var state: CBManagerState { get }
  var delegate: PeripheralManagingDelegate? { get set }
  func add(_ service: ServerServiceSpec)
  func removeAllServices()
  func respond(to request: ATTRequestLike, withResult result: CBATTError.Code)
  /// Sends a notification or indication (P4-02); false when the transmit queue is full: wait for
  /// `peripheralManagerIsReady`, then send again (Apple's `updateValue` docs).
  func updateValue(_ value: Data, for characteristic: CBUUID, onSubscribedCentrals centrals: [UUID]) -> Bool
  /// The most a notification to `central` carries (`CBCentral.maximumUpdateValueLength`), if known.
  func maximumUpdateValueLength(for central: UUID) -> Int?
  /// The advertiser's callbacks (P4-03); `delegate` stays the GATT server's.
  var advertisingDelegate: PeripheralAdvertisingDelegate? { get set }
  /// Advertises the two keys iOS supports (Apple's `startAdvertising(_:)` docs).
  func startAdvertising(localName: String?, serviceUUIDs: [CBUUID])
  func stopAdvertising()
  /// The L2CAP publisher's callbacks (P5-03).
  var l2capDelegate: PeripheralL2CAPDelegate? { get set }
  /// Answered by `didPublishL2CAPChannel` with the PSM iOS assigned.
  func publishL2CAPChannel(withEncryption encryptionRequired: Bool)
  /// Also closes the channels on `psm` (Apple's `unpublishL2CAPChannel(_:)` docs).
  func unpublishL2CAPChannel(_ psm: CBL2CAPPSM)
  /// P4-04: the services iOS kept published while the app wasn't running, from state restoration.
  var restoredServices: [CBUUID] { get }
  /// Takes the restored services over: their subscriptions reach the delegate as subscribes.
  func adoptRestoredServices()
}

/// Callbacks of `PeripheralManaging`, on the peripheral queue.
protocol PeripheralManagingDelegate: AnyObject {
  func peripheralManagerDidUpdateState(_ manager: PeripheralManaging)
  func peripheralManager(_ manager: PeripheralManaging, didAdd service: CBUUID, error: Error?)
  func peripheralManager(_ manager: PeripheralManaging, didReceiveRead request: ATTRequestLike)
  func peripheralManager(_ manager: PeripheralManaging, didReceiveWrite requests: [ATTRequestLike])
  func peripheralManager(_ manager: PeripheralManaging, central: UUID, didSubscribeTo characteristic: CBUUID)
  func peripheralManager(_ manager: PeripheralManaging, central: UUID, didUnsubscribeFrom characteristic: CBUUID)
  func peripheralManagerIsReady(toUpdateSubscribers manager: PeripheralManaging)
}

/// The long-read cache of plan §5.5 (shared contract `test-contracts/gatt-server-reads.json`): one
/// value per central and characteristic, so a long read's continuation reads (offset > 0) come from
/// the same handler result as its first read.
final class ServerReadCache {
  /// As long as ATT's transaction timeout (Core spec Vol 3 Part F 3.3.3).
  static let ttl: TimeInterval = 30

  private struct Key: Hashable {
    let central: UUID
    let characteristic: CBUUID
  }

  private var entries: [Key: (value: Data, at: TimeInterval)] = [:]
  private let now: () -> TimeInterval

  init(now: @escaping () -> TimeInterval) {
    self.now = now
  }

  /// The value to answer a read at `offset` with, or nil when the handler must be asked.
  func lookup(central: UUID, characteristic: CBUUID, offset: Int) -> Data? {
    guard offset > 0, let entry = entries[Key(central: central, characteristic: characteristic)] else { return nil }
    return now() - entry.at < Self.ttl ? entry.value : nil
  }

  /// Keeps the handler's answer for the rest of the read sequence.
  func store(central: UUID, characteristic: CBUUID, value: Data) {
    entries[Key(central: central, characteristic: characteristic)] = (value, now())
  }

  func drop(central: UUID) {
    entries = entries.filter { $0.key.central != central }
  }

  func clear() {
    entries.removeAll()
  }

  /// The part of `value` from `offset`, or nil when `offset` is past the end (invalidOffset).
  static func slice(_ value: Data, from offset: Int) -> Data? {
    offset > value.count ? nil : value.subdata(in: offset..<value.count)
  }
}
