import CoreBluetooth
import Foundation

// Reconnection policies (P2-01): after an unexpected link loss of a ready connection, wait, try
// again, and restore the subscriptions before the connection counts as ready again.

extension PeripheralSession {
  /// The state as JS sees it: the setup steps of a reconnection read as `reconnecting` (plan §4.8).
  var visibleState: SessionState {
    let settingUp = state == .connecting || state == .connected || state == .discovering
    return reconnectAttempt > 0 && settingUp ? .reconnecting : state
  }

  /// A ready connection was lost unexpectedly and a policy is set. `system`: iOS 17 auto-reconnect
  /// connects again by itself, so no attempts of ours run until it fails.
  func startReconnecting(_ error: CoreError, system: Bool) {
    resetLink()
    reconnectAttempt = 1
    systemReconnecting = system
    // Waiting for the system's reconnection is a pending connect; JS sees both as reconnecting.
    setState(system ? .connecting : .reconnecting, error)
    queue.failAll(CoreError(.disconnected, "Disconnected"))
    if restoreSubscriptions {
      subscriptions.values.forEach { $0.enabled = false }
    } else {
      subscriptions.values.forEach { endSubscriptions($0, error) }
    }
    if !system {
      scheduleReconnect()
    }
  }

  /// A reconnection attempt failed: wait for the next one, or give up with `error`.
  func retryReconnect(_ error: CoreError) {
    resetLink()
    queue.failAll(CoreError(.disconnected, "Disconnected"))
    systemReconnecting = false
    let next = reconnectAttempt + 1
    guard reconnect?.allows(next) == true else {
      return finishDisconnected(error)
    }
    reconnectAttempt = next
    subscriptions.values.forEach { $0.enabled = false }
    setState(.reconnecting, error)
    scheduleReconnect()
  }

  /// Enables the CCCD of every subscription again, after a reconnection or a service change
  /// (`after` says which), then calls `done`. A subscription whose characteristic is gone or whose
  /// CCCD write fails ends alone.
  func restoreSubscriptions(after: String = "reconnecting", then done: @escaping () -> Void) {
    let entries = Array(subscriptions.values)
    guard !entries.isEmpty else {
      return done()
    }
    let setupState = state
    var remaining = entries.count
    let finish = { [weak self] in
      remaining -= 1
      if remaining == 0, self?.state == setupState {
        done()
      }
    }
    for entry in entries {
      let service = peripheral.serviceList.first { $0.uuid == entry.serviceUUID }
      let found = service?.characteristicList.first { $0.uuid == entry.characteristicUUID }
      guard let characteristic = found else {
        let error = CoreError(.characteristicNotFound, "\(entry.characteristicUUID) is gone after \(after)")
        endSubscriptions(entry, error)
        finish()
        continue
      }
      rekey(entry, characteristic)
      setNotify(true, for: entry, timeout: nil) { [weak self] result in
        guard let self, state == setupState else {
          return
        }
        switch result {
        case .success:
          entry.enabled = true
        case let .failure(error):
          endSubscriptions(entry, error)
        }
        finish()
      }
    }
  }

  // MARK: Private

  private func scheduleReconnect() {
    guard let policy = reconnect else {
      return
    }
    reconnectTimer = scheduler.schedule(after: policy.delay(attempt: reconnectAttempt)) { [weak self] in
      guard let self, state == .reconnecting else {
        return
      }
      reconnectTimer = nil
      setState(.connecting, nil)
      startConnectTimeout()
      central.connect(peripheral, options: connectOptions)
    }
  }

  /// Handles, the database and the MTU can differ on the next connection.
  private func resetLink() {
    connectTimeout?.cancel()
    connectTimeout = nil
    pendingWriteWithoutResponse = nil
    mtu = Self.defaultMtu
    if !services.isEmpty {
      services = []
      onServicesChange?([])
    }
  }

  /// Discovery creates new characteristic objects: the entry moves to the new key.
  private func rekey(_ entry: CharacteristicSubscriptions, _ characteristic: CharacteristicLike) {
    let oldKey = Self.key(entry.characteristic)
    let newKey = Self.key(characteristic)
    entry.characteristic = characteristic
    guard oldKey != newKey else {
      return
    }
    subscriptions.removeValue(forKey: oldKey)
    subscriptions[newKey] = entry
    entry.subscribers.forEach { subscriptionKeys[$0] = newKey }
  }

  private func endSubscriptions(_ entry: CharacteristicSubscriptions, _ error: CoreError) {
    subscriptions.removeValue(forKey: Self.key(entry.characteristic))
    flushBatches(Array(entry.subscribers))
    for id in entry.subscribers {
      subscriptionKeys.removeValue(forKey: id)
      onSubscriptionEnded?(id, error)
    }
  }
}
