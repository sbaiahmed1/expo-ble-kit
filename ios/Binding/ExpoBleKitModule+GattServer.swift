import CoreBluetooth
import ExpoModulesCore

// The peripheral role's GATT server (P4-01): one at a time, on the peripheral queue (plan §4.7).
extension ExpoBleKitModule {
  func openGattServer(_ services: [ServerServiceRecord], _ promise: Promise) {
    let specs: [ServerServiceSpec]
    do {
      specs = try services.map { try $0.spec() }
      try Self.checkAuthorization("A GATT server")
    } catch let error as BleKitException {
      return promise.reject(error)
    } catch {
      return promise.reject(BleKitException(CoreError(.internal, "\(error)")))
    }
    peripheralQueue.async {
      guard self.openServer == nil else {
        let error = CoreError(.invalidArgument, "A GATT server is already open: close it first")
        return promise.reject(BleKitException(error))
      }
      let manager = self.sharedPeripheralManager()
      let ref = GattServerObject()
      let server = GattServer(services: specs, manager: manager, scheduler: QueueScheduler(queue: self.peripheralQueue))
      server.listener = ref
      // Weak: the module keeps the server object, which keeps this closure.
      ref.onWarning = { [weak module = self] warning in
        guard let engine = module?.engine else { return }
        engine.queue.async { engine.warn(warning) }
      }
      ref.server = server
      self.openServer = ref
      server.open { error in
        if let error {
          ref.server = nil
          self.openServer = nil
          promise.reject(BleKitException(error))
        } else {
          promise.resolve(ref)
        }
      }
    }
  }

  /// The prompt only comes from requestPermissionsAsync(): the peripheral role never shows it.
  static func checkAuthorization(_ what: String) throws {
    switch CBManager.authorization {
    case .allowedAlways:
      return
    case .notDetermined:
      throw BleKitException(
        CoreError(.permissionDenied, "\(what) needs Bluetooth permission. Call requestPermissionsAsync() first.")
      )
    default:
      throw BleKitException(CoreError(.bluetoothUnauthorized, "The app may not use Bluetooth"))
    }
  }

  /// The peripheral manager of the server and the advertiser, created on first use. On the
  /// peripheral queue.
  func sharedPeripheralManager() -> CBPeripheralManagerAdapter {
    if let peripheralManager { return peripheralManager }
    let manager = CBPeripheralManagerAdapter(queue: peripheralQueue)
    peripheralManager = manager
    return manager
  }

  /// Closes the open server. On the peripheral queue.
  func closeServer() {
    openServer?.server?.close()
    openServer?.server = nil
    openServer = nil
  }

  func gattServerClass() -> ClassDefinition {
    Class(GattServerObject.self) {
      Constructor { () -> GattServerObject in
        throw Exception(name: "BleError", description: "Use BleManager.openGattServer()", code: "INVALID_ARGUMENT")
      }

      // From JS handlers: the whole value or an ATT error code; the core slices and caches.
      Function("respondToRead") { (ref: GattServerObject, requestId: Int, value: Data?, attError: Int?) in
        self.peripheralQueue.async { ref.server?.respondToRead(requestId: requestId, value: value, attError: attError) }
      }

      Function("respondToWrite") { (ref: GattServerObject, requestId: Int, attError: Int?) in
        self.peripheralQueue.async { ref.server?.respondToWrite(requestId: requestId, attError: attError) }
      }

      // P4-02: resolves once iOS took the value for every subscribed target.
      AsyncFunction("notify") { (ref: GattServerObject, uuid: String, value: Data, ids: [String]?, promise: Promise) in
        self.peripheralQueue.async {
          guard let server = ref.server else {
            return promise.reject(BleKitException(CoreError(.disconnected, "The GATT server is closed")))
          }
          let targets = ids?.compactMap(UUID.init(uuidString:))
          server.notify(CBUUID(string: uuid), value: value, centrals: targets) { error in
            if let error { promise.reject(BleKitException(error)) } else { promise.resolve(nil) }
          }
        }
      }

      AsyncFunction("close") { (ref: GattServerObject, promise: Promise) in
        self.peripheralQueue.async {
          if self.openServer === ref { self.closeServer() } else { ref.server?.close() }
          ref.server = nil
          promise.resolve(nil)
        }
      }
    }
  }
}
