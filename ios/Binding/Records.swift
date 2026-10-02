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
}

/// JS `ConnectOptions` (plan §5.4) after the TS layer applied defaults: `timeoutMs` nil means none.
struct ConnectOptionsRecord: Record {
  @Field var timeoutMs: Double?
  @Field var ios: IosConnectOptionsRecord = IosConnectOptionsRecord()

  func spec() throws -> ConnectSpec {
    if let timeoutMs, !(timeoutMs > 0) {
      throw CoreError(.invalidArgument, "Invalid connect option timeoutMs: \(timeoutMs)")
    }
    return ConnectSpec(timeout: timeoutMs.map { $0 / 1000 }, notifyOnDisconnection: ios.notifyOnDisconnection)
  }
}

/// Payload of a peripheral's `connectionStateChange` event. `code` and `message` describe an
/// unexpected end; `message` may carry `[blekit]` details for `BleError.fromNative`.
struct ConnectionStateEventRecord: Record {
  @Field var state: String = "disconnected"
  @Field var code: String?
  @Field var message: String?
}
