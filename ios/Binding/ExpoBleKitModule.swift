import ExpoModulesCore

/// A core error as a coded JS exception (plan §4.5).
final class BleKitException: Exception, @unchecked Sendable {
  init(_ error: CoreError) {
    super.init(name: "BleError", description: error.jsMessage, code: error.code.rawValue)
  }

  // Expo uses `debugDescription` as the JS message, which would add the class name and the Swift
  // file and line around it. `BleError.fromNative` expects the plain message.
  override var debugDescription: String {
    reason
  }
}

/// Attribute operations take one request: where, how, and the timeout.
typealias Request = AttributeRequestRecord
/// Peripheral functions take their JS object first.
typealias Handle = PeripheralObject

public class ExpoBleKitModule: Module {
  /// One JS object per peripheral id while JS holds it (plan §4.5). Guarded by `peripheralsLock`.
  let peripherals = NSMapTable<NSString, PeripheralObject>.strongToWeakObjects()
  let peripheralsLock = NSLock()

  /// The peripheral role's queue (plan §4.7), its manager once a server opened or advertising
  /// started, the open server and the advertiser.
  let peripheralQueue = DispatchQueue(label: "expo.blekit.peripheral")
  var peripheralManager: CBPeripheralManagerAdapter?
  var openServer: GattServerObject?
  var advertiser: Advertiser?
  /// L2CAP servers on the same manager (P5-03).
  var l2capPublisher: L2CAPPublisher?

  lazy var engine: CentralEngine = {
    let engine = CentralEngine(queue: DispatchQueue(label: "expo.blekit.central"))
    engine.onStateChange = { [weak self] state in
      self?.sendEvent("stateChange", ["state": state.rawValue])
      // iOS removes the published services with the adapter: the server closes (plan §5.5).
      if state != .poweredOn, let self { self.peripheralQueue.async { self.closeServer() } }
    }
    engine.scanController.onResults = { [weak self] sessionId, results in
      self?.sendEvent("scanResults", ["sessionId": sessionId, "results": results])
    }
    engine.scanController.onError = { [weak self] sessionId, error in
      self?.engine.logger.log(.warn) { "scan session \(sessionId) ended: \(error.code.rawValue) \(error.message)" }
      self?.sendEvent(
        "scanError",
        ["sessionId": sessionId, "code": error.code.rawValue, "message": error.jsMessage]
      )
    }
    engine.onConnectionStateChange = { [weak self] peripheralId, state, error in
      guard let peripheral = self?.existingPeripheral(peripheralId) else {
        return
      }
      var event = ConnectionStateEventRecord()
      event.state = state.js
      event.code = error?.code.rawValue
      event.message = error?.jsMessage
      peripheral.emit(event: "connectionStateChange", payload: event)
    }
    engine.onNotification = { [weak self] peripheralId, service, characteristic, value, timestamp in
      guard let peripheral = self?.existingPeripheral(peripheralId) else {
        return
      }
      var event = NotificationEventRecord()
      event.service = service
      event.characteristic = characteristic
      event.value = value
      event.timestamp = timestamp
      peripheral.emit(event: "notification", payload: event)
    }
    engine.onSubscriptionEnded = { [weak self] peripheralId, subscriptionId, error in
      var event = SubscriptionEndedEventRecord()
      event.subscriptionId = subscriptionId
      event.code = error.code.rawValue
      event.message = error.jsMessage
      self?.existingPeripheral(peripheralId)?.emit(event: "subscriptionEnded", payload: event)
    }
    engine.onNotificationBatch = { [weak self] peripheralId, subscriptionId, batch in
      let event = NotificationBatchEventRecord(subscriptionId: subscriptionId, batch: batch)
      self?.existingPeripheral(peripheralId)?.emit(event: "notificationBatch", payload: event)
    }
    engine.onServicesChanged = { [weak self] peripheralId in
      self?.existingPeripheral(peripheralId)?.emit(event: "servicesChanged", payload: ServicesChangedEventRecord())
    }
    engine.onWarning = { [weak self] warning in
      self?.sendEvent("warning", ["code": warning.code.rawValue, "message": warning.jsMessage])
    }
    engine.onMtuChange = { [weak self] peripheralId, mtu in
      var event = MtuChangeEventRecord()
      event.mtu = mtu
      self?.existingPeripheral(peripheralId)?.emit(event: "mtuChange", payload: event)
    }
    engine.logger.platform = BleLogger.osLog
    return engine
  }()

