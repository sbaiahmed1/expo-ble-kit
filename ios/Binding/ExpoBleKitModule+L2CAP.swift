import ExpoModulesCore

// L2CAP channels and servers (P5-03): a peripheral's channels live on the engine's queue, a
// server and its channels on the peripheral queue (plan §4.7).
extension ExpoBleKitModule {
  func openL2CAPChannel(
    _ ref: PeripheralObject,
    _ psm: Int,
    _ timeoutMs: Double,
    _ operationId: Int?,
    _ promise: Promise
  ) {
    let engine = self.engine
    engine.queue.async {
      engine.openL2CAPChannel(ref.id, psm: psm, timeout: timeoutMs / 1000, operationId: operationId) { result in
        switch result {
        case let .success(channel):
          promise.resolve(L2CAPChannelObject(channel, queue: engine.queue))
        case let .failure(error):
          promise.reject(BleKitException(error))
        }
      }
    }
  }

  func publishL2CAPChannel(_ secure: Bool, _ promise: Promise) {
    do {
      try Self.checkAuthorization("An L2CAP server")
    } catch {
      return promise.reject(error)
    }
    peripheralQueue.async {
      self.sharedL2CAPPublisher().publish(secure: secure) { result in
        switch result {
        case let .success(server):
          promise.resolve(L2CAPServerObject(server, queue: self.peripheralQueue))
        case let .failure(error):
          promise.reject(BleKitException(error))
        }
      }
    }
  }

  /// On the peripheral queue. Shares the manager with the GATT server and the advertiser.
  private func sharedL2CAPPublisher() -> L2CAPPublisher {
    if let l2capPublisher {
      return l2capPublisher
    }
    let scheduler = QueueScheduler(queue: peripheralQueue)
    let publisher = L2CAPPublisher(manager: sharedPeripheralManager(), scheduler: scheduler)
    l2capPublisher = publisher
    return publisher
  }

  func l2capServerClass() -> ClassDefinition {
    Class(L2CAPServerObject.self) {
      Constructor { () -> L2CAPServerObject in
        throw Exception(name: "BleError", description: "Use BleManager.publishL2CAPChannel()", code: "INVALID_ARGUMENT")
      }

      Property("psm") { (ref: L2CAPServerObject) in ref.server.psm }

      Function("takeChannel") { (ref: L2CAPServerObject, channelId: Int) -> L2CAPChannelObject? in ref.take(channelId) }

      AsyncFunction("close") { (ref: L2CAPServerObject, promise: Promise) in
        self.peripheralQueue.async {
          ref.close()
          promise.resolve(nil)
        }
      }
    }
  }

  func l2capChannelClass() -> ClassDefinition {
    Class(L2CAPChannelObject.self) {
      Constructor { () -> L2CAPChannelObject in
        throw Exception(name: "BleError", description: "Use openL2CAPChannel()", code: "INVALID_ARGUMENT")
      }

      Property("psm") { (ref: L2CAPChannelObject) in ref.channel.psm }
      Property("peerId") { (ref: L2CAPChannelObject) in ref.channel.peerId }
      Property("isOpen") { (ref: L2CAPChannelObject) in ref.channel.isOpen }

      AsyncFunction("write") { (ref: L2CAPChannelObject, data: Data, promise: Promise) in
        ref.queue.async {
          ref.channel.write(data) { error in
            if let error { promise.reject(BleKitException(error)) } else { promise.resolve(nil) }
          }
        }
      }

      Function("receive") { (ref: L2CAPChannelObject) in
        ref.queue.async { ref.channel.receive() }
      }

      AsyncFunction("close") { (ref: L2CAPChannelObject, promise: Promise) in
        ref.queue.async {
          ref.channel.close(nil)
          promise.resolve(nil)
        }
      }
    }
  }
}
