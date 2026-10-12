import CoreBluetooth
import Foundation

// Writes: the echo, the sink, and CONTROL's commands (profile.json control.commands).

extension TestPeripheral {
  typealias Command = (TestPeripheral, [UInt32], CBCentral) -> CBATTError.Code

  /// CONTROL's commands by name.
  static let commands: [String: Command] = [
    "SET_STREAM": { peripheral, params, _ in peripheral.setStream(rateHz: Int(params[0]), frameSize: Int(params[1])) },
    // CoreBluetooth gives a peripheral no way to end a connection.
    "DISCONNECT_AFTER": { _, _, _ in .requestNotSupported },
    "TOGGLE_SECONDARY_SERVICE": { peripheral, _, _ in
      peripheral.toggleSecondary()
      return .success
    },
    "RESET_COUNTERS": { peripheral, _, _ in
      peripheral.sinkCount = 0
      peripheral.streamSeq = 0
      peripheral.indicateSeq = 0
      return .success
    },
    "SEND_INDICATIONS": { peripheral, params, central in
      for _ in 0..<params[0] {
        peripheral.enqueue("INDICATE", uint32(peripheral.indicateSeq), to: [central])
        peripheral.indicateSeq &+= 1
      }
      return .success
    }
  ]

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    guard let first = requests.first else { return }
    // Writes without response (SINK_NO_RSP) get no answer.
    let sinkOnly = requests.allSatisfy { keys[$0.characteristic.uuid] == "SINK_NO_RSP" }
    let result = handleWrites(requests)
    if !sinkOnly { peripheral.respond(to: first, withResult: result) }
  }

  /// A long write arrives as several requests with offsets; they are applied together or not at all.
  private func handleWrites(_ requests: [CBATTRequest]) -> CBATTError.Code {
    var values: [String: (data: Data, central: CBCentral)] = [:]
    for request in requests {
      let key = keys[request.characteristic.uuid] ?? ""
      var current = values[key]?.data ?? Data()
      guard request.offset == current.count else { return .invalidOffset }
      current.append(request.value ?? Data())
      values[key] = (current, request.central)
    }
    for (key, write) in values {
      let result = apply(key, write.data, from: write.central)
      if result != .success { return result }
    }
    return .success
  }

  private func apply(_ key: String, _ data: Data, from central: CBCentral) -> CBATTError.Code {
    switch key {
    case "ECHO_WRITE":
      guard data.count <= 512 else { return .invalidAttributeValueLength }
      echoValue = data
    case "SINK_NO_RSP":
      sinkCount = sinkCount &+ UInt32(truncatingIfNeeded: data.count)
      scheduleSinkNotification()
    case "CONTROL":
      return control(data, from: central)
    default:
      return .writeNotPermitted
    }
    return .success
  }

  private func attError(_ code: Int) -> CBATTError.Code {
    CBATTError.Code(rawValue: code) ?? .unlikelyError
  }

  private func control(_ data: Data, from central: CBCentral) -> CBATTError.Code {
    guard let opcode = data.first, let command = profile.commands[opcode], let run = Self.commands[command.name] else {
      return attError(profile.unknownOpcodeError)
    }
    let bytes = [UInt8](data.dropFirst())
    guard bytes.count == command.sizes.reduce(0, +) else { return attError(profile.invalidParametersError) }
    var params: [UInt32] = []
    var index = 0
    for size in command.sizes {
      params.append(bytes[index..<index + size].reversed().reduce(0) { $0 << 8 | UInt32($1) })
      index += size
    }
    Log.write("CONTROL \(command.name) \(params.map(String.init).joined(separator: " "))")
    return run(self, params, central)
  }

  func toggleSecondary() {
    guard let manager, let service = services["SECONDARY"] else { return }
    // CoreBluetooth sends the Service Changed indication itself.
    if secondaryAdded {
      manager.remove(service)
    } else {
      manager.add(service)
    }
    secondaryAdded.toggle()
    Log.write("SECONDARY service \(secondaryAdded ? "added" : "removed")")
  }

  /// SET_STREAM; rate 0 stops the stream.
  func setStream(rateHz: Int, frameSize: Int) -> CBATTError.Code {
    if rateHz != 0, !(1...1000 ~= rateHz && profile.minFrameSize...profile.maxFrameSize ~= frameSize) {
      return attError(profile.invalidParametersError)
    }
    startStream(rateHz: rateHz, frameSize: frameSize)
    return .success
  }
}
