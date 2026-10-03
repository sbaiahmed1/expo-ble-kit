import Foundation

// What a session reports to the engine: values, batches, warnings, service changes and the log.

extension CentralEngine {
  /// Notifications, batches (P2-04) and warnings of `session`, with epoch timestamps (plan §4.10).
  func wireNotifications(_ session: PeripheralSession, _ identifier: UUID) {
    session.clock = { [weak self] in
      guard let self else {
        return 0
      }
      return clock.epochMs(monotonic: scheduler.now)
    }
    session.onNotification = { [weak self] characteristic, value, timestamp in
      self?.logger.log(.verbose, peripheralId: identifier.uuidString) {
        "notification from \(characteristic.uuid.fullUUIDString): \(value.count) bytes"
      }
      self?.onNotification?(
        identifier.uuidString,
        characteristic.parentService?.uuid.fullUUIDString ?? "",
        characteristic.uuid.fullUUIDString,
        value,
        timestamp
      )
    }
    session.onNotificationBatch = { [weak self] subscriptionId, batch in
      self?.onNotificationBatch?(identifier.uuidString, subscriptionId, batch)
    }
    session.logger = logger
    session.onWarning = { [weak self] warning in self?.warn(warning) }
    session.onServicesChanged = { [weak self] in self?.onServicesChanged?(identifier.uuidString) }
  }
}
