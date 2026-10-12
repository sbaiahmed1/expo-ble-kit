import CoreBluetooth
import Foundation

/// P5-03: sends `data` over an L2CAP channel while the echo comes back, on the central's queue.
final class Echo: NSObject, StreamDelegate, @unchecked Sendable {
  private let channel: CBL2CAPChannel
  private let data: Data
  private let start = Date()
  private var sent = 0
  private var continuation: CheckedContinuation<Void, Error>?
  private(set) var received = Data()
  private(set) var sentSeconds: Double?
  private(set) var echoedSeconds: Double?

  init(channel: CBL2CAPChannel, data: Data) {
    self.channel = channel
    self.data = data
  }

  /// Until every byte came back. A stream error, the server closing the channel or `timeout` fail it.
  func run(on queue: DispatchQueue, timeout: Double) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queue.async {
        self.continuation = continuation
        self.channel.inputStream.delegate = self
        self.channel.outputStream.delegate = self
        CFReadStreamSetDispatchQueue(self.channel.inputStream, queue)
        CFWriteStreamSetDispatchQueue(self.channel.outputStream, queue)
        self.channel.inputStream.open()
        self.channel.outputStream.open()
        queue.asyncAfter(deadline: .now() + timeout) {
          let progress = "\(self.sent) sent, \(self.received.count) back"
          self.finish(Failure("echo incomplete after \(Int(timeout)) s: \(progress)"))
        }
      }
    }
  }

  /// On the central's queue.
  func close() {
    for stream in [channel.inputStream as Stream, channel.outputStream as Stream] {
      stream.delegate = nil
      stream.close()
    }
  }

  func stream(_ aStream: Stream, handle eventCode: Stream.Event) {
    switch eventCode {
    case .hasSpaceAvailable: send()
    case .hasBytesAvailable: receive()
    case .errorOccurred: finish(aStream.streamError ?? Failure("stream error"))
    case .endEncountered: finish(Failure("the server closed the channel after \(received.count) bytes"))
    default: break
    }
  }

  private func send() {
    while sent < data.count, channel.outputStream.hasSpaceAvailable {
      let count = data[sent...].prefix(4096).withUnsafeBytes { bytes in
        channel.outputStream.write(bytes.bindMemory(to: UInt8.self).baseAddress!, maxLength: bytes.count)
      }
      if count <= 0 { break }
      sent += count
    }
    if sent == data.count, sentSeconds == nil { sentSeconds = Date().timeIntervalSince(start) }
  }

  private func receive() {
    var buffer = [UInt8](repeating: 0, count: 4096)
    while channel.inputStream.hasBytesAvailable {
      let count = channel.inputStream.read(&buffer, maxLength: buffer.count)
      if count <= 0 { break }
      received.append(contentsOf: buffer[0..<count])
    }
    if received.count >= data.count {
      echoedSeconds = Date().timeIntervalSince(start)
      finish(nil)
    }
  }

  private func finish(_ error: Error?) {
    guard let continuation else { return }
    self.continuation = nil
    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
  }
}

extension Central {
  /// P5-03: 1 MB each way over an L2CAP channel to the echo server whose PSM L2CAP_PSM tells.
  func checkL2CAPEcho() async throws {
    guard (try? characteristic("L2CAP_PSM")) != nil else {
      return Log.write("SKIP L2CAP: the server has no L2CAP_PSM")
    }
    let value: Data
    do {
      value = try await read("L2CAP_PSM")
    } catch let error as CBATTError {
      // The Checks tab's server runs no echo server; the Peripheral tab's does.
      return Log.write("SKIP L2CAP: L2CAP_PSM refused (ATT 0x\(String(error.code.rawValue, radix: 16)))")
    }
    guard value.count == 2 else { return check(false, "L2CAP_PSM has \(value.count) bytes") }
    let psm = CBL2CAPPSM(value[0]) | CBL2CAPPSM(value[1]) << 8
    let channel = try await call(opening, "open L2CAP channel \(psm)", timeout: 30) {
      self.peripheral?.openL2CAPChannel(psm)
    }
    let data = Data((0..<(1 << 20)).map { UInt8(($0 * 31 + 7) % 251) })
    let echo = Echo(channel: channel, data: data)
    defer { queue.sync { echo.close() } }
    try await echo.run(on: queue, timeout: 120)
    let (sent, echoed, same) = queue.sync { (echo.sentSeconds ?? 0, echo.echoedSeconds ?? 0, echo.received == data) }
    let rate = { (seconds: Double) in Double(data.count) / 1024 / max(seconds, 0.001) }
    check(same, String(
      format: "L2CAP echo of 1024 KB each way over PSM 0x%x: sent in %.1f s (%.0f KB/s), echoed in %.1f s (%.0f KB/s)",
      psm, sent, rate(sent), echoed, rate(echoed)
    ))
  }
}
