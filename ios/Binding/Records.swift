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
  @Field var ios: IosConnectOptionsRecord = IosConnectOptionsRecord()

  func spec() throws -> ConnectSpec {
    if let timeoutMs, !(timeoutMs > 0) {
      throw CoreError(.invalidArgument, "Invalid connect option timeoutMs: \(timeoutMs)")
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

  var path: AttributePath {
    AttributePath(service: service, characteristic: characteristic, descriptor: descriptor)
  }

  var timeout: TimeInterval {
    timeoutMs / 1000
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
