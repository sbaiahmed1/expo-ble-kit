import CoreBluetooth
import Foundation

// L2CAP channels to the peripheral (plan §5.5 L2CAP rules, P5-03). `didOpen` with an error doesn't
// say which request failed, so the session asks for one channel at a time, in request order.

/// An `openL2CAPChannel` request.
final class L2CAPOpen {
  let psm: CBL2CAPPSM
  let operationId: Int?
  let completion: (Result<L2CAPChannel, CoreError>) -> Void
  var timer: CancellableWork?
  /// CoreBluetooth was asked and hasn't answered yet.
  var started = false
  /// Answered already (timed out or cancelled): its channel is closed when it arrives.
  var settled = false

  init(psm: CBL2CAPPSM, operationId: Int?, completion: @escaping (Result<L2CAPChannel, CoreError>) -> Void) {
    self.psm = psm
    self.operationId = operationId
    self.completion = completion
  }

  func settle(_ result: Result<L2CAPChannel, CoreError>) {
    guard !settled else {
      return
    }
    settled = true
    timer?.cancel()
    completion(result)
  }
}

extension PeripheralSession {
  /// openL2CAPChannel's default timeout: a secure channel may wait for pairing.
  static let l2capOpenTimeout: TimeInterval = 30
  /// Errors that mean Bluetooth itself went away.
  static let adapterCodes: Set<CoreError.Code> = [
    .bluetoothPoweredOff, .bluetoothResetting, .bluetoothUnsupported, .bluetoothUnauthorized
  ]

  /// Opens an L2CAP channel to `psm` on a ready connection. Not a GATT operation: it doesn't queue
  /// behind them. Completes with `OPERATION_TIMEOUT` after `timeout`.
  func openL2CAPChannel(
    psm: CBL2CAPPSM,
    timeout: TimeInterval?,
    operationId: Int?,
    completion: @escaping (Result<L2CAPChannel, CoreError>) -> Void
  ) {
    guard state == .ready else {
      return completion(.failure(CoreError(.disconnected, "Not connected")))
    }
    let open = L2CAPOpen(psm: psm, operationId: operationId, completion: completion)
    let limit = timeout ?? Self.l2capOpenTimeout
    open.timer = scheduler.schedule(after: limit) { [weak self, weak open] in
      guard let self, let open else {
        return
      }
      let milliseconds = Int(limit * 1000)
      abandon(open, CoreError(.operationTimeout, "Opening L2CAP channel \(psm) timed out after \(milliseconds) ms"))
    }
    l2capOpens.append(open)
    logger.log(.debug, peripheralId: peripheral.identifier.uuidString) { "opening L2CAP channel \(psm)" }
    startNextL2CAPOpen()
  }

  func cancelL2CAPOpen(_ operationId: Int) {
    if let open = l2capOpens.first(where: { $0.operationId == operationId && !$0.settled }) {
      abandon(open, CoreError(.operationCancelled, "Opening L2CAP channel \(open.psm) was cancelled"))
    }
  }

  /// The connection ended with `error`: channels close with the adapter's error when Bluetooth went
  /// off, else with DISCONNECTED (plan §5.5).
  func closeL2CAP(endedWith error: CoreError?) {
    let adapterError = error.flatMap { Self.adapterCodes.contains($0.code) ? $0 : nil }
    closeL2CAP(adapterError ?? CoreError(.disconnected, "Disconnected"))
  }

  /// Channels and opens end with the connection; late `didOpen` channels are closed on arrival.
  func closeL2CAP(_ error: CoreError) {
    let opens = l2capOpens
    l2capOpens.removeAll()
    opens.forEach { $0.settle(.failure(error)) }
    l2capChannels.forEach { $0.close(error) }
  }

  func peripheral(_ peripheral: PeripheralLike, didOpen channel: L2CAPChannelLike?, error: Error?) {
    guard let open = l2capOpens.first, open.started else {
      // Its request ended with the connection: nobody wants the channel.
      channel?.close()
      return
    }
    l2capOpens.removeFirst()
    if let channel, error == nil, state == .ready, !open.settled {
      let opened = L2CAPChannel(channel: channel, peerId: peripheral.identifier.uuidString, scheduler: scheduler)
      opened.onEnded = { [weak self] ended in self?.l2capChannels.removeAll { $0 === ended } }
      l2capChannels.append(opened)
      logger.log(.info, peripheralId: peripheral.identifier.uuidString) { "L2CAP channel \(open.psm) open" }
      open.settle(.success(opened))
    } else {
      channel?.close()
      let reason = error.map { CoreBluetoothErrorMapping.coreError(from: $0) }
      open.settle(.failure(CoreError(
        .l2capFailed,
        "Opening L2CAP channel \(open.psm) failed" + (reason.map { ": \($0.message)" } ?? ""),
        nativeDomain: reason?.nativeDomain,
        nativeCode: reason?.nativeCode
      )))
    }
    startNextL2CAPOpen()
  }

  // MARK: Private

  private func startNextL2CAPOpen() {
    guard let next = l2capOpens.first, !next.started else {
      return
    }
    next.started = true
    peripheral.openL2CAPChannel(next.psm)
  }

  /// A timeout or a cancel answers the request at once. One CoreBluetooth works on stays first in
  /// line until it answers, so the next answer still matches its request.
  private func abandon(_ open: L2CAPOpen, _ error: CoreError) {
    guard !open.settled else {
      return
    }
    logger.log(.warn, peripheralId: peripheral.identifier.uuidString) {
      "L2CAP channel \(open.psm): \(error.code.rawValue) \(error.message)"
    }
    open.settle(.failure(error))
    if !open.started {
      l2capOpens.removeAll { $0 === open }
    }
  }
}
