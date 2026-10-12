import CoreBluetooth
import Foundation

/// `L2CAPChannelLike` over a `CBL2CAPChannel` (P5-03). Holding it keeps the channel open. Its
/// streams report on `queue`, the queue of the manager the channel came from, so the core sees
/// stream events where it sees every other callback (plan §4.7).
final class CBL2CAPChannelAdapter: NSObject, L2CAPChannelLike, StreamDelegate {
  private let channel: CBL2CAPChannel
  private let queue: DispatchQueue
  weak var events: L2CAPChannelEvents?

  init(_ channel: CBL2CAPChannel, queue: DispatchQueue) {
    self.channel = channel
    self.queue = queue
  }

  var psm: CBL2CAPPSM { channel.psm }
  var peerIdentifier: UUID { channel.peer.identifier }

  func open() {
    channel.inputStream.delegate = self
    channel.outputStream.delegate = self
    // Stream events on a dispatch queue instead of a run loop.
    CFReadStreamSetDispatchQueue(channel.inputStream, queue)
    CFWriteStreamSetDispatchQueue(channel.outputStream, queue)
    channel.inputStream.open()
    channel.outputStream.open()
  }

  var hasBytesAvailable: Bool { channel.inputStream.hasBytesAvailable }

  func read(maxLength: Int) -> Data? {
    var buffer = [UInt8](repeating: 0, count: maxLength)
    let count = channel.inputStream.read(&buffer, maxLength: maxLength)
    return count < 0 ? nil : Data(buffer.prefix(count))
  }

  var hasSpaceAvailable: Bool { channel.outputStream.hasSpaceAvailable }

  func write(_ data: Data) -> Int {
    data.withUnsafeBytes { bytes in
      guard let base = bytes.bindMemory(to: UInt8.self).baseAddress else {
        return 0
      }
      return channel.outputStream.write(base, maxLength: bytes.count)
    }
  }

  func close() {
    for stream in [channel.inputStream as Stream, channel.outputStream as Stream] {
      stream.delegate = nil
      stream.close()
    }
    CFReadStreamSetDispatchQueue(channel.inputStream, nil)
    CFWriteStreamSetDispatchQueue(channel.outputStream, nil)
  }

  func stream(_ aStream: Stream, handle eventCode: Stream.Event) {
    switch eventCode {
    case .hasBytesAvailable:
      events?.channelHasBytesAvailable(self)
    case .hasSpaceAvailable:
      events?.channelHasSpaceAvailable(self)
    case .endEncountered:
      events?.channelEnded(self, error: nil)
    case .errorOccurred:
      events?.channelEnded(self, error: aStream.streamError)
    default:
      break
    }
  }
}
