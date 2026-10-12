import CoreBluetooth
import Foundation

// AccessorySetupKit's picker (iOS 18+, plan §4.3 AccessorySetup, P5-04): the app describes the
// accessories it can set up, the system shows the ones nearby, and the person's pick authorizes
// that one accessory for the app. ASAccessorySession sits behind `AccessorySessionLike`
// (AccessorySessionAdapter.swift) so the rules here run in unit tests on macOS.

/// A picker item after the TS layer validated it (JS `AccessoryPickerItem`, plan §5.6).
struct AccessoryPickerItemSpec {
  let name: String
  /// The product image's bytes (PNG or JPEG); the binding checks they decode.
  let image: Data
  let service: CBUUID?
  let companyId: UInt16?
  let nameSubstring: String?
  let manufacturerData: (data: Data, mask: Data)?
  let serviceData: (data: Data, mask: Data)?
  let immediateRange: Bool
}

/// The app's AccessorySetupKit declarations in Info.plist (Apple's AccessorySetupKit reference).
struct AccessoryDeclarations {
  static let supportsKey = "NSAccessorySetupKitSupports"
  static let servicesKey = "NSAccessorySetupBluetoothServices"
  static let namesKey = "NSAccessorySetupBluetoothNames"
  static let companyIdentifiersKey = "NSAccessorySetupBluetoothCompanyIdentifiers"
  /// The most values ASAccessorySession takes in one list.
  static let maxValues = 500

  let supportsBluetooth: Bool
  /// Lowercase 128-bit, as `CBUUID.fullUUIDString` gives them.
  let services: Set<String>
  let names: Set<String>
  let companyIds: Set<UInt16>
  /// A declared list ASAccessorySession refuses when it starts, which stops the app: not an array,
  /// empty, over `maxValues`, or with a company id it can't read (seen on iOS 27.0.1).
  let invalidList: String?

  init(infoDictionary: [String: Any]?) {
    let strings = { (key: String) in infoDictionary?[key] as? [Any] ?? [] }
    supportsBluetooth = strings(Self.supportsKey).contains { ($0 as? String) == "Bluetooth" }
    services = Set(strings(Self.servicesKey).compactMap { ($0 as? String).flatMap(Self.uuid)?.fullUUIDString })
    names = Set(strings(Self.namesKey).compactMap { $0 as? String })
    companyIds = Set(strings(Self.companyIdentifiersKey).compactMap(Self.companyId))
    invalidList = [Self.supportsKey, Self.servicesKey, Self.namesKey, Self.companyIdentifiersKey].lazy
      .compactMap { key in infoDictionary?[key].flatMap { Self.problem(key, $0) } }
      .first
  }

  private static func problem(_ key: String, _ value: Any) -> String? {
    guard let list = value as? [Any], (1 ... maxValues).contains(list.count) else {
      return "Info.plist's \(key) must list 1 to \(maxValues) values"
    }
    if key == companyIdentifiersKey, list.contains(where: { companyId($0) == nil }) {
      return "Info.plist's \(key) has a value that isn't a 16-bit company identifier"
    }
    return nil
  }

  /// iOS crashes the app when a picker item uses an identifier Info.plist doesn't list (Apple's
  /// "Discovering and configuring accessories"), or when a declared list is malformed, so this
  /// rejects both first with MISCONFIGURED.
  func check(_ items: [AccessoryPickerItemSpec]) throws {
    if let invalidList {
      throw CoreError(.misconfigured, "\(invalidList), and iOS would stop the app over it (\(CoreError.setupGuide)).")
    }
    guard supportsBluetooth else {
      throw CoreError(
        .misconfigured,
        "Info.plist doesn't declare AccessorySetupKit for Bluetooth. Set ios.accessorySetupKit in the " +
          "expo-ble-kit config plugin options, or \(CoreError.setupGuide)"
      )
    }
    for item in items {
      if let service = item.service, !services.contains(service.fullUUIDString) {
        throw undeclared("service \(service.uuidString)", key: Self.servicesKey)
      }
      if let company = item.companyId, !companyIds.contains(company) {
        throw undeclared(String(format: "company identifier 0x%04X", company), key: Self.companyIdentifiersKey)
      }
      if let name = item.nameSubstring, !names.contains(name) {
        throw undeclared("name \"\(name)\"", key: Self.namesKey)
      }
    }
  }

  private func undeclared(_ what: String, key: String) -> CoreError {
    CoreError(
      .misconfigured,
      "The accessory picker uses the \(what), which Info.plist doesn't list in \(key): add it to " +
        "ios.accessorySetupKit in the expo-ble-kit config plugin options"
    )
  }

  private static func uuid(_ string: String) -> CBUUID? {
    let hex = string.replacingOccurrences(of: "-", with: "")
    guard [4, 8, 32].contains(hex.count), hex.allSatisfy(\.isHexDigit) else { return nil }
    return CBUUID(string: string)
  }

  /// A company id as a number, or a hex string with or without "0x".
  static func companyId(_ value: Any) -> UInt16? {
    if let number = value as? Int { return UInt16(exactly: number) }
    guard let string = value as? String else { return nil }
    let hex = string.lowercased().hasPrefix("0x") ? String(string.dropFirst(2)) : string
    return UInt16(hex, radix: 16)
  }
}

