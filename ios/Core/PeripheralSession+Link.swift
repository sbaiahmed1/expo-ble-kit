import CoreBluetooth
import Foundation

// MTU and RSSI (P1-09). iOS exchanges the MTU on its own and has no MTU API (plan §4.3).

extension PeripheralSession {
  typealias IntCompletion = (Result<Int, CoreError>) -> Void

  /// A failed connect is CONNECTION_FAILED whatever CoreBluetooth called it; the native code is kept.
  static func connectionError(_ error: Error?) -> CoreError {
    guard let error else {
      return CoreError(.connectionFailed, "The connection failed")
    }
    let mapped = CoreBluetoothErrorMapping.coreError(from: error)
    return CoreError(
      .connectionFailed,
      mapped.message,
      retryable: true,
      nativeDomain: mapped.nativeDomain,
      nativeCode: mapped.nativeCode
    )
  }

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
  func readRssi(timeout: TimeInterval?, operationId: Int? = nil, completion: @escaping IntCompletion) {
    guard state == .ready else {
      return completion(.failure(CoreError(.disconnected, "Not connected")))
    }
    let operation = queue.enqueue(.readRSSI, timeout: timeout) { [weak self] in
      self?.peripheral.readRSSI()
    } completion: { result in
      completion(result.map { output in
        if case let .int(rssi) = output {
          return rssi
        }
        return 0
      })
    }
    track(operation, operationId)
  }

  func peripheralDidUpdateName(_ peripheral: PeripheralLike) {
    onNameChange?(peripheral.name)
  }

  func peripheral(_ peripheral: PeripheralLike, didReadRSSI rssi: Int, error: Error?) {
    let result: Result<GattOperation.Output, CoreError> = error
      .map { .failure(CoreBluetoothErrorMapping.coreError(from: $0)) } ?? .success(.int(rssi))
    _ = queue.complete(result) { $0.kind == .readRSSI }
  }
}

extension PeripheralSession {
  /// Starts connecting with `spec`: its options, its timeout, and CoreBluetooth's connect (again,
  /// for a restored pending connection: the call is idempotent).
  func start(_ spec: ConnectSpec) {
    autoDiscover = spec.autoDiscover
    reconnect = spec.reconnect
    restoreSubscriptions = spec.restoreSubscriptions
    connectTimeoutValue = spec.timeout
    connectOptions = Self.options(for: spec)
    startConnectTimeout()
    central.connect(peripheral, options: connectOptions)
  }

  static func options(for spec: ConnectSpec) -> [String: Any]? {
    var options: [String: Any] = [:]
    if spec.notifyOnDisconnection {
      options[CBConnectPeripheralOptionNotifyOnDisconnectionKey] = true
    }
    if spec.reconnect != nil, spec.enableAutoReconnect, #available(iOS 17, macOS 14, *) {
      options[CBConnectPeripheralOptionEnableAutoReconnect] = true
    }
    return options.isEmpty ? nil : options
  }
}
