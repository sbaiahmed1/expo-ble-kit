import CoreBluetooth
import Foundation

// Service discovery and its cache (P1-06), through the session's queue.

extension PeripheralSession {
  /// Discovers services through the queue (plan §4.9): `filter` (all when nil), then all their
  /// characteristics and descriptors. The cache gains what was found; an unfiltered run replaces it.
  func discover(
    _ filter: [String]?,
    timeout: TimeInterval?,
    operationId: Int? = nil,
    first: Bool = false,
    completion: @escaping DiscoveryCompletion
  ) {
    guard state == .ready || state == .discovering else {
      return completion(.failure(CoreError(.disconnected, "Not connected")))
    }
    nextDiscoveryId += 1
    let runId = nextDiscoveryId
    let operation = queue.enqueue(
      .discoverServices,
      timeout: timeout ?? Self.discoveryTimeout,
      first: first,
      start: { [weak self] in
        self?.discovery = DiscoveryRun(id: runId, filter: filter)
        self?.peripheral.discoverServices(filter?.map(CBUUID.init(string:)))
      },
      completion: { [weak self] result in
        guard let self else {
          return
        }
        if discovery?.id == runId {
          // A timeout or a disconnect ended the run; later callbacks are ignored.
          discovery = nil
        }
        completion(result.map { _ in self.updateCache(filter) })
      }
    )
    track(operation, operationId)
  }

  func peripheralDidDiscoverServices(_ peripheral: PeripheralLike, error: Error?) {
    guard var run = discovery else {
      return
    }
    if let error {
      return finishDiscovery(.failure(CoreBluetoothErrorMapping.coreError(from: error)))
    }
    let services = peripheral.serviceList.filter { run.filter?.contains($0.uuid.fullUUIDString) ?? true }
    run.outstanding = services.count
    discovery = run
    if services.isEmpty {
      return finishDiscovery(.success(.none))
    }
    services.forEach { peripheral.discoverCharacteristics(nil, for: $0) }
  }

  func peripheral(_ peripheral: PeripheralLike, didDiscoverCharacteristicsFor service: ServiceLike, error: Error?) {
    guard discovery != nil else {
      return
    }
    if let error {
      return finishDiscovery(.failure(CoreBluetoothErrorMapping.coreError(from: error)))
    }
    discovery?.outstanding += service.characteristicList.count - 1
    service.characteristicList.forEach { peripheral.discoverDescriptors(for: $0) }
    finishDiscoveryIfDone()
  }

  func peripheral(
    _ peripheral: PeripheralLike,
    didDiscoverDescriptorsFor characteristic: CharacteristicLike,
    error: Error?
  ) {
    guard discovery != nil else {
      return
    }
    if let error {
      return finishDiscovery(.failure(CoreBluetoothErrorMapping.coreError(from: error)))
    }
    discovery?.outstanding -= 1
    finishDiscoveryIfDone()
  }

  private func finishDiscoveryIfDone() {
    if let run = discovery, run.outstanding == 0 {
      finishDiscovery(.success(.none))
    }
  }

  private func finishDiscovery(_ result: Result<GattOperation.Output, CoreError>) {
    discovery = nil
    queue.complete(result) { $0.kind == .discoverServices }
  }

  /// Records what the run found and returns the services it asked for.
  private func updateCache(_ filter: [String]?) -> [DiscoveredService] {
    let found = peripheral.serviceList
      .filter { filter?.contains($0.uuid.fullUUIDString) ?? true }
      .map(DiscoveredService.init)
    if filter == nil {
      services = found
    } else {
      for service in found {
        if let index = services.firstIndex(where: { $0.uuid == service.uuid }) {
          services[index] = service
        } else {
          services.append(service)
        }
      }
    }
    onServicesChange?(services)
    return found
  }
}
