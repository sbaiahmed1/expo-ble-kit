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
