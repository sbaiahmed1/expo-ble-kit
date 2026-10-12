import CoreBluetooth
import Foundation

/// L2CAP callbacks of `PeripheralManaging`, on the peripheral queue (P5-03).
protocol PeripheralL2CAPDelegate: AnyObject {
  func peripheralManagerStateChanged(_ manager: PeripheralManaging)
  func peripheralManager(_ manager: PeripheralManaging, didPublishL2CAPChannel psm: CBL2CAPPSM, error: Error?)
  func peripheralManager(_ manager: PeripheralManaging, didOpen channel: L2CAPChannelLike?, error: Error?)
}

/// Publishes L2CAP channel servers on the peripheral manager (plan §5.5 L2CAP rules, P5-03) and
/// hands each incoming channel to its server. `didPublishL2CAPChannel` doesn't say which request it
/// answers, so publishes go one at a time; one iOS doesn't confirm within `publishTimeout` fails
/// (rule 4). Bluetooth off closes every server.
///
/// Threading (plan §4.7): on the peripheral queue (`scheduler`).
final class L2CAPPublisher: PeripheralL2CAPDelegate {
  static let publishTimeout: TimeInterval = 10

  private let manager: PeripheralManaging
  private let scheduler: Scheduling
  private var requests: [Request] = []
  private var servers: [CBL2CAPPSM: L2CAPServer] = [:]

  private final class Request {
    let secure: Bool
    let completion: (Result<L2CAPServer, CoreError>) -> Void
    var timer: CancellableWork?
    /// iOS was asked and hasn't answered.
    var sent = false
    /// Answered already (timed out): its PSM is unpublished when it arrives.
    var settled = false

    init(secure: Bool, completion: @escaping (Result<L2CAPServer, CoreError>) -> Void) {
      self.secure = secure
      self.completion = completion
    }

    func settle(_ result: Result<L2CAPServer, CoreError>) {
      guard !settled else {
        return
      }
      settled = true
      timer?.cancel()
      completion(result)
    }
  }

  init(manager: PeripheralManaging, scheduler: Scheduling) {
    self.manager = manager
    self.scheduler = scheduler
    manager.l2capDelegate = self
  }

  /// `secure`: the central needs an encrypted link (`withEncryption`).
  func publish(secure: Bool, completion: @escaping (Result<L2CAPServer, CoreError>) -> Void) {
    let request = Request(secure: secure, completion: completion)
    request.timer = scheduler.schedule(after: Self.publishTimeout) { [weak self, weak request] in
      guard let self, let request else {
        return
      }
      let seconds = Int(Self.publishTimeout)
      request.settle(.failure(CoreError(.operationTimeout, "iOS didn't publish the L2CAP channel within \(seconds) s")))
      if !request.sent {
        requests.removeAll { $0 === request }
      }
    }
    requests.append(request)
    sendNext()
  }

  /// The module closes: every server and request ends with `error`.
  func close(_ error: CoreError) {
    let pending = requests
    requests.removeAll()
    pending.forEach { $0.settle(.failure(error)) }
    servers.values.forEach { $0.end(error, unpublish: manager.state == .poweredOn) }
  }

  /// A server closed: iOS unpublishes its PSM, which closes the channels on it too.
  func remove(_ server: L2CAPServer, unpublish: Bool) {
    let psm = CBL2CAPPSM(server.psm)
    guard servers[psm] === server else {
      return
    }
    servers[psm] = nil
    if unpublish {
      manager.unpublishL2CAPChannel(psm)
    }
  }

  // MARK: PeripheralL2CAPDelegate

  func peripheralManagerStateChanged(_ manager: PeripheralManaging) {
    switch manager.state {
    case .poweredOn:
      sendNext()
    case .unknown:
      break
    default:
      let error = CentralEngine.adapterError(manager.state) ?? CoreError(.bluetoothPoweredOff, "Bluetooth is off")
      servers.values.forEach { $0.end(error, unpublish: false) }
      if manager.state != .resetting {
        let pending = requests
        requests.removeAll()
        pending.forEach { $0.settle(.failure(error)) }
      }
    }
  }

  func peripheralManager(_ manager: PeripheralManaging, didPublishL2CAPChannel psm: CBL2CAPPSM, error: Error?) {
    guard let request = requests.first, request.sent else {
      if error == nil {
        manager.unpublishL2CAPChannel(psm)
      }
      return
    }
    requests.removeFirst()
    if let error {
      let reason = CoreBluetoothErrorMapping.coreError(from: error)
      request.settle(.failure(CoreError(
        .l2capFailed,
        "Publishing an L2CAP channel failed: \(reason.message)",
        nativeDomain: reason.nativeDomain,
        nativeCode: reason.nativeCode
      )))
    } else if request.settled {
      manager.unpublishL2CAPChannel(psm)
    } else {
      let server = L2CAPServer(psm: Int(psm), publisher: self, scheduler: scheduler)
      servers[psm] = server
      request.settle(.success(server))
    }
    sendNext()
  }

  func peripheralManager(_ manager: PeripheralManaging, didOpen channel: L2CAPChannelLike?, error: Error?) {
    guard let channel else {
      return
    }
    guard let server = servers[channel.psm] else {
      return channel.close()
    }
    server.accept(channel)
  }

  // MARK: Private

  private func sendNext() {
    guard manager.state == .poweredOn, let next = requests.first, !next.sent else {
      if manager.state != .poweredOn, manager.state != .unknown, manager.state != .resetting {
        let error = CentralEngine.adapterError(manager.state) ?? CoreError(.bluetoothPoweredOff, "Bluetooth is off")
        let pending = requests
        requests.removeAll()
        pending.forEach { $0.settle(.failure(error)) }
      }
      return
    }
    next.sent = true
    manager.publishL2CAPChannel(withEncryption: next.secure)
  }
}

/// A published L2CAP channel server (P5-03). `close` unpublishes it and closes its channels.
///
/// Threading: on the peripheral queue, like the publisher.
final class L2CAPServer {
  let psm: Int
  /// Each channel a central opens; without it, channels are closed.
  var onChannel: ((L2CAPChannel) -> Void)?
  private weak var publisher: L2CAPPublisher?
  private let scheduler: Scheduling
  private var channels: [L2CAPChannel] = []
  private(set) var isOpen = true

  init(psm: Int, publisher: L2CAPPublisher, scheduler: Scheduling) {
    self.psm = psm
    self.publisher = publisher
    self.scheduler = scheduler
  }

  func close() {
    end(nil, unpublish: true)
  }

  /// Ends the server; `error` goes to its channels (nil: closed by the app).
  func end(_ error: CoreError?, unpublish: Bool) {
    guard isOpen else {
      return
    }
    isOpen = false
    publisher?.remove(self, unpublish: unpublish)
    channels.forEach { $0.close(error) }
  }

  func accept(_ channel: L2CAPChannelLike) {
    guard isOpen else {
      return channel.close()
    }
    let accepted = L2CAPChannel(channel: channel, peerId: channel.peerIdentifier.uuidString, scheduler: scheduler)
    accepted.onEnded = { [weak self] ended in self?.channels.removeAll { $0 === ended } }
    channels.append(accepted)
    if let onChannel {
      onChannel(accepted)
    } else {
      accepted.close(nil)
    }
  }
}
