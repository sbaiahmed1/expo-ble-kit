import ExpoModulesCore

public class ExpoBleKitModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoBleKit")

    Events("onChange")

    AsyncFunction("setValueAsync") { (value: String) in
      self.sendEvent("onChange", [
        "value": value
      ])
    }

    Class(ExpoBleKitModuleSharedObject.self) {
      Constructor { () -> ExpoBleKitModuleSharedObject in
        return ExpoBleKitModuleSharedObject()
      }

      Property("count") { (ref: ExpoBleKitModuleSharedObject) -> Int in
        return ref.count
      }
      .set { (ref: ExpoBleKitModuleSharedObject, count: Int) in
        ref.count = count
      }
    }
  }
}
