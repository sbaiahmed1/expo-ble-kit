import CoreBluetooth
import Foundation

/// JS `AdvertisingData` and `AdvertisingOptions` as iOS uses them (plan §5.5, P4-03): what iOS can't
/// advertise is kept only to warn about it.
struct AdvertisingSpec {
  let localName: String?
  let serviceUUIDs: [CBUUID]
  let hasManufacturerData: Bool
  let hasServiceData: Bool
  let includeTxPower: Bool
  let connectable: Bool
}

/// Advertising callbacks of `PeripheralManaging`, on the peripheral queue.
protocol PeripheralAdvertisingDelegate: AnyObject {
  func peripheralManagerStateChanged(_ manager: PeripheralManaging)
  func peripheralManagerDidStartAdvertising(_ manager: PeripheralManaging, error: Error?)
}

/// The peripheral role's advertiser (plan §5.5, P4-03): one advertisement at a time, known to JS by
/// an id, so a stale `stop` can't stop a newer one. A start iOS doesn't confirm within
/// `startTimeout` fails (rule 4). Fields iOS doesn't advertise become NOT_SUPPORTED warnings.
///
/// Threading (plan §4.7): on the peripheral queue (`scheduler`).
final class Advertiser {
  static let startTimeout: TimeInterval = 10

  /// Warnings for the engine's log and the JS `warning` event.
  var onWarning: ((CoreError) -> Void)?
  /// The id of the advertisement running now.
  private(set) var running: Int?

  private let manager: PeripheralManaging
  private let scheduler: Scheduling
  private var nextId = 1
  private var starting: Starting?

  private struct Starting {
    let id: Int
    let spec: AdvertisingSpec
    let completion: (Result<Int, CoreError>) -> Void
    let timeout: CancellableWork
    /// False while a new manager is still `.unknown`.
    var requested: Bool
  }

  init(manager: PeripheralManaging, scheduler: Scheduling) {
    self.manager = manager
    self.scheduler = scheduler
    manager.advertisingDelegate = self
  }

  func start(_ spec: AdvertisingSpec, completion: @escaping (Result<Int, CoreError>) -> Void) {
    guard starting == nil, running == nil else {
      let error = CoreError(.advertisingFailed, "Already advertising: stop the current advertisement first")
      return completion(.failure(error))
    }
    warnAbout(spec)
    let id = nextId
    nextId += 1
    let timeout = scheduler.schedule(after: Self.startTimeout) { [weak self] in
      guard let self, self.starting?.id == id else { return }
      self.fail(CoreError(.operationTimeout, "Advertising didn't start within \(Int(Self.startTimeout)) s"))
    }
    starting = Starting(id: id, spec: spec, completion: completion, timeout: timeout, requested: false)
    requestIfReady()
  }

  /// Stops advertisement `id`; nothing when another one (or none) runs.
  func stop(_ id: Int) {
    guard running == id else { return }
    running = nil
    manager.stopAdvertising()
  }

  /// The module closes: the advertisement ends, a start fails.
  func close(_ reason: CoreError) {
    if starting != nil { fail(reason) }
    if running != nil {
      running = nil
      manager.stopAdvertising()
    }
  }

  private func requestIfReady() {
    guard var pending = starting, !pending.requested else { return }
    switch manager.state {
    case .poweredOn:
      pending.requested = true
      starting = pending
      manager.startAdvertising(localName: pending.spec.localName, serviceUUIDs: pending.spec.serviceUUIDs)
    case .unknown, .resetting:
      return // peripheralManagerStateChanged tries again
    case .unauthorized:
      fail(CoreError(.bluetoothUnauthorized, "The app may not use Bluetooth"))
    case .unsupported:
      fail(CoreError(.bluetoothUnsupported, "This device can't advertise as a Bluetooth LE peripheral"))
    default:
      fail(CoreError(.bluetoothPoweredOff, "Bluetooth is off"))
    }
  }

  private func fail(_ error: CoreError) {
    guard let pending = starting else { return }
    starting = nil
    pending.timeout.cancel()
    if pending.requested { manager.stopAdvertising() }
    pending.completion(.failure(error))
  }

  private func warnAbout(_ spec: AdvertisingSpec) {
    let ignored = [
      spec.hasManufacturerData ? "manufacturerData" : nil,
      spec.hasServiceData ? "serviceData" : nil,
      spec.includeTxPower ? "includeTxPower" : nil
    ].compactMap { $0 }
    if !ignored.isEmpty {
      let fields = ignored.joined(separator: ", ")
      onWarning?(CoreError(.notSupported, "iOS advertises only localName and serviceUUIDs: \(fields) not advertised"))
    }
    if !spec.connectable {
      onWarning?(CoreError(.notSupported, "iOS can't advertise without accepting connections: connectable ignored"))
    }
  }
}

extension Advertiser: PeripheralAdvertisingDelegate {
  func peripheralManagerStateChanged(_ manager: PeripheralManaging) {
    if manager.state != .poweredOn, running != nil {
      running = nil // iOS stops advertising with Bluetooth
    }
    guard let pending = starting else { return }
    if pending.requested, manager.state != .poweredOn {
      return fail(CoreError(.bluetoothPoweredOff, "Bluetooth went off"))
    }
    requestIfReady()
  }

  func peripheralManagerDidStartAdvertising(_ manager: PeripheralManaging, error: Error?) {
    guard let pending = starting, pending.requested else { return }
    if let error {
      let nsError = error as NSError
      let unsupported = nsError.domain == CBErrorDomain && nsError.code == CBError.operationNotSupported.rawValue
      let code: CoreError.Code = unsupported ? .notSupported : .advertisingFailed
      return fail(CoreError(code, "iOS failed to start advertising: \(nsError.localizedDescription)",
                            nativeDomain: nsError.domain, nativeCode: nsError.code))
    }
    starting = nil
    pending.timeout.cancel()
    running = pending.id
    pending.completion(.success(pending.id))
  }
}
