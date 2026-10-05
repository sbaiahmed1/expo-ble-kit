import CoreBluetooth
import ExpoModulesCore

/// JS `AdvertisingData` after the TS layer validated it (plan §5.5, P4-03).
struct AdvertisingDataRecord: Record {
  @Field var localName: String?
  @Field var serviceUuids: [String] = []
  @Field var manufacturerData: AdvertisingManufacturerRecord?
  @Field var serviceData: [ServiceDataRecord] = []
  @Field var includeTxPower: Bool = false
}

struct AdvertisingManufacturerRecord: Record {
  @Field var companyId: Int = 0
  @Field var data = Data()
}

struct ServiceDataRecord: Record {
  @Field var uuid: String = ""
  @Field var data = Data()
}

/// JS `AdvertisingOptions`: iOS reads `connectable` only, to warn; the `android` options don't apply.
struct AdvertisingOptionsRecord: Record {
  @Field var connectable: Bool = true
}

// The peripheral role's advertiser (P4-03): one advertisement at a time, on the peripheral queue.
extension ExpoBleKitModule {
  func startAdvertising(_ data: AdvertisingDataRecord, _ options: AdvertisingOptionsRecord, _ promise: Promise) {
    do {
      try Self.checkAuthorization("Advertising")
    } catch {
      return promise.reject(error)
    }
    let spec = AdvertisingSpec(
      localName: data.localName,
      serviceUUIDs: data.serviceUuids.map { CBUUID(string: $0) },
      hasManufacturerData: data.manufacturerData != nil,
      hasServiceData: !data.serviceData.isEmpty,
      includeTxPower: data.includeTxPower,
      connectable: options.connectable
    )
    peripheralQueue.async {
      self.sharedAdvertiser().start(spec) { result in
        switch result {
        case let .success(id): promise.resolve(id)
        case let .failure(error): promise.reject(BleKitException(error))
        }
      }
    }
  }

  func stopAdvertising(_ id: Int) {
    peripheralQueue.async { self.advertiser?.stop(id) }
  }

  /// On the peripheral queue. Shares the manager with the GATT server.
  private func sharedAdvertiser() -> Advertiser {
    if let advertiser { return advertiser }
    let advertiser = Advertiser(manager: sharedPeripheralManager(), scheduler: QueueScheduler(queue: peripheralQueue))
    // Weak: the module keeps the advertiser, which keeps this closure.
    advertiser.onWarning = { [weak module = self] warning in
      guard let engine = module?.engine else { return }
      engine.queue.async { engine.warn(warning) }
    }
    self.advertiser = advertiser
    return advertiser
  }
}
