package expo.modules.blekit.core

/** What the engine reads about the app's permissions. Real implementation: [AndroidPermissionSystem]. */
interface PermissionSystem {
  val sdkInt: Int

  fun declaredPermissions(): DeclaredPermissions

  fun isGranted(permission: String): Boolean
}

/**
 * Owns the adapter (plan §4.4): adapter state and permissions (P1-03) and scanning (P1-04).
 * Peripheral sessions join in P1-05.
 *
 * Threading (plan §4.7): call everything except [state] on the BLE thread ([executor]), where
 * adapter callbacks also arrive.
 */
class CentralEngine(
  private val adapter: BluetoothAdapterPort,
  val permissionSystem: PermissionSystem,
  executor: SerialExecutor,
  clock: EpochClock,
) {
  /** Engine events, delivered on the BLE thread. */
  interface Listener : ScanController.Events {
    fun onStateChange(state: BleState)
  }

  var listener: Listener? = null

  /** The latest state. Safe to read from any thread (plan §4.7). */
  @Volatile
  var state: BleState = computeState(adapter.state)
    private set

  private val scanController =
    ScanController(
      adapter,
      executor,
      clock,
      object : ScanController.Events {
        override fun onScanResults(sessionId: Int, results: List<Map<String, Any?>>) {
          listener?.onScanResults(sessionId, results)
        }

        override fun onScanError(sessionId: Int, error: CoreError) {
          listener?.onScanError(sessionId, error)
        }

        override fun onWarning(warning: CoreError) {
          listener?.onWarning(warning)
        }
      },
    )

  fun start() {
    adapter.setStateListener(::onAdapterState)
    refresh()
  }

  fun close() {
    adapter.setStateListener(null)
    scanController.stopAll(CoreError(CoreError.Code.OPERATION_CANCELLED, "The module was destroyed"))
  }

  /**
   * Re-reads the adapter and the permissions: after a permission request, and when the app returns
   * to the foreground (the user may have changed a permission in Settings).
   */
  fun refresh() {
    publish(computeState(adapter.state))
  }

  fun permissionPolicy(): BlePermissionPolicy =
    BlePermissionPolicy(permissionSystem.sdkInt, permissionSystem.declaredPermissions())

  /**
   * Starts a scan session (plan §5.3). Throws when scanning can't start: a missing declaration or
   * permission, or an adapter that is off. Never shows a permission prompt.
   */
  fun startScan(sessionId: Int, spec: ScanSpec) {
    if (sessionId in scanController.activeSessionIds) {
      throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Scan session $sessionId is already running")
    }
    val policy = permissionPolicy()
    policy.checkDeclared(listOf(BleCapability.SCAN))
    val missing = policy.runtimePermissions(BleCapability.SCAN).filterNot(permissionSystem::isGranted)
    if (missing.isNotEmpty()) {
      throw CoreError(
        CoreError.Code.PERMISSION_DENIED,
        "Scanning needs ${missing.joinToString()}. Call requestPermissionsAsync() first.",
      )
    }
    adapterError(adapter.state)?.let { throw it }
    scanController.start(sessionId, spec)
  }

  fun stopScan(sessionId: Int) {
    scanController.stop(sessionId)
  }

  /** The scanned handle for [address], which keeps its address type (plan §4.12). */
  fun seenDevice(address: String): RemoteDevicePort? = scanController.seenDevice(address)

  private fun onAdapterState(adapterState: Int) {
    adapterError(adapterState)?.let(scanController::stopAll)
    publish(computeState(adapterState))
  }

  /** Why the adapter can't scan or connect now, or null when it can. */
  private fun adapterError(adapterState: Int): CoreError? = when {
    !adapter.isAvailable -> CoreError(CoreError.Code.BLUETOOTH_UNSUPPORTED, "This device has no Bluetooth LE adapter")
    adapterState == AdapterStates.ON -> null
    adapterState == AdapterStates.TURNING_ON -> CoreError(CoreError.Code.BLUETOOTH_RESETTING, "Bluetooth is turning on")
    else -> CoreError(CoreError.Code.BLUETOOTH_POWERED_OFF, "Bluetooth is off")
  }

  private fun computeState(adapterState: Int): BleState = BleState.of(
    isAvailable = adapter.isAvailable,
    isAuthorized = permissionPolicy().isAuthorized(permissionSystem::isGranted),
    adapterState = adapterState,
  )

  private fun publish(newState: BleState) {
    if (newState != state) {
      state = newState
      listener?.onStateChange(newState)
    }
  }
}
