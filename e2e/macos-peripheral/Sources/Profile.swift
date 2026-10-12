import CoreBluetooth
import Foundation

/// What this peripheral needs from profile.json.
struct Profile {
  struct Characteristic {
    let key: String
    let uuid: CBUUID
    let properties: [String]
    let permissions: [String]
    let value: Data?
    let userDescription: String?
    let spec: [String: Any]
  }

  struct Service {
    let key: String
    let uuid: CBUUID
    let toggled: Bool
    let characteristics: [Characteristic]
  }

  struct Command {
    let opcode: UInt8
    let name: String
    /// Byte size of each parameter.
    let sizes: [Int]
  }

  let localName: String
  let services: [Service]
  let advertisedServices: [CBUUID]
  let minFrameSize: Int
  let maxFrameSize: Int
  let commands: [UInt8: Command]
  let unknownOpcodeError: Int
  let invalidParametersError: Int

  init(path: String) throws {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let services = json["services"] as? [[String: Any]],
          let advertising = json["advertising"] as? [String: Any],
          let stream = json["stream"] as? [String: Any],
          let control = json["control"] as? [String: Any],
          let commands = control["commands"] as? [[String: Any]],
          let errors = control["errors"] as? [String: [String: Any]]
    else { throw Failure("profile.json is missing services, advertising, stream or control") }

    localName = advertising["localName"] as? String ?? "BleKit-Test"
    let advertisingData = advertising["advertisingData"] as? [String: Any] ?? [:]
    advertisedServices = ((advertisingData["completeServiceUuids128"] as? [String] ?? [])
      + (advertisingData["completeServiceUuids16"] as? [String] ?? [])).map { CBUUID(string: $0) }
    minFrameSize = stream["minFrameSize"] as? Int ?? 4
    maxFrameSize = stream["maxFrameSize"] as? Int ?? 512
    unknownOpcodeError = errors["unknownOpcode"]?["attError"] as? Int ?? 0x80
    invalidParametersError = errors["invalidParameters"]?["attError"] as? Int ?? 0x81

    self.commands = Self.commands(commands)
    self.services = try services.map(Self.service)
  }

  private static func commands(_ specs: [[String: Any]]) -> [UInt8: Command] {
    var table: [UInt8: Command] = [:]
    for command in specs {
      guard let opcode = command["opcode"] as? Int, let name = command["name"] as? String else { continue }
      let params = command["params"] as? [[String: Any]] ?? []
      let sizes = params.map { ($0["type"] as? String) == "uint32le" ? 4 : 2 }
      table[UInt8(opcode)] = Command(opcode: UInt8(opcode), name: name, sizes: sizes)
    }
    return table
  }

  private static func service(_ spec: [String: Any]) throws -> Service {
    guard let key = spec["key"] as? String, let uuid = spec["uuid"] as? String else {
      throw Failure("a service in profile.json has no key or uuid")
    }
    let characteristics = (spec["characteristics"] as? [[String: Any]] ?? []).compactMap(characteristic)
    return Service(
      key: key,
      uuid: CBUUID(string: uuid),
      toggled: (spec["presence"] as? String) == "toggled",
      characteristics: characteristics
    )
  }

  private static func characteristic(_ spec: [String: Any]) -> Characteristic? {
    guard let key = spec["key"] as? String, let uuid = spec["uuid"] as? String else { return nil }
    let description = (spec["descriptors"] as? [[String: Any]])?
      .first { ($0["uuid"] as? String)?.hasPrefix("00002901") == true }
      .flatMap { ($0["value"] as? [String: Any])?["utf8"] as? String }
    return Characteristic(
      key: key,
      uuid: CBUUID(string: uuid),
      properties: spec["properties"] as? [String] ?? [],
      permissions: spec["permissions"] as? [String] ?? [],
      value: decode(spec["value"]),
      userDescription: description,
      spec: spec
    )
  }

  func characteristic(_ key: String) -> Characteristic? {
    services.lazy.flatMap(\.characteristics).first { $0.key == key }
  }

  /// A profile value: {"pattern": {...}}, {"utf8": ...} or {"hex": ...}.
  static func decode(_ value: Any?) -> Data? {
    guard let value = value as? [String: Any] else { return nil }
    if let pattern = value["pattern"] as? [String: Int],
       let length = pattern["length"], let multiplier = pattern["multiplier"],
       let offset = pattern["offset"], let modulus = pattern["modulus"] {
      return Data((0..<length).map { UInt8((($0 * multiplier) + offset) % modulus) })
    }
    if let text = value["utf8"] as? String { return Data(text.utf8) }
    if let hex = value["hex"] as? String {
      var bytes = [UInt8]()
      var index = hex.startIndex
      while index < hex.endIndex, let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) {
        if let byte = UInt8(hex[index..<next], radix: 16) { bytes.append(byte) }
        index = next
      }
      return Data(bytes)
    }
    return nil
  }
}

func uint32(_ value: UInt32) -> Data {
  withUnsafeBytes(of: value.littleEndian) { Data($0) }
}

/// STREAM's frame: the uint32 LE sequence, then p[j] = (seq + j) % 256.
func streamFrame(_ seq: UInt32, size: Int) -> Data {
  var frame = uint32(seq)
  frame.append(contentsOf: (0..<max(0, size - 4)).map { UInt8((Int(seq % 256) + $0) % 256) })
  return frame
}
