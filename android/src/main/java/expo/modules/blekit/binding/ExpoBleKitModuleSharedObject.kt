package expo.modules.blekit.binding

import expo.modules.kotlin.AppContext
import expo.modules.kotlin.sharedobjects.SharedObject

class ExpoBleKitModuleSharedObject(appContext: AppContext) : SharedObject(appContext) {
  var count: Int = 0

  override fun sharedObjectDidRelease() {
    super.sharedObjectDidRelease()
  }
}
