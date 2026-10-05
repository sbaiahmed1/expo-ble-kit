import CoreBluetooth
import Foundation

struct Failure: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}

/// What the checks need from test-peripherals/profile.json, the single source of the test profile.
struct Profile {
  let service: CBUUID
  let staticRead: Data
  let longRead: Data
  let maxFrameSize: Int
  /// ATT errors an invalid CONTROL command may answer: the profile's, then the example app's (its
  /// API has no application errors, so it answers Request Not Supported and Invalid Length).
  let unknownOpcodeErrors: [Int]
  let invalidParameterErrors: [Int]
  private let characteristics: [String: CBUUID]
  private let opcodes: [String: UInt8]

  init(path: String) throws {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard
      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let services = json["services"] as? [[String: Any]],
      let test = services.first(where: { $0["key"] as? String == "TEST" }),
      let uuid = test["uuid"] as? String,
      let list = test["characteristics"] as? [[String: Any]],
      let stream = json["stream"] as? [String: Any],
      let control = json["control"] as? [String: Any],
      let commands = control["commands"] as? [[String: Any]],
      let errors = control["errors"] as? [String: [String: Any]]
    else { throw Failure("\(path) isn't the test profile") }

    service = CBUUID(string: uuid)
    var byKey: [String: CBUUID] = [:]
    var values: [String: Data] = [:]
    for characteristic in list {
      guard let key = characteristic["key"] as? String, let id = characteristic["uuid"] as? String else { continue }
      byKey[key] = CBUUID(string: id)
      values[key] = Self.value(characteristic["value"])
    }
    characteristics = byKey
    guard let staticValue = values["STATIC_READ"], let longValue = values["LONG_READ"] else {
      throw Failure("the profile has no STATIC_READ or LONG_READ value")
    }
    staticRead = staticValue
    longRead = longValue
    maxFrameSize = stream["maxFrameSize"] as? Int ?? 512
    opcodes = Dictionary(uniqueKeysWithValues: commands.compactMap { command in
      guard let name = command["name"] as? String, let opcode = command["opcode"] as? Int else { return nil }
      return (name, UInt8(opcode))
    })
    unknownOpcodeErrors = [errors["unknownOpcode"]?["attError"] as? Int ?? 0x80, 0x06]
    invalidParameterErrors = [errors["invalidParameters"]?["attError"] as? Int ?? 0x81, 0x0D]
  }

  func uuid(_ key: String) throws -> CBUUID {
    guard let uuid = characteristics[key] else { throw Failure("no \(key) in the profile") }
    return uuid
  }

  func opcode(_ name: String) throws -> UInt8 {
    guard let opcode = opcodes[name] else { throw Failure("no CONTROL command \(name) in the profile") }
    return opcode
  }

  /// An opcode the profile doesn't define.
  var unknownOpcode: UInt8 {
    (UInt8(0x10)...UInt8(0xFF)).first { !opcodes.values.contains($0) } ?? 0xFF
  }

  /// A profile value: `{ "pattern": { length, multiplier, offset, modulus } }`, `{ "hex" }` or `{ "utf8" }`.
  private static func value(_ any: Any?) -> Data? {
    guard let value = any as? [String: Any] else { return nil }
    if let pattern = value["pattern"] as? [String: Int],
      let length = pattern["length"], let multiplier = pattern["multiplier"],
      let offset = pattern["offset"], let modulus = pattern["modulus"] {
      return Data((0..<length).map { UInt8((($0 * multiplier) + offset) % modulus) })
    }
    if let hex = value["hex"] as? String {
      let digits = Array(hex.filter(\.isHexDigit))
      let pairs = stride(from: 0, to: digits.count - 1, by: 2).map { String(digits[$0...$0 + 1]) }
      return Data(pairs.compactMap { UInt8($0, radix: 16) })
    }
    return (value["utf8"] as? String).map { Data($0.utf8) }
  }
}
