import Foundation

/// One open L2CAP channel (plan §5.5 L2CAP rules, P5-03). Reading starts with `receive()`: until
/// then nothing is read, and L2CAP's credits hold the peer back. Writes keep their order and go to
/// the output stream as it takes them; a write it takes nothing of for `writeStallTimeout` closes
/// the channel.
///
/// Threading (plan §4.7): on the queue its streams report to, the engine's for channels the app
/// opened and the peripheral queue for published ones. `isOpen` is safe from any thread.
final class L2CAPChannel: L2CAPChannelEvents {
  /// A write the stream takes nothing of for this long closes the channel (plan §5.5).
  static let writeStallTimeout: TimeInterval = 10
  /// The most one read takes from the input stream.
  static let readSize = 4096

  let psm: Int
  /// The peripheral's id, or the central's on a published channel.
  let peerId: String
  var onData: ((Data) -> Void)?
  /// Once; nil when either side closed the channel.
  var onClose: ((CoreError?) -> Void)?
  /// Its owner (a session or a server) forgets it.
  var onEnded: ((L2CAPChannel) -> Void)?

  private let channel: L2CAPChannelLike
  private let scheduler: Scheduling
  private let lock = NSLock()
  private var open = true
  private var receiving = false
  private var closeError: CoreError?
  private var writes: [PendingWrite] = []
  private var stall: CancellableWork?

  private struct PendingWrite {
    let data: Data
    var sent = 0
    let completion: (CoreError?) -> Void
  }

  init(channel: L2CAPChannelLike, peerId: String, scheduler: Scheduling) {
    self.channel = channel
    self.peerId = peerId
    self.scheduler = scheduler
    psm = Int(channel.psm)
    channel.events = self
    channel.open()
  }

  /// A published snapshot (plan §4.7).
  var isOpen: Bool {
    lock.lock()
    defer { lock.unlock() }
    return open
  }

  /// Starts reading.
  func receive() {
    guard !receiving, isOpen else {
      return
    }
    receiving = true
    drain()
  }

  /// Completes once the stream took every byte.
  func write(_ data: Data, completion: @escaping (CoreError?) -> Void) {
    guard isOpen else {
      return completion(writeError)
    }
    guard !data.isEmpty else {
      return completion(nil)
    }
    writes.append(PendingWrite(data: data, completion: completion))
    if stall == nil {
      armStall()
    }
    pump()
  }

  /// Closes the channel: `error` goes to `onClose` and the pending writes; nil when a side closed it.
  func close(_ error: CoreError?) {
    guard isOpen else {
      return
    }
    lock.lock()
    open = false
    lock.unlock()
    closeError = error
    stall?.cancel()
    stall = nil
    channel.close()
    let failed = writes
    writes.removeAll()
    failed.forEach { $0.completion(writeError) }
    onEnded?(self)
    onClose?(error)
  }

  // MARK: L2CAPChannelEvents

  func channelHasBytesAvailable(_ channel: L2CAPChannelLike) {
    drain()
  }

  func channelHasSpaceAvailable(_ channel: L2CAPChannelLike) {
    pump()
  }

  func channelEnded(_ channel: L2CAPChannelLike, error: Error?) {
    close(error.map { failure in
      let mapped = CoreBluetoothErrorMapping.coreError(from: failure)
      return CoreError(
        .l2capFailed,
        "L2CAP channel \(psm) failed: \(mapped.message)",
        nativeDomain: mapped.nativeDomain,
        nativeCode: mapped.nativeCode
      )
    })
  }

  // MARK: Private

  private var writeError: CoreError {
    closeError ?? CoreError(.l2capFailed, "L2CAP channel \(psm) is closed")
  }

  /// Reads while there are bytes and JS asked for them.
  private func drain() {
    while isOpen, receiving, channel.hasBytesAvailable {
      guard let data = channel.read(maxLength: Self.readSize) else {
        return close(CoreError(.l2capFailed, "Reading L2CAP channel \(psm) failed"))
      }
      if data.isEmpty {
        return
      }
      onData?(data)
    }
  }

  /// Writes while the stream takes bytes.
  private func pump() {
    while isOpen, let first = writes.first, channel.hasSpaceAvailable {
      let count = channel.write(first.data.dropFirst(first.sent))
      if count < 0 {
        return close(CoreError(.l2capFailed, "Writing to L2CAP channel \(psm) failed"))
      }
      if count == 0 {
        break
      }
      armStall()
      writes[0].sent += count
      if writes[0].sent == first.data.count {
        writes.removeFirst().completion(nil)
      }
    }
    if writes.isEmpty {
      stall?.cancel()
      stall = nil
    }
  }

  private func armStall() {
    stall?.cancel()
    stall = scheduler.schedule(after: Self.writeStallTimeout) { [weak self] in
      guard let self else {
        return
      }
      stall = nil
      let seconds = Int(Self.writeStallTimeout)
      let message = "L2CAP channel \(psm) took no bytes for \(seconds) s: the peer stopped reading"
      close(CoreError(.operationTimeout, message))
    }
  }
}
