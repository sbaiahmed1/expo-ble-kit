import CoreBluetooth
import Foundation
@testable import BleKitCore

/// Scriptable `L2CAPChannelLike` (P5-03): the test plays the peer and the streams' buffers.
final class FakeL2CAPChannel: L2CAPChannelLike {
  let psm: CBL2CAPPSM
  let peerIdentifier: UUID
  weak var events: L2CAPChannelEvents?
  private(set) var opened = false
  private(set) var closed = false
  /// Bytes the peer sent that the input stream holds.
  private(set) var incoming = Data()
  /// How many more bytes the output stream takes; `makeRoom` adds to it.
  var room = Int.max
  var failsWrites = false
  /// What the output stream took, and each write call's size.
  private(set) var written = Data()
  private(set) var writeSizes: [Int] = []

  init(psm: CBL2CAPPSM, peer: UUID = UUID()) {
    self.psm = psm
    peerIdentifier = peer
  }

  func open() {
    opened = true
  }

  var hasBytesAvailable: Bool { !incoming.isEmpty }

  func read(maxLength: Int) -> Data? {
    let chunk = Data(incoming.prefix(maxLength))
    incoming.removeFirst(chunk.count)
    return chunk
  }

  var hasSpaceAvailable: Bool { room > 0 }

  func write(_ data: Data) -> Int {
    if failsWrites {
      return -1
    }
    let count = min(data.count, room)
    room -= count
    written.append(data.prefix(count))
    writeSizes.append(count)
    return count
  }

  func close() {
    closed = true
  }

  /// The peer sends bytes.
  func send(_ data: Data) {
    incoming.append(data)
    events?.channelHasBytesAvailable(self)
  }

  /// The output stream drained: it takes `bytes` more.
  func makeRoom(_ bytes: Int) {
    room = bytes
    events?.channelHasSpaceAvailable(self)
  }

  /// A stream ended (the peer closed it) or failed.
  func end(error: Error? = nil) {
    events?.channelEnded(self, error: error)
  }
}
