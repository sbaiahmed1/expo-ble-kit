import CoreBluetooth
import Foundation

/// A notification waiting for the transmit queue: nil `centrals` means every subscriber.
struct Outgoing {
  let key: String
  let value: Data
  let centrals: [CBCentral]?
}

/// The test profile on a CBPeripheralManager. Writes and CONTROL are in TestPeripheral+Writes.swift,
/// subscriptions and notifications in TestPeripheral+Notifications.swift.
final class TestPeripheral: NSObject, CBPeripheralManagerDelegate, @unchecked Sendable {
  static let propertyFlags: [String: CBCharacteristicProperties] = [
    "read": .read, "write": .write, "writeWithoutResponse": .writeWithoutResponse,
    "notify": .notify, "indicate": .indicate
  ]
  static let permissionFlags: [String: CBAttributePermissions] = [
    "readable": .readable, "writeable": .writeable,
    "readEncryptionRequired": .readEncryptionRequired, "writeEncryptionRequired": .writeEncryptionRequired
  ]

  let queue = DispatchQueue(label: "blekit.peripheral")
  let profile: Profile
  let name: String
  var manager: CBPeripheralManager?

  var services: [String: CBMutableService] = [:]
  var characteristics: [String: CBMutableCharacteristic] = [:]
  var keys: [CBUUID: String] = [:]
  var subscribers: [String: [CBCentral]] = [:]
  var secondaryAdded = false
  var psm: CBL2CAPPSM = 0
  var channels: [EchoChannel] = []

  var echoValue = Data()
  var sinkCount: UInt32 = 0
  var sinkNotifyScheduled = false
  var streamSeq: UInt32 = 0
  var indicateSeq: UInt32 = 0
  var bpm: UInt8
  let minBpm: UInt8
  let maxBpm: UInt8
  let heartRateInterval: TimeInterval

  /// Notifications waiting for the transmit queue, in order.
  var outbox: [Outgoing] = []
  /// The STREAM frame not yet taken by every subscriber; the sequence only advances once it is.
  var streamPending: (frame: Data, centrals: [CBCentral])?
  var streamTimer: DispatchSourceTimer?
  var heartRateTimer: DispatchSourceTimer?

  init(profile: Profile, name: String) {
    self.profile = profile
    self.name = name
    let heartRate = profile.characteristic("HEART_RATE_MEASUREMENT")?.spec ?? [:]
    minBpm = UInt8(heartRate["minBpm"] as? Int ?? 60)
    maxBpm = UInt8(heartRate["maxBpm"] as? Int ?? 100)
    bpm = minBpm
    heartRateInterval = Double(heartRate["intervalMs"] as? Int ?? 1000) / 1000
    echoValue = profile.characteristic("ECHO_READ")?.value ?? Data()
  }

  func start() {
    queue.async { self.manager = CBPeripheralManager(delegate: self, queue: self.queue) }
  }

  // MARK: Setup

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    switch peripheral.state {
    case .poweredOn:
      Log.write("Bluetooth on: publishing an L2CAP channel without encryption")
      peripheral.publishL2CAPChannel(withEncryption: false)
    case .unauthorized:
      Log.write("FAILED: Bluetooth isn't allowed for BleKitPeripheral (System Settings)")
      exit(1)
    case .poweredOff, .unsupported:
      Log.write("FAILED: Bluetooth is off or unsupported")
      exit(1)
    default:
      break
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didPublishL2CAPChannel PSM: CBL2CAPPSM, error: Error?) {
    if let error {
      Log.write("FAILED: publishing: \(error.localizedDescription)")
      exit(1)
    }
    psm = PSM
    Log.write(String(format: "echo server on PSM 0x%x", PSM))
    for service in profile.services {
      let built = CBMutableService(type: service.uuid, primary: true)
      built.characteristics = service.characteristics.map(makeCharacteristic)
      services[service.key] = built
      if !service.toggled { peripheral.add(built) }
    }
    peripheral.startAdvertising([
      CBAdvertisementDataLocalNameKey: name,
      CBAdvertisementDataServiceUUIDsKey: profile.advertisedServices
    ])
    startHeartRate()
  }

  private func makeCharacteristic(_ spec: Profile.Characteristic) -> CBMutableCharacteristic {
    let properties = spec.properties.reduce(into: CBCharacteristicProperties()) {
      $0.formUnion(Self.propertyFlags[$1] ?? [])
    }
    let permissions = spec.permissions.reduce(into: CBAttributePermissions()) {
      $0.formUnion(Self.permissionFlags[$1] ?? [])
    }
    // CoreBluetooth caches a static value only for plain readable, read-only characteristics.
    let isStatic = spec.properties == ["read"] && spec.permissions == ["readable"] && spec.value != nil
      && !["ECHO_READ", "L2CAP_PSM"].contains(spec.key)
    let characteristic = CBMutableCharacteristic(
      type: spec.uuid,
      properties: properties,
      value: isStatic ? spec.value : nil,
      permissions: permissions
    )
    if let text = spec.userDescription {
      characteristic.descriptors = [
        CBMutableDescriptor(type: CBUUID(string: CBUUIDCharacteristicUserDescriptionString), value: text)
      ]
    }
    characteristics[spec.key] = characteristic
    keys[spec.uuid] = spec.key
    return characteristic
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    if let error {
      Log.write("FAILED: adding \(service.uuid): \(error.localizedDescription)")
      exit(1)
    }
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    if let error {
      Log.write("FAILED: advertising: \(error.localizedDescription)")
      exit(1)
    }
    Log.write("advertising as \(name): TEST, HEART_RATE and the L2CAP echo server")
  }

  // MARK: Reads

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    let key = keys[request.characteristic.uuid] ?? ""
    let value: Data?
    switch key {
    case "ECHO_READ": value = echoValue
    case "SINK_COUNTER": value = uint32(sinkCount)
    case "L2CAP_PSM": value = withUnsafeBytes(of: psm.littleEndian) { Data($0) }
    default: value = profile.characteristic(key)?.value
    }
    guard let value else {
      return peripheral.respond(to: request, withResult: .readNotPermitted)
    }
    guard request.offset <= value.count else {
      return peripheral.respond(to: request, withResult: .invalidOffset)
    }
    request.value = value.subdata(in: request.offset..<value.count)
    peripheral.respond(to: request, withResult: .success)
  }

  // MARK: L2CAP

  func peripheralManager(_ peripheral: CBPeripheralManager, didOpen channel: CBL2CAPChannel?, error: Error?) {
    guard let channel, error == nil else {
      return Log.write("a channel failed to open: \(error?.localizedDescription ?? "no channel")")
    }
    Log.write("channel opened by \(channel.peer.identifier.uuidString)")
    let echo = EchoChannel(channel)
    echo.onEnd = { [weak self] ended in self?.channels.removeAll { $0 === ended } }
    channels.append(echo)
    echo.start(on: queue)
  }
}
