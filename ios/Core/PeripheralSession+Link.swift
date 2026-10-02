import CoreBluetooth
import Foundation

// MTU and RSSI (P1-09). iOS exchanges the MTU on its own and has no MTU API (plan §4.3).

extension PeripheralSession {
  typealias IntCompletion = (Result<Int, CoreError>) -> Void

  static let defaultMtu = 23
  static let maxMtu = 517

  /// The ATT MTU as iOS reveals it: one packet without response plus the 3-byte ATT header.
  var derivedMtu: Int {
    peripheral.maximumWriteValueLength(for: .withoutResponse) + 3
  }

  /// iOS can't negotiate: checks `requested` as Android does, then resolves the current MTU, read
  /// again because iOS may finish its own exchange after the connection is ready.
  func requestMtu(_ requested: Int, completion: IntCompletion) {
    guard (Self.defaultMtu...Self.maxMtu).contains(requested) else {
      let range = "\(Self.defaultMtu)–\(Self.maxMtu)"
      return completion(.failure(CoreError(.invalidArgument, "MTU \(requested) is outside \(range)")))
    }
    guard state == .ready else {
      return completion(.failure(CoreError(.disconnected, "Not connected")))
    }
    refreshMtu()
    completion(.success(mtu))
  }

  /// Reads the derived MTU again. Only a ready connection reports a change: the value at setup is
  /// in `mtu` when JS sees `connected`.
  func refreshMtu() {
    let current = derivedMtu
    guard current != mtu else {
      return
    }
    mtu = current
    if state == .ready {
      onMtuChange?(current)
    }
  }

  /// Reads the link's RSSI in dBm through the queue.
  func readRssi(timeout: TimeInterval?, completion: @escaping IntCompletion) {
    guard state == .ready else {
      return completion(.failure(CoreError(.disconnected, "Not connected")))
    }
    queue.enqueue(.readRSSI, timeout: timeout) { [weak self] in
      self?.peripheral.readRSSI()
    } completion: { result in
      completion(result.map { output in
        if case let .int(rssi) = output {
          return rssi
        }
        return 0
      })
    }
  }

  func peripheral(_ peripheral: PeripheralLike, didReadRSSI rssi: Int, error: Error?) {
    let result: Result<GattOperation.Output, CoreError> = error
      .map { .failure(CoreBluetoothErrorMapping.coreError(from: $0)) } ?? .success(.int(rssi))
    _ = queue.complete(result) { $0.kind == .readRSSI }
  }
}
