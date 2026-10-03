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
      session.read(request.path, timeout: request.timeout, operationId: request.operationId) { done($0.map { $0 }) }
    }
  }

  func write(_ id: String, _ request: Request, _ value: Data, _ promise: Promise) {
    attributeOperation(id, promise) { session, done in
      session.write(
        request.path,
        value: value,
        withResponse: request.withResponse,
        timeout: request.timeout,
        operationId: request.operationId
      ) {
        done($0.map { _ in nil })
      }
    }
  }

  /// Progress goes to the peripheral object as `streamProgress`, keyed by the operation id.
  func writeStream(_ ref: PeripheralObject, _ request: Request, _ data: Data, _ chunkSize: Int?, _ promise: Promise) {
    attributeOperation(ref.id, promise) { session, done in
      let stream = PeripheralSession.StreamRequest(
        data: data,
        withResponse: request.withResponse,
        chunkSize: chunkSize,
        timeout: request.timeout,
        operationId: request.operationId
      )
      session.writeStream(
        request.path,
        stream,
        onProgress: { [weak ref] sent, total in
          var event = StreamProgressEventRecord()
          event.operationId = request.operationId
          event.sent = sent
          event.total = total
          ref?.emit(event: "streamProgress", payload: event)
        },
        completion: { done($0.map { _ in nil }) }
      )
    }
  }

  func readDescriptor(_ id: String, _ request: Request, _ promise: Promise) {
    attributeOperation(id, promise) { session, done in
      session.readDescriptor(request.path, timeout: request.timeout, operationId: request.operationId) {
        done($0.map { $0 })
      }
    }
  }

  func writeDescriptor(_ id: String, _ request: Request, _ value: Data, _ promise: Promise) {
    attributeOperation(id, promise) { session, done in
      session.writeDescriptor(
        request.path,
        value: value,
        timeout: request.timeout,
        operationId: request.operationId
      ) {
        done($0.map { _ in nil })
      }
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

  func unsubscribe(_ id: String, _ subscriptionId: Int, _ timeoutMs: Double, _ promise: Promise) {
    attributeOperation(id, promise) { session, done in
      session.unsubscribe(subscriptionId, timeout: timeoutMs / 1000) { done($0.map { nil }) }
    }
  }

  func disconnect(_ id: String, _ promise: Promise) {
    let engine = self.engine
    engine.queue.async {
      engine.disconnect(id) { promise.resolve() }
    }
  }

  /// iOS can't negotiate: resolves the current MTU after checking `mtu` (plan §5.4).
  func requestMtu(_ id: String, _ mtu: Int, _ promise: Promise) {
    attributeOperation(id, promise) { session, done in
      session.requestMtu(mtu) { done($0.map { $0 }) }
    }
  }

  func readRssi(_ id: String, _ timeoutMs: Double, _ operationId: Int?, _ promise: Promise) {
    attributeOperation(id, promise) { session, done in
      session.readRssi(timeout: timeoutMs / 1000, operationId: operationId) { done($0.map { $0 }) }
    }
  }

  /// Calls run in order on Expo's queue and then on the engine's queue, so a cancel never overtakes
  /// the operation it cancels.
  func cancelOperation(_ id: String, _ operationId: Int) {
    let engine = self.engine
    engine.queue.async { engine.cancelOperation(id, operationId: operationId) }
  }

  /// Runs an attribute operation on the engine's queue and settles `promise` with its value
  /// (`Data` or a number, nil for writes) or its error.
  func attributeOperation(
    _ id: String,
    _ promise: Promise,
    _ operation: @escaping (PeripheralSession, @escaping (Result<Any?, CoreError>) -> Void) -> Void
  ) {
    let engine = self.engine
    engine.queue.async {
      let done: (Result<Any?, CoreError>) -> Void = { result in
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

  func discover(_ id: String, services: [String]?, timeoutMs: Double, operationId: Int?, promise: Promise) {
    let engine = self.engine
    engine.queue.async {
      engine.discover(id, filter: services, timeout: timeoutMs / 1000, operationId: operationId) { result in
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

  func requestPermissions(_ promise: Promise) {
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

  /// Runs a lookup that answers with peripheral ids on the engine's queue, and settles `promise`.
  func peripheralIds(
    _ promise: Promise,
    _ lookup: @escaping (CentralEngine, @escaping (Result<[String], CoreError>) -> Void) throws -> Void
  ) {
    let engine = self.engine
    engine.queue.async {
      do {
        try lookup(engine) { result in
          switch result {
          case let .success(ids):
            promise.resolve(ids)
          case let .failure(error):
            promise.reject(BleKitException(error))
          }
        }
      } catch let error as CoreError {
        promise.reject(BleKitException(error))
      } catch {
        promise.reject(error)
      }
    }
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
