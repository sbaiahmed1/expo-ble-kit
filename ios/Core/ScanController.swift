import CoreBluetooth
import Foundation

/// Runs one CoreBluetooth scan for all JS scan sessions (plan §5.3): CoreBluetooth runs one scan at
/// a time, so the controller scans for the union of the sessions' services and filters, de-duplicates
/// and batches results per session.
///
/// Threading (plan §4.7): everything on the engine's queue.
final class ScanController {
  private final class Session {
    let spec: ScanSpec
    var seen: Set<String> = []
    /// The current batch window: device ids in arrival order, latest record per device.
    var batchOrder: [String] = []
    var batch: [String: ScanRecord] = [:]
    var flush: CancellableWork?

    init(spec: ScanSpec) {
      self.spec = spec
    }
  }

  var onResults: ((_ sessionId: Int, _ results: [[String: Any]]) -> Void)?
  /// The session has ended.
  var onError: ((_ sessionId: Int, _ error: CoreError) -> Void)?

  private let scheduler: Scheduling
  private let clock: EpochClock
  private var sessions: [Int: Session] = [:]
  private var running: PlatformScan?
  private weak var central: CentralManaging?
  /// The manager reports `poweredOn`. Sessions started before that wait.
  private var isPoweredOn = false

  init(scheduler: Scheduling, clock: EpochClock) {
    self.scheduler = scheduler
    self.clock = clock
  }

  var activeSessionIds: Set<Int> {
    Set(sessions.keys)
  }

  func start(_ sessionId: Int, spec: ScanSpec) {
    precondition(sessions[sessionId] == nil, "Scan session \(sessionId) is already running")
    sessions[sessionId] = Session(spec: spec)
    reconcile()
  }

  func stop(_ sessionId: Int) {
    guard let session = sessions.removeValue(forKey: sessionId) else {
      return
    }
    session.flush?.cancel()
    reconcile()
  }

  /// The manager reached `poweredOn`: start what is waiting.
  func poweredOn(_ central: CentralManaging) {
    self.central = central
    isPoweredOn = true
    reconcile()
  }

  /// Ends every session with `error`, for example when Bluetooth turns off. CoreBluetooth has then
  /// already stopped the scan.
  func stopAll(_ error: CoreError) {
    isPoweredOn = false
    running = nil
    let ended = sessions
    sessions.removeAll()
    for (sessionId, session) in ended {
      session.flush?.cancel()
      onError?(sessionId, error)
    }
  }

  func deliver(_ peripheral: PeripheralLike, advertisementData: [String: Any], rssi: Int) {
    // CoreBluetooth reports 127 when the RSSI isn't available.
    guard rssi != 127, !sessions.isEmpty else {
      return
    }
    let record = ScanRecord(
      identifier: peripheral.identifier,
      peripheralName: peripheral.name,
      advertisementData: advertisementData,
      rssi: rssi,
      timestamp: clock.epochMs(monotonic: scheduler.now)
    )
    for (sessionId, session) in sessions where session.spec.matches(record) {
      if !session.spec.allowDuplicates, !session.seen.insert(record.id).inserted {
        continue
      }
      guard session.spec.reportInterval > 0 else {
        onResults?(sessionId, [record.dictionary])
        continue
      }
      if session.batch.updateValue(record, forKey: record.id) == nil {
        session.batchOrder.append(record.id)
      }
      if session.flush == nil {
        session.flush = scheduler.schedule(after: session.spec.reportInterval) { [weak self] in
          self?.flush(sessionId)
        }
      }
    }
  }

  private func flush(_ sessionId: Int) {
    guard let session = sessions[sessionId] else {
      return
    }
    session.flush = nil
    let results = session.batchOrder.compactMap { session.batch[$0]?.dictionary }
    session.batch.removeAll()
    session.batchOrder.removeAll()
    if !results.isEmpty {
      onResults?(sessionId, results)
    }
  }

  /// A new `scanForPeripherals` call replaces the running scan, so a change needs no stop first.
  private func reconcile() {
    let desired = sessions.isEmpty || !isPoweredOn ? nil : PlatformScan.union(sessions.values.map(\.spec))
    guard desired != running, let central else {
      return
    }
    if let desired {
      central.scanForPeripherals(withServices: desired.serviceUUIDs, options: desired.options)
    } else {
      central.stopScan()
    }
    running = desired
  }
}
