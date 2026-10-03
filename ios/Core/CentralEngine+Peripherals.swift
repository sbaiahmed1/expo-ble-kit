import CoreBluetooth
import Foundation

// Peripherals by id or at the OS level, their names, cancelling operations, and diagnostics (P1-12).

extension CentralEngine {
  /// The latest name seen for `peripheralId`, or nil. Safe from any thread.
  func name(_ peripheralId: String) -> String? {
    names[peripheralId.uppercased()]
  }

  /// The ids of `ids` that iOS knows (`retrievePeripherals(withIdentifiers:)`); others are dropped.
  /// Throws like connect() when the manager can't be used. Never shows the prompt.
  func knownPeripherals(_ ids: [String], completion: @escaping (Result<[String], CoreError>) -> Void) throws {
    let identifiers = ids.compactMap(UUID.init(uuidString:))
    try withCentral { [weak self] result in
      completion(result.map { central in
        self?.publishNames(central.retrievePeripherals(withIdentifiers: identifiers)) ?? []
      })
    }
  }

  /// Peripherals connected at the OS level, possibly by another app, that have one of `services`.
  func systemConnectedPeripherals(
    _ services: [String],
    completion: @escaping (Result<[String], CoreError>) -> Void
  ) throws {
    let uuids = services.map(CBUUID.init(string:))
    try withCentral { [weak self] result in
      completion(result.map { central in
        self?.publishNames(central.retrieveConnectedPeripherals(withServices: uuids)) ?? []
      })
    }
  }

  /// Cancels the operation started with `operationId` on `peripheralId` (plan §4.9). Unknown
  /// peripherals and ids do nothing.
  func cancelOperation(_ peripheralId: String, operationId: Int) {
    session(peripheralId) { (_: Result<Void, CoreError>) in }?.cancel(operationId)
  }

  /// JS `Diagnostics` so far (plan §5.7): the rest lands with P2-07.
  func diagnostics() -> [String: Any] {
    [
      "state": state.rawValue,
      "sessions": sessions.values.map { session in
        [
          "id": session.peripheral.identifier.uuidString,
          "state": session.visibleState.js,
          "queueDepth": session.queue.depth,
          "subscriptions": 0
        ] as [String: Any]
      }
    ]
  }

  /// Records the names iOS cached for `peripherals` and returns their ids.
  private func publishNames(_ peripherals: [PeripheralLike]) -> [String] {
    peripherals.map { peripheral in
      names[peripheral.identifier.uuidString] = peripheral.name
      return peripheral.identifier.uuidString
    }
  }
}
