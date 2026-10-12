import CoreBluetooth
import Foundation

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
