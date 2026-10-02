package expo.modules.blekit.binding

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoBleKitModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoBleKit")

    Events("onChange")

    AsyncFunction("setValueAsync") { value: String ->
      sendEvent(
        "onChange",
        mapOf(
          "value" to value,
        ),
      )
    }

    Class(ExpoBleKitModuleSharedObject::class) {
      Constructor {
        val instance = ExpoBleKitModuleSharedObject(appContext)
        return@Constructor instance
      }

      Property("count")
        .get { ref: ExpoBleKitModuleSharedObject ->
          ref.count
        }
        .set { ref: ExpoBleKitModuleSharedObject, count: Int ->
          ref.count = count
        }
    }
  }
}