/// What the picker session reports, as the core needs it.
enum AccessorySessionEvent: Equatable {
  case activated
  case accessoryAdded(bluetoothIdentifier: UUID?)
  case pickerDidDismiss
  case invalidated
  case other
}

/// Why `showPicker` failed (ASError's codes, grouped).
struct AccessoryPickerFailure: Error {
  enum Kind {
    case userCancelled
    case discoveryTimeout
    case alreadyActive
    case restricted
    case invalidRequest
    case other
  }

  let kind: Kind
  let message: String
  let code: Int
}

/// ASAccessorySession, as the picker uses it.
protocol AccessorySessionLike: AnyObject {
  func activate(on queue: DispatchQueue, eventHandler: @escaping (AccessorySessionEvent) -> Void)
  func showPicker(for items: [AccessoryPickerItemSpec], completion: @escaping (AccessoryPickerFailure?) -> Void)
  func invalidate()
}

/// Shows the picker, one at a time, and answers with the picked accessory's Bluetooth identifier
/// (the CoreBluetooth peripheral id), or nil when nothing was picked. A picker still open after
/// `timeout` is closed by invalidating the session (rule 4); the next picker starts a new one.
///
/// Threading: on `queue` (the main queue: the picker is UI), where the session reports too.
final class AccessoryPicker {
  static let defaultTimeout: TimeInterval = 300

  private let makeSession: () -> AccessorySessionLike
  private let queue: DispatchQueue
  private let scheduler: Scheduling
  private var session: AccessorySessionLike?
  private var activated = false
  private var whenActivated: [() -> Void] = []
  private var showing: Showing?

  private final class Showing {
    let completion: (Result<UUID?, CoreError>) -> Void
    var timer: CancellableWork?
    var picked: UUID?
    var settled = false

    init(_ completion: @escaping (Result<UUID?, CoreError>) -> Void) {
      self.completion = completion
    }
  }

  init(queue: DispatchQueue, scheduler: Scheduling, makeSession: @escaping () -> AccessorySessionLike) {
    self.queue = queue
    self.scheduler = scheduler
    self.makeSession = makeSession
  }

  func show(
    _ items: [AccessoryPickerItemSpec],
    timeout: TimeInterval,
    completion: @escaping (Result<UUID?, CoreError>) -> Void
  ) {
    guard showing == nil else {
      return completion(.failure(CoreError(.invalidArgument, "The accessory picker is already showing")))
    }
    let current = Showing(completion)
    showing = current
    current.timer = scheduler.schedule(after: timeout) { [weak self] in
      guard let self, showing === current else { return }
      // Invalidating the session closes the picker; the next picker activates a new session.
      let session = self.session
      reset()
      session?.invalidate()
      finish(.failure(CoreError(.operationTimeout, "The accessory picker was open for \(Int(timeout)) s")))
    }
    withSession { [weak self] session in
      guard let self, showing === current else { return }
      session.showPicker(for: items) { [weak self] failure in
        self?.queue.async { self?.pickerCompleted(current, failure) }
      }
    }
  }

  // MARK: Private

  private func withSession(_ work: @escaping (AccessorySessionLike) -> Void) {
    if let session, activated {
      return work(session)
    }
    whenActivated.append { [weak self] in
      guard let session = self?.session else { return }
      work(session)
    }
    guard session == nil else { return }
    let created = makeSession()
    session = created
    created.activate(on: queue) { [weak self, weak created] event in
      guard let self, let created, session === created else { return }
      handle(event)
    }
  }

  private func handle(_ event: AccessorySessionEvent) {
    switch event {
    case .activated:
      activated = true
      let waiting = whenActivated
      whenActivated.removeAll()
      waiting.forEach { $0() }
    case let .accessoryAdded(identifier):
      showing?.picked = identifier
    case .pickerDidDismiss:
      finish(.success(showing?.picked))
    case .invalidated:
      reset()
      finish(.failure(CoreError(.operationCancelled, "The accessory session ended")))
    case .other:
      break
    }
  }

  private func pickerCompleted(_ current: Showing, _ failure: AccessoryPickerFailure?) {
    guard showing === current, let failure else { return }
    switch failure.kind {
    case .userCancelled, .discoveryTimeout:
      // Nothing picked: the person closed the picker, or no accessory showed up in time.
      finish(.success(nil))
    case .alreadyActive:
      finish(.failure(CoreError(.invalidArgument, "Another accessory picker is showing")))
    case .restricted:
      finish(.failure(CoreError(.bluetoothUnauthorized, "AccessorySetupKit is restricted on this device")))
    case .invalidRequest:
      finish(.failure(failed(.invalidArgument, failure)))
    case .other:
      finish(.failure(failed(.internal, failure)))
    }
  }

  private func failed(_ code: CoreError.Code, _ failure: AccessoryPickerFailure) -> CoreError {
    let message = "The accessory picker failed: \(failure.message)"
    return CoreError(code, message, nativeDomain: "ASErrorDomain", nativeCode: failure.code)
  }

  private func reset() {
    session = nil
    activated = false
    whenActivated.removeAll()
  }

  private func finish(_ result: Result<UUID?, CoreError>) {
    guard let current = showing, !current.settled else { return }
    current.settled = true
    current.timer?.cancel()
    showing = nil
    current.completion(result)
  }
}
