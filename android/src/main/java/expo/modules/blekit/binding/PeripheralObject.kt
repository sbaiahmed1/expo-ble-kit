package expo.modules.blekit.binding

import expo.modules.kotlin.AppContext
import expo.modules.kotlin.sharedobjects.SharedObject

/** The JS handle of one peripheral (plan §4.5). Holds no BLE state: the core session does. */
class PeripheralObject(val id: String, appContext: AppContext) : SharedObject(appContext)