  /// Plan §4.16: the native log level.
  func setLogLevel(_ level: String) throws {
    guard let logLevel = LogLevel(rawValue: level) else {
      throw BleKitException(CoreError(.invalidArgument, "Invalid log level: \(level)"))
    }
    engine.logger.level = logLevel
  }

  /// Plan §4.16: JS gets `log` events only while it has a log handler.
  func setLogForwarding(_ enabled: Bool) {
    engine.logger.forward = enabled ? { [weak self] entry in
      var event: [String: Any] = ["level": entry.level.rawValue, "message": entry.message, "timestamp": entry.timestamp]
      event["peripheralId"] = entry.peripheralId
      event["opId"] = entry.opId
      self?.sendEvent("log", event)
    } : nil
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoBleKit")

    Events("stateChange", "scanResults", "scanError", "warning", "log")

    Function("setLogLevel") { (level: String) in try self.setLogLevel(level) }

    Function("setLogForwarding") { (enabled: Bool) in self.setLogForwarding(enabled) }

    // Reading or observing the state starts the manager when that can't show the prompt.
    OnStartObserving("stateChange") {
      self.engine.queue.async { self.engine.activateIfAuthorized() }
    }

    OnAppEntersForeground {
      self.engine.queue.async { self.engine.refresh() }
    }

    Function("getState") { () -> String in
      let engine = self.engine
      engine.queue.async { engine.activateIfAuthorized() }
      return engine.state.rawValue
    }

    AsyncFunction("getPermissionsAsync") { (promise: Promise) in
      self.settle(promise) { engine in try engine.permissions().dictionary }
    }

    // Async functions run in call order on Expo's serial queue, so a stop never overtakes its start.
    AsyncFunction("startScan") { (sessionId: Int, options: ScanOptionsRecord, promise: Promise) in
      let spec = options.spec
      self.settle(promise) { engine -> Any? in
        try engine.startScan(sessionId, spec: spec)
        return nil
      }
    }

    AsyncFunction("stopScan") { (sessionId: Int) in self.engine.queue.async { self.engine.stopScan(sessionId) } }

    // Never touches CoreBluetooth (plan §5.2).
    Function("getPeripheral") { (id: String) -> PeripheralObject in self.peripheral(id) }

    peripheralClass()

    // The peripheral role (P4): the GATT server and advertising.
    AsyncFunction("openGattServer", openGattServer)
    gattServerClass()
    AsyncFunction("startAdvertising", startAdvertising)
    AsyncFunction("stopAdvertising", stopAdvertising)

    // P5-03: L2CAP servers and channels.
    AsyncFunction("publishL2CAPChannel", publishL2CAPChannel)
    l2capServerClass()
    l2capChannelClass()

    // Ids only: JS turns them into peripherals with getPeripheral().
    AsyncFunction("getKnownPeripherals") { (ids: [String], promise: Promise) in
      self.peripheralIds(promise) { engine, done in try engine.knownPeripherals(ids, completion: done) }
    }

    AsyncFunction("getSystemConnectedPeripherals") { (services: [String], promise: Promise) in
      self.peripheralIds(promise) { engine, done in try engine.systemConnectedPeripherals(services, completion: done) }
    }

    AsyncFunction("getDiagnosticsAsync") { (promise: Promise) in
      self.settle(promise) { engine in engine.diagnostics() }
    }

    // The request flags don't matter on iOS: one authorization covers every capability.
    AsyncFunction("requestPermissionsAsync") { (_: [String: Bool]?, promise: Promise) in
      self.requestPermissions(promise)
    }
  }

