package expo.modules.blekit.core

/** What the engine reads about the app's permissions. Real implementation: [AndroidPermissionSystem]. */
interface PermissionSystem {
  val sdkInt: Int

  fun declaredPermissions(): DeclaredPermissions

  fun isGranted(permission: String): Boolean
}

/**
 * Owns the adapter (plan §4.4). This first part covers adapter state and permissions (P1-03);
 * scanning and peripheral sessions join in P1-04 and P1-05.
 *
 * Threading (plan §4.7): call everything except [state] on the BLE thread, where adapter state
 * callbacks also arrive.
 */
class CentralEngine(private val adapter: BluetoothAdapterPort, val permissionSystem: PermissionSystem) {
  /** The latest state. Safe to read from any thread (plan §4.7). */
  @Volatile
  var state: BleState = computeState(adapter.state)
    private set

  /** Called on the BLE thread after [state] changes. */
  var onStateChange: ((BleState) -> Unit)? = null

  fun start() {
    adapter.setStateListener { adapterState -> publish(computeState(adapterState)) }
    refresh()
  }

  fun close() {
    adapter.setStateListener(null)
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

  private fun computeState(adapterState: Int): BleState = BleState.of(
    isAvailable = adapter.isAvailable,
    isAuthorized = permissionPolicy().isAuthorized(permissionSystem::isGranted),
    adapterState = adapterState,
  )

  private fun publish(newState: BleState) {
    if (newState != state) {
      state = newState
      onStateChange?.invoke(newState)
    }
  }
}
