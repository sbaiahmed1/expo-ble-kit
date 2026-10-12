import CoreBluetooth
import Foundation

// A Mac as an L2CAP echo peripheral (P5-03): see ../README.md. It advertises the TEST service,
// serves the PSM of its echo server in L2CAP_PSM, and sends every byte a channel receives back.
// Arguments: <log file> <profile.json> [seconds to run]. run.sh builds and starts it.

enum Log {
  private static var file: FileHandle?
  private static let start = Date()

  static func open(_ path: String) {
    FileManager.default.createFile(atPath: path, contents: nil)
    file = FileHandle(forWritingAtPath: path)
  }

  static func write(_ message: String) {
    let line = String(format: "%7.3f ", Date().timeIntervalSince(start)) + message + "\n"
    file?.write(Data(line.utf8))
    try? file?.synchronize()
  }
}

struct Failure: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}

/// One channel: everything it reads goes into `pending`, which goes back out as the stream takes it.
final class EchoChannel: NSObject, StreamDelegate, @unchecked Sendable {
  private let channel: CBL2CAPChannel
  private var pending = Data()
  private var received = 0
  private var sent = 0
  private let start = Date()
  var onEnd: ((EchoChannel) -> Void)?

  init(_ channel: CBL2CAPChannel) {
    self.channel = channel
  }

  func start(on queue: DispatchQueue) {
    channel.inputStream.delegate = self
    channel.outputStream.delegate = self
    CFReadStreamSetDispatchQueue(channel.inputStream, queue)
    CFWriteStreamSetDispatchQueue(channel.outputStream, queue)
    channel.inputStream.open()
    channel.outputStream.open()
  }

  func stream(_ aStream: Stream, handle eventCode: Stream.Event) {
    switch eventCode {
    case .hasBytesAvailable: read()
    case .hasSpaceAvailable: send()
    case .endEncountered, .errorOccurred: end(aStream.streamError)
    default: break
    }
  }

  private func read() {
    var buffer = [UInt8](repeating: 0, count: 4096)
    while channel.inputStream.hasBytesAvailable {
      let count = channel.inputStream.read(&buffer, maxLength: buffer.count)
      if count <= 0 { break }
      pending.append(contentsOf: buffer[0..<count])
      received += count
    }
    send()
  }

  private func send() {
    while !pending.isEmpty, channel.outputStream.hasSpaceAvailable {
      let count = pending.prefix(4096).withUnsafeBytes { bytes in
        channel.outputStream.write(bytes.bindMemory(to: UInt8.self).baseAddress!, maxLength: bytes.count)
      }
      if count <= 0 { break }
      pending.removeFirst(count)
      sent += count
    }
  }

  private func end(_ error: Error?) {
    for stream in [channel.inputStream as Stream, channel.outputStream as Stream] {
      stream.delegate = nil
      stream.close()
    }
    let seconds = Date().timeIntervalSince(start)
    let reason = error.map { ": \($0.localizedDescription)" } ?? ""
    Log.write(String(format: "channel closed after %.1f s: %d bytes in, %d back%@", seconds, received, sent, reason))
    onEnd?(self)
  }
}

final class EchoPeripheral: NSObject, CBPeripheralManagerDelegate, @unchecked Sendable {
  let queue = DispatchQueue(label: "blekit.peripheral")
  private let service: CBUUID
  private let psmCharacteristic: CBUUID
  private var manager: CBPeripheralManager?
  private var channels: [EchoChannel] = []

  init(profile path: String) throws {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard
      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let services = json["services"] as? [[String: Any]],
      let test = services.first(where: { $0["key"] as? String == "TEST" }),
      let uuid = test["uuid"] as? String,
      let characteristics = test["characteristics"] as? [[String: Any]],
      let psm = characteristics.first(where: { $0["key"] as? String == "L2CAP_PSM" })?["uuid"] as? String
    else { throw Failure("profile.json has no TEST service with L2CAP_PSM") }
    service = CBUUID(string: uuid)
    psmCharacteristic = CBUUID(string: psm)
  }

  func start() {
    queue.async { self.manager = CBPeripheralManager(delegate: self, queue: self.queue) }
  }

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
    Log.write(String(format: "echo server on PSM 0x%x", PSM))
    let value = Data([UInt8(PSM & 0xFF), UInt8(PSM >> 8)])
    let characteristic = CBMutableCharacteristic(
      type: psmCharacteristic,
      properties: .read,
      value: value,
      permissions: .readable
    )
    let test = CBMutableService(type: service, primary: true)
    test.characteristics = [characteristic]
    peripheral.add(test)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    if let error {
      Log.write("FAILED: adding the TEST service: \(error.localizedDescription)")
      exit(1)
    }
    peripheral.startAdvertising([
      CBAdvertisementDataLocalNameKey: "BleKit-Mac",
      CBAdvertisementDataServiceUUIDsKey: [self.service]
    ])
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    if let error {
      Log.write("FAILED: advertising: \(error.localizedDescription)")
      exit(1)
    }
    Log.write("advertising the TEST service as BleKit-Mac: waiting for channels")
  }

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

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
  FileHandle.standardError.write(Data("usage: BleKitPeripheral <log> <profile.json> [seconds]\n".utf8))
  exit(2)
}
Log.open(arguments[1])
do {
  let peripheral = try EchoPeripheral(profile: arguments[2])
  peripheral.start()
  let seconds = arguments.count > 3 ? Double(arguments[3]) ?? 600 : 600
  DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
    Log.write("DONE: stopped after \(Int(seconds)) s")
    exit(0)
  }
  dispatchMain()
} catch {
  Log.write("FAILED: \(error)")
  exit(1)
}