  /// Peripherals only come from getPeripheral(), one object per id.
  private static func useGetPeripheral() -> Exception {
    Exception(name: "BleError", description: "Use getPeripheral(id) to get a peripheral", code: "INVALID_ARGUMENT")
  }

  private func peripheralClass() -> ClassDefinition {
    Class(PeripheralObject.self) {
      Constructor { () -> PeripheralObject in throw ExpoBleKitModule.useGetPeripheral() }

      // Synchronous reads of the engine's snapshots (plan §4.7).
      Property("id") { (ref: PeripheralObject) in ref.id }
      Property("state") { (ref: PeripheralObject) in self.engine.connectionState(ref.id) }
      Property("services") { (ref: PeripheralObject) in self.engine.services(ref.id) }
      Property("mtu") { (ref: PeripheralObject) in self.engine.mtu(ref.id) }
      Property("name") { (ref: PeripheralObject) in self.engine.name(ref.id) }

      // UUIDs arrive normalized and timeouts always set: the TS layer applies the defaults (rule 4).
      AsyncFunction("read") { (ref: PeripheralObject, request: Request, promise: Promise) in
        self.read(ref.id, request, promise)
      }

      AsyncFunction("write") { (ref: PeripheralObject, request: Request, value: Data, promise: Promise) in
        self.write(ref.id, request, value, promise)
      }

      AsyncFunction("writeStream") { (ref: Handle, request: Request, data: Data, chunkSize: Int?, promise: Promise) in
        self.writeStream(ref, request, data, chunkSize, promise)
      }

      AsyncFunction("readDescriptor") { (ref: PeripheralObject, request: Request, promise: Promise) in
        self.readDescriptor(ref.id, request, promise)
      }

      AsyncFunction("writeDescriptor") { (ref: PeripheralObject, request: Request, value: Data, promise: Promise) in
        self.writeDescriptor(ref.id, request, value, promise)
      }

      // JS numbers its subscriptions; one CCCD per characteristic is shared by them (plan §5.4).
      AsyncFunction("subscribe") { (ref: PeripheralObject, request: Request, id: Int, mode: String, promise: Promise) in
        self.subscribe(ref.id, request, id, mode, promise)
      }

      AsyncFunction("unsubscribe") { (ref: PeripheralObject, id: Int, timeoutMs: Double, promise: Promise) in
        self.unsubscribe(ref.id, id, timeoutMs, promise)
      }

      // iOS answers at once: there is nothing to time out or cancel.
      AsyncFunction("requestMtu") { (ref: PeripheralObject, mtu: Int, _: Double, _: Int?, promise: Promise) in
        self.requestMtu(ref.id, mtu, promise)
      }

      AsyncFunction("readRssi") { (ref: PeripheralObject, timeoutMs: Double, operationId: Int?, promise: Promise) in
        self.readRssi(ref.id, timeoutMs, operationId, promise)
      }

      AsyncFunction("cancelOperation") { (ref: PeripheralObject, operationId: Int) in
        self.cancelOperation(ref.id, operationId)
      }

      // P5-03: `secure` is Android's; on iOS the publishing side decides.
      AsyncFunction("openL2CAPChannel") { (ref: Handle, psm: Int, _: Bool, wait: Double, id: Int?, promise: Promise) in
        self.openL2CAPChannel(ref, psm, wait, id, promise)
      }

      // `services` nil discovers everything; the TS layer always passes a timeout (rule 4).
      AsyncFunction("discover") { (ref: Handle, filter: [String]?, timeoutMs: Double, opId: Int?, promise: Promise) in
        self.discover(ref.id, services: filter, timeoutMs: timeoutMs, operationId: opId, promise: promise)
      }

      AsyncFunction("connect") { (ref: PeripheralObject, options: ConnectOptionsRecord, promise: Promise) in
        self.connect(ref.id, options: options, promise: promise)
      }

      AsyncFunction("disconnect") { (ref: PeripheralObject, promise: Promise) in
        self.disconnect(ref.id, promise)
      }
    }
  }
}
