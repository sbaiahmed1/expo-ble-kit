package expo.modules.blekit.core

/** JS `BleState` (plan §5.1). */
enum class BleState(val js: String) {
  UNKNOWN("unknown"),
  RESETTING("resetting"),
  UNSUPPORTED("unsupported"),
  UNAUTHORIZED("unauthorized"),
  POWERED_OFF("poweredOff"),
  POWERED_ON("poweredOn"),
  ;

  companion object {
    /**
     * Plan §4.8. [isAuthorized] is false while a runtime permission the adapter needs is missing
     * (`BLUETOOTH_CONNECT` on Android 12+).
     */
    fun of(isAvailable: Boolean, isAuthorized: Boolean, adapterState: Int): BleState = when {
      !isAvailable -> UNSUPPORTED
      !isAuthorized -> UNAUTHORIZED
      adapterState == AdapterStates.ON -> POWERED_ON
      adapterState == AdapterStates.OFF -> POWERED_OFF
      adapterState == AdapterStates.TURNING_ON || adapterState == AdapterStates.TURNING_OFF -> RESETTING
      else -> UNKNOWN
    }
  }
}
