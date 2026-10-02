import ExpoModulesCore

/// The JS handle of one peripheral (plan §4.5). Holds no BLE state: the core session does.
final class PeripheralObject: SharedObject, @unchecked Sendable {
  let id: String

  init(id: String) {
    self.id = id
    super.init()
  }
}
