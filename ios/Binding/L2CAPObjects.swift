import ExpoModulesCore

/// The JS handle of an L2CAP channel (P5-03), with events `data` and `close`. Holds no BLE state:
/// `channel` does, on `queue` (the engine's, or the peripheral queue for a published channel).
final class L2CAPChannelObject: SharedObject, @unchecked Sendable {
  let channel: L2CAPChannel
  let queue: DispatchQueue

  init(_ channel: L2CAPChannel, queue: DispatchQueue) {
    self.channel = channel
    self.queue = queue
    super.init()
    // Weak: the channel keeps these closures, and JS keeps this object.
    channel.onData = { [weak self] data in
      var event = L2CAPDataEventRecord()
      event.data = data
      self?.emit(event: "data", payload: event)
    }
    channel.onClose = { [weak self] error in
      var event = L2CAPCloseEventRecord()
      event.code = error?.code.rawValue
      event.message = error?.jsMessage
      self?.emit(event: "close", payload: event)
    }
  }
}

/// The JS handle of an L2CAP server (P5-03). Each accepted channel waits here, announced by a
/// `channel` event, until JS takes it.
final class L2CAPServerObject: SharedObject, @unchecked Sendable {
  let server: L2CAPServer
  private let lock = NSLock()
  private var announced: [Int: L2CAPChannelObject] = [:]
  private var nextId = 1

  init(_ server: L2CAPServer, queue: DispatchQueue) {
    self.server = server
    super.init()
    server.onChannel = { [weak self] channel in
      guard let self else {
        return channel.close(nil)
      }
      lock.lock()
      let id = nextId
      nextId += 1
      announced[id] = L2CAPChannelObject(channel, queue: queue)
      lock.unlock()
      var event = L2CAPChannelEventRecord()
      event.channelId = id
      emit(event: "channel", payload: event)
    }
  }

  /// The channel announced as `id`; nil once taken, or when it closed meanwhile.
  func take(_ id: Int) -> L2CAPChannelObject? {
    lock.lock()
    defer { lock.unlock() }
    return announced.removeValue(forKey: id).flatMap { $0.channel.isOpen ? $0 : nil }
  }

  /// On the peripheral queue.
  func close() {
    server.close()
    lock.lock()
    announced.removeAll()
    lock.unlock()
  }
}

struct L2CAPDataEventRecord: Record {
  @Field var data = Data()
}

/// `code` and `message` are nil when either side closed the channel.
struct L2CAPCloseEventRecord: Record {
  @Field var code: String?
  @Field var message: String?
}

struct L2CAPChannelEventRecord: Record {
  @Field var channelId: Int = 0
}
