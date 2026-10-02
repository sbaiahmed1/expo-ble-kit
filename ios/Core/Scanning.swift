import CoreBluetooth
import Foundation

/// A manufacturer-data filter of JS `ScanOptions` (plan §5.3).
struct ManufacturerFilter {
  let companyId: Int
  var data: Data?
  var mask: Data?

  /// `value` starts with `data`, comparing only the bits set in `mask`.
  func matches(_ value: Data) -> Bool {
    guard let expected = data else {
      return true
    }
    guard value.count >= expected.count else {
      return false
    }
    let value = [UInt8](value)
    let mask = mask.map { [UInt8]($0) } ?? []
    return [UInt8](expected).enumerated().allSatisfy { index, byte in
      let bits = index < mask.count ? mask[index] : 0xFF
      return value[index] & bits == byte & bits
    }
  }
}

/// JS `ScanOptions` after the TS layer validated it and normalized its UUIDs to lowercase 128-bit
/// strings (plan §5.3).
struct ScanSpec {
  var services: [String] = []
  var allowDuplicates = false
  /// Seconds; 0 delivers each result at once.
  var reportInterval: TimeInterval = 0
  var namePrefix: String?
  var manufacturerData: [ManufacturerFilter] = []
  var solicitedServices: [String] = []

  /// Every given criterion must match; within a list, any entry may.
  func matches(_ record: ScanRecord) -> Bool {
    if !services.isEmpty, !record.serviceUUIDs.contains(where: services.contains) {
      return false
    }
    if let namePrefix, !(record.name?.hasPrefix(namePrefix) ?? false) {
      return false
    }
    if !manufacturerData.isEmpty {
      return manufacturerData.contains { filter in
        record.manufacturerData[filter.companyId].map(filter.matches) ?? false
      }
    }
    return true
  }
}

/// The one CoreBluetooth scan that serves every session (plan §5.3). CoreBluetooth filters by
/// service only; names and manufacturer data are filtered in the core.
struct PlatformScan: Equatable {
  /// Nil scans for every peripheral.
  let services: [String]?
  let allowDuplicates: Bool
  let solicitedServices: [String]

  static func union(_ specs: [ScanSpec]) -> PlatformScan {
    let unfiltered = specs.contains { $0.services.isEmpty }
    return PlatformScan(
      services: unfiltered ? nil : Array(Set(specs.flatMap(\.services))).sorted(),
      allowDuplicates: specs.contains { $0.allowDuplicates },
      solicitedServices: Array(Set(specs.flatMap(\.solicitedServices))).sorted()
    )
  }

  var serviceUUIDs: [CBUUID]? {
    services?.map(CBUUID.init(string:))
  }

  var options: [String: Any] {
    var options: [String: Any] = [CBCentralManagerScanOptionAllowDuplicatesKey: allowDuplicates]
    if !solicitedServices.isEmpty {
      options[CBCentralManagerScanOptionSolicitedServiceUUIDsKey] = solicitedServices.map(CBUUID.init(string:))
    }
    return options
  }
}

/// Epoch milliseconds from monotonic time, so timestamps are comparable with `Date.now()` and never
/// go backwards within a process (plan §4.10).
struct EpochClock {
  let wallAtStartMs: Double
  /// Seconds, on the scheduler's clock.
  let monotonicAtStart: TimeInterval

  func epochMs(monotonic: TimeInterval) -> Double {
    wallAtStartMs + (monotonic - monotonicAtStart) * 1000
  }
}

extension CBUUID {
  /// Lowercase 128-bit form, the only form the JS API returns (plan §4.12).
  var fullUUIDString: String {
    let hex = data.map { String(format: "%02x", $0) }.joined()
    switch data.count {
    case 2:
      return "0000\(hex)-0000-1000-8000-00805f9b34fb"
    case 4:
      return "\(hex)-0000-1000-8000-00805f9b34fb"
    default:
      return uuidString.lowercased()
    }
  }
}

/// JS `ScanResult` (plan §5.3), parsed from CoreBluetooth's advertisement dictionary.
struct ScanRecord {
  let id: String
  let name: String?
  let rssi: Int
  let txPowerLevel: Int?
  let isConnectable: Bool?
  let serviceUUIDs: [String]
  let serviceData: [String: Data]
  /// Keyed by company id. CoreBluetooth reports one manufacturer-data structure per advertisement.
  let manufacturerData: [Int: Data]
  let timestamp: Double

  init(identifier: UUID, peripheralName: String?, advertisementData: [String: Any], rssi: Int, timestamp: Double) {
    id = identifier.uuidString
    // The advertised name, else the name iOS cached from the device's GAP service.
    name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheralName
    self.rssi = rssi
    txPowerLevel = (advertisementData[CBAdvertisementDataTxPowerLevelKey] as? NSNumber)?.intValue
    isConnectable = (advertisementData[CBAdvertisementDataIsConnectable] as? NSNumber)?.boolValue
    let advertised = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
    // Services iOS apps advertise from the background end up in the overflow area.
    let overflow = advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID] ?? []
    serviceUUIDs = (advertised + overflow).map(\.fullUUIDString)
    let data = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data] ?? [:]
    serviceData = Dictionary(data.map { ($0.key.fullUUIDString, $0.value) }) { first, _ in first }
    // The first two bytes are the company id, little endian.
    if let manufacturer = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data, manufacturer.count >= 2 {
      let bytes = [UInt8](manufacturer)
      manufacturerData = [Int(bytes[0]) | Int(bytes[1]) << 8: Data(manufacturer.dropFirst(2))]
    } else {
      manufacturerData = [:]
    }
    self.timestamp = timestamp
  }

  /// JS map keys are strings, so company ids become strings. iOS doesn't expose raw advertisements.
  var dictionary: [String: Any] {
    [
      "id": id,
      "name": name ?? NSNull(),
      "rssi": rssi,
      "txPowerLevel": txPowerLevel ?? NSNull(),
      "isConnectable": isConnectable ?? NSNull(),
      "serviceUUIDs": serviceUUIDs,
      "serviceData": serviceData,
      "manufacturerData": Dictionary(uniqueKeysWithValues: manufacturerData.map { (String($0.key), Data($0.value)) }),
      "rawAdvertisement": NSNull(),
      "timestamp": timestamp
    ]
  }
}
