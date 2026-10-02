import ExpoModulesCore

/// A core error as a coded JS exception (plan §4.5).
final class BleKitException: Exception {
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
  private lazy var engine: CentralEngine = {
    let engine = CentralEngine(queue: DispatchQueue(label: "expo.blekit.central"))
    engine.onStateChange = { [weak self] state in
      self?.sendEvent("stateChange", ["state": state.rawValue])
    }
    return engine
  }()

  public func definition() -> ModuleDefinition {
    Name("ExpoBleKit")

    Events("stateChange")

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
      let engine = self.engine
      engine.queue.async {
        do {
          promise.resolve(try engine.permissions().dictionary)
        } catch let error as CoreError {
          promise.reject(BleKitException(error))
        } catch {
          promise.reject(error)
        }
      }
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
}
