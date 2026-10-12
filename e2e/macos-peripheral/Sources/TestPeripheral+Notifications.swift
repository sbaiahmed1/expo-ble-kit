import CoreBluetooth
import Foundation

// Subscriptions and notifications, sent as the transmit queue takes them (peripheralManagerIsReady).

extension TestPeripheral {
  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    let key = keys[characteristic.uuid] ?? characteristic.uuid.uuidString
    subscribers[key, default: []].append(central)
    Log.write("\(central.identifier.uuidString) subscribed to \(key) (up to \(central.maximumUpdateValueLength) bytes)")
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    let key = keys[characteristic.uuid] ?? characteristic.uuid.uuidString
    subscribers[key]?.removeAll { $0.identifier == central.identifier }
    outbox.removeAll { item in
      item.key == key && item.centrals?.contains { $0.identifier == central.identifier } == true
    }
    Log.write("\(central.identifier.uuidString) unsubscribed from \(key)")
  }

  func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    pump()
  }

  func enqueue(_ key: String, _ value: Data, to centrals: [CBCentral]? = nil) {
    outbox.append(Outgoing(key: key, value: value, centrals: centrals))
    pump()
  }

  /// Sends what waits, in order, until the transmit queue is full: the outbox, then the stream.
  private func pump() {
    guard let manager else { return }
    while let next = outbox.first {
      guard let characteristic = characteristics[next.key] else {
        outbox.removeFirst()
        continue
      }
      guard manager.updateValue(next.value, for: characteristic, onSubscribedCentrals: next.centrals) else { return }
      outbox.removeFirst()
    }
    sendStreamFrame()
  }

  func scheduleSinkNotification() {
    guard !sinkNotifyScheduled else { return }
    sinkNotifyScheduled = true
    let interval = Double(profile.characteristic("SINK_COUNTER")?.spec["notifyIntervalMs"] as? Int ?? 100) / 1000
    queue.asyncAfter(deadline: .now() + interval) { [self] in
      sinkNotifyScheduled = false
      if !(subscribers["SINK_COUNTER"] ?? []).isEmpty { enqueue("SINK_COUNTER", uint32(sinkCount)) }
    }
  }

  func startHeartRate() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + heartRateInterval, repeating: heartRateInterval)
    timer.setEventHandler { [self] in
      guard !(subscribers["HEART_RATE_MEASUREMENT"] ?? []).isEmpty else { return }
      enqueue("HEART_RATE_MEASUREMENT", Data([0x00, bpm]))
      bpm = bpm < maxBpm ? bpm + 1 : minBpm
    }
    timer.resume()
    heartRateTimer = timer
  }

  func startStream(rateHz: Int, frameSize: Int) {
    streamTimer?.cancel()
    streamTimer = nil
    streamPending = nil
    guard rateHz > 0 else { return }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    let interval = 1.0 / Double(rateHz)
    timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .microseconds(100))
    timer.setEventHandler { [self] in
      // A tick while the last frame still waits for the link adds nothing: frames are never
      // dropped, the stream just runs at the rate the link takes.
      guard streamPending == nil, outbox.isEmpty else { return }
      let centrals = subscribers["STREAM"] ?? []
      guard !centrals.isEmpty else { return }
      streamPending = (streamFrame(streamSeq, size: frameSize), centrals)
      sendStreamFrame()
    }
    timer.resume()
    streamTimer = timer
  }

  /// Sends the pending frame to each subscriber still missing it, cut to its maximum length
  /// (stream.mtuRule); the sequence advances once every subscriber has it.
  private func sendStreamFrame() {
    guard let manager, let characteristic = characteristics["STREAM"], var pending = streamPending else { return }
    while let central = pending.centrals.first {
      let value = pending.frame.prefix(central.maximumUpdateValueLength)
      guard manager.updateValue(value, for: characteristic, onSubscribedCentrals: [central]) else {
        streamPending = pending
        return
      }
      pending.centrals.removeFirst()
    }
    streamPending = nil
    streamSeq &+= 1
  }
}
