import ExpoModulesCore

struct ManufacturerDataRecord: Record {
  @Field var companyId: Int = 0
  @Field var data: Data?
  @Field var mask: Data?
}

struct IosScanOptionsRecord: Record {
  @Field var solicitedServices: [String] = []
}

/// JS `ScanOptions` (plan §5.3) after the TS layer normalized it. `android` is ignored here.
struct ScanOptionsRecord: Record {
  @Field var services: [String] = []
  @Field var allowDuplicates: Bool = false
  @Field var reportIntervalMs: Double = 0
  @Field var namePrefix: String?
  @Field var manufacturerData: [ManufacturerDataRecord] = []
  @Field var ios: IosScanOptionsRecord = IosScanOptionsRecord()

  var spec: ScanSpec {
    ScanSpec(
      services: services,
      allowDuplicates: allowDuplicates,
      reportInterval: reportIntervalMs / 1000,
      namePrefix: namePrefix,
      manufacturerData: manufacturerData.map {
        ManufacturerFilter(companyId: $0.companyId, data: $0.data, mask: $0.mask)
      },
      solicitedServices: ios.solicitedServices
    )
  }
}

struct IosConnectOptionsRecord: Record {
  @Field var notifyOnDisconnection: Bool = false
  @Field var enableAutoReconnect: Bool = false
}

/// JS `ReconnectPolicy` (plan §5.4) with the defaults applied; `maxAttempts` nil means no limit.
struct ReconnectPolicyRecord: Record {
  @Field var maxAttempts: Int?
  @Field var initialDelayMs: Double = 1_000
  @Field var maxDelayMs: Double = 30_000
  @Field var backoff: String = "exponential"

  func policy() throws -> ReconnectPolicy {
    if let maxAttempts, maxAttempts < 1 {
      throw CoreError(.invalidArgument, "Invalid connect option reconnect.maxAttempts: \(maxAttempts)")
    }
    guard initialDelayMs >= 0, maxDelayMs >= initialDelayMs else {
      throw CoreError(.invalidArgument, "Invalid connect option reconnect delays")
    }
    return ReconnectPolicy(
      maxAttempts: maxAttempts,
      initialDelay: initialDelayMs / 1000,
      maxDelay: maxDelayMs / 1000,
      exponential: backoff != "fixed"
    )
  }
}

/// JS `ConnectOptions` (plan §5.4) after the TS layer applied defaults: `timeoutMs` nil means none.
struct ConnectOptionsRecord: Record {
  @Field var timeoutMs: Double?
  @Field var autoDiscover: Bool = true
  /// Nil: no reconnection.
  @Field var reconnect: ReconnectPolicyRecord?
  @Field var restoreSubscriptionsOnReconnect: Bool = true
  @Field var keepAliveInBackground: Bool = false
  @Field var ios: IosConnectOptionsRecord = IosConnectOptionsRecord()

  func spec() throws -> ConnectSpec {
    if let timeoutMs, !(timeoutMs > 0) {
      throw CoreError(.invalidArgument, "Invalid connect option timeoutMs: \(timeoutMs)")
    }
    // P3-01: iOS keeps an app's connections in the background with the bluetooth-central mode.
    let modes = Bundle.main.infoDictionary?["UIBackgroundModes"] as? [String] ?? []
    if keepAliveInBackground, !modes.contains("bluetooth-central") {
      throw CoreError(
        .misconfigured,
        "keepAliveInBackground needs the bluetooth-central background mode: set ios.backgroundModes ['central'] "
          + "in the expo-ble-kit config plugin options (\(CoreError.setupGuide))"
      )
    }
    return ConnectSpec(
      timeout: timeoutMs.map { $0 / 1000 },
      notifyOnDisconnection: ios.notifyOnDisconnection,
      autoDiscover: autoDiscover,
      reconnect: try reconnect?.policy(),
      restoreSubscriptions: restoreSubscriptionsOnReconnect,
      enableAutoReconnect: ios.enableAutoReconnect
    )
  }
}

/// Payload of a peripheral's `connectionStateChange` event. `code` and `message` describe an
/// unexpected end; `message` may carry `[blekit]` details for `BleError.fromNative`.
struct ConnectionStateEventRecord: Record {
  @Field var state: String = "disconnected"
  @Field var code: String?
  @Field var message: String?
}

/// Where an attribute operation goes and how (plan §5.4), after the TS layer normalized the UUIDs
/// and applied the defaults.
struct AttributeRequestRecord: Record {
  @Field var service: String = ""
  @Field var characteristic: String = ""
  @Field var descriptor: String?
  @Field var withResponse: Bool = true
  @Field var timeoutMs: Double = 10_000
  /// Set when JS may cancel the operation (an `AbortSignal`); see `cancelOperation`.
  @Field var operationId: Int?
  /// Set for a batched subscribe (P2-04).
  @Field var batch: BatchRecord?

  var path: AttributePath {
    AttributePath(service: service, characteristic: characteristic, descriptor: descriptor)
  }

  var timeout: TimeInterval {
    timeoutMs / 1000
  }
}

/// A batched subscription's options (P2-04). The TS layer validates them and applies the defaults.
struct BatchRecord: Record {
  @Field var intervalMs: Double = 16
  @Field var maxItems: Int = BatchSpec.defaultMaxItems

  var spec: BatchSpec {
    BatchSpec(interval: max(intervalMs, 1) / 1000, maxItems: maxItems)
  }
}

/// Payload of a peripheral's `notificationBatch` event (P2-04): the values in one buffer, cut by
/// `lengths` in JS, which crosses the bridge as fewer objects.
struct NotificationBatchEventRecord: Record {
  @Field var subscriptionId: Int = 0
  @Field var bytes = Data()
  @Field var lengths: [Int] = []
  @Field var timestamps: [Double] = []
  @Field var dropped: Int = 0

  init() {}

  init(subscriptionId: Int, batch: NotificationBatch) {
    self.subscriptionId = subscriptionId
    bytes = batch.values.reduce(into: Data()) { $0.append($1) }
    lengths = batch.values.map(\.count)
    timestamps = batch.timestamps
    dropped = batch.dropped
  }
}

/// Payload of a peripheral's `notification` event (plan §5.4).
struct NotificationEventRecord: Record {
  @Field var service: String = ""
  @Field var characteristic: String = ""
  @Field var value = Data()
  @Field var timestamp: Double = 0
}

/// Payload of a peripheral's `mtuChange` event (P1-09).
struct MtuChangeEventRecord: Record {
  @Field var mtu: Int = 23
}

/// Payload of a peripheral's `servicesChanged` event (P2-06): the new services are in `services`.
struct ServicesChangedEventRecord: Record {}

/// Payload of a peripheral's `streamProgress` event (P2-03): bytes a writeStream wrote so far.
struct StreamProgressEventRecord: Record {
  @Field var operationId: Int?
  @Field var sent: Int = 0
  @Field var total: Int = 0
}

/// Payload of a peripheral's `subscriptionEnded` event (P2-01): a subscription that ended while its
/// connection reconnects.
struct SubscriptionEndedEventRecord: Record {
  @Field var subscriptionId: Int = 0
  @Field var code: String = ""
  @Field var message: String = ""
}
