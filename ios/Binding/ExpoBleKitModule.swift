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

public class ExpoBleKitModule: Module {
  /// One JS object per peripheral id while JS holds it (plan §4.5). Guarded by `peripheralsLock`.
  private let peripherals = NSMapTable<NSString, PeripheralObject>.strongToWeakObjects()
  private let peripheralsLock = NSLock()

  private lazy var engine: CentralEngine = {
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

      Property("id") { (ref: PeripheralObject) in
        ref.id
      }

      Property("state") { (ref: PeripheralObject) in
        self.engine.connectionState(ref.id)
      }

      AsyncFunction("connect") { (ref: PeripheralObject, options: ConnectOptionsRecord, promise: Promise) in
        let engine = self.engine
        engine.queue.async {
          do {
            try engine.connect(ref.id, spec: options.spec()) { error in
              if let error {
                promise.reject(BleKitException(error))
              } else {
                promise.resolve()
              }
            }
          } catch let error as CoreError {
            promise.reject(BleKitException(error))
          } catch {
            promise.reject(error)
          }
        }
      }

      AsyncFunction("disconnect") { (ref: PeripheralObject, promise: Promise) in
        let engine = self.engine
        engine.queue.async {
          engine.disconnect(ref.id) { promise.resolve() }
        }
      }
    }
  }

  /// iOS ids are UUIDs; the object is keyed by their upper-case form, as CoreBluetooth reports them.
  private func peripheral(_ id: String) -> PeripheralObject {
    let key = (UUID(uuidString: id)?.uuidString ?? id) as NSString
    peripheralsLock.lock()
    defer { peripheralsLock.unlock() }
    if let existing = peripherals.object(forKey: key) {
      return existing
    }
    let created = PeripheralObject(id: key as String)
    peripherals.setObject(created, forKey: key)
    return created
  }

  private func existingPeripheral(_ id: String) -> PeripheralObject? {
    peripheralsLock.lock()
    defer { peripheralsLock.unlock() }
    return peripherals.object(forKey: id as NSString)
  }

  /// Runs `work` on the engine's queue and settles `promise` with its result or error.
  private func settle(_ promise: Promise, _ work: @escaping (CentralEngine) throws -> Any?) {
    let engine = self.engine
    engine.queue.async {
      do {
        promise.resolve(try work(engine))
      } catch let error as CoreError {
        promise.reject(BleKitException(error))
      } catch {
        promise.reject(error)
      }
    }
  }
}
