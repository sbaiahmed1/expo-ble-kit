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

public class ExpoBleKitModule: Module {
  /// One JS object per peripheral id while JS holds it (plan §4.5). Guarded by `peripheralsLock`.
  let peripherals = NSMapTable<NSString, PeripheralObject>.strongToWeakObjects()
  let peripheralsLock = NSLock()

  lazy var engine: CentralEngine = {
    let engine = CentralEngine(queue: DispatchQueue(label: "expo.blekit.central"))
    engine.onStateChange = { [weak self] state in
      self?.sendEvent("stateChange", ["state": state.rawValue])
    }
    engine.scanController.onResults = { [weak self] sessionId, results in
      self?.sendEvent("scanResults", ["sessionId": sessionId, "results": results])
    }
    engine.scanController.onError = { [weak self] sessionId, error in
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
    engine.onMtuChange = { [weak self] peripheralId, mtu in
      var event = MtuChangeEventRecord()
      event.mtu = mtu
      self?.existingPeripheral(peripheralId)?.emit(event: "mtuChange", payload: event)
    }
    return engine
  }()

  public func definition() -> ModuleDefinition {
    Name("ExpoBleKit")

    Events("stateChange", "scanResults", "scanError", "warning")

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

    AsyncFunction("stopScan") { (sessionId: Int) in
      let engine = self.engine
      engine.queue.async { engine.stopScan(sessionId) }
    }

    // Never touches CoreBluetooth (plan §5.2).
    Function("getPeripheral") { (id: String) -> PeripheralObject in
      self.peripheral(id)
    }

    peripheralClass()

    AsyncFunction("getDiagnosticsAsync") { (promise: Promise) in
      self.settle(promise) { engine in engine.diagnostics() }
    }

    // The request flags don't matter on iOS: one authorization covers every capability.
    AsyncFunction("requestPermissionsAsync") { (_: [String: Bool]?, promise: Promise) in
      let engine = self.engine
      engine.queue.async {
        engine.requestPermissions { result in
          switch result {
          case let .success(permissions):
            promise.resolve(permissions.dictionary)
          case let .failure(error):
            promise.reject(BleKitException(error))
          }
        }
      }
    }
  }
  private func peripheralClass() -> ClassDefinition {
    Class(PeripheralObject.self) {
      // Peripherals only come from getPeripheral(), one object per id.
      Constructor { () -> PeripheralObject in
        throw Exception(
          name: "BleError",
          description: "Use getPeripheral(id) to get a peripheral",
          code: "INVALID_ARGUMENT"
        )
      }

      // Synchronous reads of the engine's snapshots (plan §4.7).
      Property("id") { (ref: PeripheralObject) in ref.id }
      Property("state") { (ref: PeripheralObject) in self.engine.connectionState(ref.id) }
      Property("services") { (ref: PeripheralObject) in self.engine.services(ref.id) }
      Property("mtu") { (ref: PeripheralObject) in self.engine.mtu(ref.id) }

      // UUIDs arrive normalized and timeouts always set: the TS layer applies the defaults (rule 4).
      AsyncFunction("read") { (ref: PeripheralObject, request: Request, promise: Promise) in
        self.read(ref.id, request, promise)
      }

      AsyncFunction("write") { (ref: PeripheralObject, request: Request, value: Data, promise: Promise) in
        self.write(ref.id, request, value, promise)
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

      AsyncFunction("requestMtu") { (ref: PeripheralObject, mtu: Int, _: Double, promise: Promise) in
        self.requestMtu(ref.id, mtu, promise)
      }

      AsyncFunction("readRssi") { (ref: PeripheralObject, timeoutMs: Double, promise: Promise) in
        self.readRssi(ref.id, timeoutMs, promise)
      }

      // `services` nil discovers everything; the TS layer always passes a timeout (rule 4).
      AsyncFunction("discover") { (ref: PeripheralObject, services: [String]?, timeoutMs: Double, promise: Promise) in
        self.discover(ref.id, services: services, timeoutMs: timeoutMs, promise: promise)
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
