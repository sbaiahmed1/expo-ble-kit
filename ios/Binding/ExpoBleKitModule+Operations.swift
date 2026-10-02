import ExpoModulesCore

// The module's peripheral operations: each hops onto the engine's queue and settles its promise.

extension ExpoBleKitModule {
  func connect(_ id: String, options: ConnectOptionsRecord, promise: Promise) {
    let engine = self.engine
    engine.queue.async {
      do {
        try engine.connect(id, spec: options.spec()) { error in
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

  func read(_ id: String, _ request: Request, _ promise: Promise) {
    attributeOperation(id, promise) { session, done in
      session.read(request.path, timeout: request.timeout) { done($0.map { $0 }) }
    }
  }

  func write(_ id: String, _ request: Request, _ value: Data, _ promise: Promise) {
    attributeOperation(id, promise) { session, done in
      session.write(request.path, value: value, withResponse: request.withResponse, timeout: request.timeout) {
        done($0.map { _ in nil })
      }
    }
  }

  func readDescriptor(_ id: String, _ request: Request, _ promise: Promise) {
    attributeOperation(id, promise) { session, done in
      session.readDescriptor(request.path, timeout: request.timeout) { done($0.map { $0 }) }
    }
  }

  func writeDescriptor(_ id: String, _ request: Request, _ value: Data, _ promise: Promise) {
    attributeOperation(id, promise) { session, done in
      session.writeDescriptor(request.path, value: value, timeout: request.timeout) { done($0.map { _ in nil }) }
    }
  }

  func subscribe(_ id: String, _ request: Request, _ subscriptionId: Int, _ mode: String, _ promise: Promise) {
    attributeOperation(id, promise) { session, done in
      guard let subscribeMode = SubscribeMode(rawValue: mode) else {
        return done(.failure(CoreError(.invalidArgument, "Invalid subscribe mode: \(mode)")))
      }
      session.subscribe(request.path, mode: subscribeMode, subscriptionId: subscriptionId, timeout: request.timeout) {
        done($0.map { nil })
      }
    }
  }

  /// Runs an attribute operation on the engine's queue and settles `promise` with its value
  /// (`Data`, or nil for writes) or its error.
  func attributeOperation(
    _ id: String,
    _ promise: Promise,
    _ operation: @escaping (PeripheralSession, @escaping (Result<Data?, CoreError>) -> Void) -> Void
  ) {
    let engine = self.engine
    engine.queue.async {
      let done: (Result<Data?, CoreError>) -> Void = { result in
        switch result {
        case let .success(value):
          promise.resolve(value)
        case let .failure(error):
          promise.reject(BleKitException(error))
        }
      }
      guard let session = engine.session(id, else: done) else {
        return
      }
      operation(session, done)
    }
  }

  func discover(_ id: String, services: [String]?, timeoutMs: Double, promise: Promise) {
    let engine = self.engine
    engine.queue.async {
      engine.discover(id, filter: services, timeout: timeoutMs / 1000) { result in
        switch result {
        case let .success(found):
          promise.resolve(found)
        case let .failure(error):
          promise.reject(BleKitException(error))
        }
      }
    }
  }

  /// iOS ids are UUIDs; the object is keyed by their upper-case form, as CoreBluetooth reports them.
  func peripheral(_ id: String) -> PeripheralObject {
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

  func existingPeripheral(_ id: String) -> PeripheralObject? {
    peripheralsLock.lock()
    defer { peripheralsLock.unlock() }
    return peripherals.object(forKey: id as NSString)
  }

  /// Runs `work` on the engine's queue and settles `promise` with its result or error.
  func settle(_ promise: Promise, _ work: @escaping (CentralEngine) throws -> Any?) {
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
