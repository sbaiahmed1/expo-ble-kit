package expo.modules.blekit.core

/** Native connection states (plan §4.8). Discovery joins in P1-06. */
enum class SessionState {
  DISCONNECTED,
  CONNECTING,

  /** The link is up; post-connect setup is running. */
  CONNECTED,

  /** Link up and setup done: what JS calls `connected`. */
  READY,
  DISCONNECTING,
  ;

  /** JS `ConnectionState` (plan §4.8). */
  val js: String
    get() = when (this) {
      DISCONNECTED -> "disconnected"
      CONNECTING, CONNECTED -> "connecting"
      READY -> "connected"
      DISCONNECTING -> "disconnecting"
    }
}

/** Connect options after the TS layer applied its defaults (plan §5.4). */
class ConnectSpec(
  /** Null: no timeout ("connect when in range"). Only an explicit JS `timeoutMs: null` gets here. */
  val timeoutMs: Long?,
  /** Android `autoConnect`. By default, a background connect exactly when there is no timeout. */
  val autoConnect: Boolean = timeoutMs == null,
)

/**
 * One peripheral's connection (plan §4.4, §4.8): connect with a timeout and a bounded retry of
 * status 133, disconnect, and link loss. Every GATT client it opens is closed exactly once, on every
 * path (Appendix B rule 3).
 *
 * Threading (plan §4.7): everything on the BLE thread. [state] is safe to read from any thread.
 */
class PeripheralSession(
  val address: String,
  /** The device to connect through, resolved at each connect (plan §4.12). */
  private val device: () -> RemoteDevicePort,
  private val executor: SerialExecutor,
  private val onStateChange: (SessionState, CoreError?) -> Unit,
) {
  @Volatile
  var state = SessionState.DISCONNECTED
    private set

  /** Operations on this connection (Appendix B rule 2). Used from P1-06 on. */
  val queue = GattQueue(executor)

  private var gatt: GattClientPort? = null

  /** Bumped whenever a client is opened or closed; callbacks from older clients are ignored. */
  private var generation = 0
  private var attempts = 0
  private var autoConnect = false
  private var connectTimeout: Cancellable? = null
  private var retry: Cancellable? = null
  private var disconnectTimeout: Cancellable? = null
  private val connectWaiters = mutableListOf<(CoreError?) -> Unit>()
  private val disconnectWaiters = mutableListOf<() -> Unit>()

  /** A GATT client is open and not yet closed. */
  val hasOpenClient: Boolean get() = gatt != null

  /**
   * Resolves (null) once the connection is ready. A connect while one is pending joins it, with the
   * first call's options.
   */
  fun connect(spec: ConnectSpec, completion: (CoreError?) -> Unit) {
    when (state) {
      SessionState.READY -> completion(null)

      SessionState.CONNECTING, SessionState.CONNECTED -> connectWaiters += completion

      SessionState.DISCONNECTING -> disconnectWaiters += { connect(spec, completion) }

      SessionState.DISCONNECTED -> {
        connectWaiters += completion
        attempts = 0
        autoConnect = spec.autoConnect
        setState(SessionState.CONNECTING, null)
        spec.timeoutMs?.let { timeoutMs ->
          connectTimeout = executor.executeDelayed(timeoutMs) {
            connectTimeout = null
            failConnect(
              CoreError(CoreError.Code.CONNECTION_TIMEOUT, "Connecting to $address timed out after $timeoutMs ms"),
            )
          }
        }
        open()
      }
    }
  }

  /**
   * Resolves once disconnected. During a connect, it cancels the attempt, which then rejects with
   * OPERATION_CANCELLED.
   */
  fun disconnect(completion: () -> Unit) {
    when (state) {
      SessionState.DISCONNECTED -> completion()

      SessionState.DISCONNECTING -> disconnectWaiters += completion

      SessionState.CONNECTING, SessionState.CONNECTED -> {
        disconnectWaiters += completion
        failConnect(
          error = null,
          connectError = CoreError(CoreError.Code.OPERATION_CANCELLED, "disconnect() cancelled the connection attempt"),
        )
      }

      SessionState.READY -> {
        disconnectWaiters += completion
        setState(SessionState.DISCONNECTING, null)
        gatt?.disconnect()
        // Rule 4: if the stack never confirms, close anyway.
        disconnectTimeout = executor.executeDelayed(DISCONNECT_TIMEOUT_MS) {
          disconnectTimeout = null
          closeGatt(disconnectFirst = false)
          finishDisconnected(null)
        }
      }
    }
  }

  /** The adapter went away (off, or the module is destroyed): drop everything with [error]. */
  fun forceDisconnected(error: CoreError) {
    if (state == SessionState.DISCONNECTED) {
      return
    }
    closeGatt(disconnectFirst = false)
    finishDisconnected(error)
  }

  private fun open() {
    attempts++
    val current = ++generation
    val client = device().connectGatt(autoConnect, AttemptCallback(current))
    if (client == null) {
      failConnect(CoreError(CoreError.Code.CONNECTION_FAILED, "Android refused to start a connection to $address"))
      return
    }
    gatt = client
  }

  private inner class AttemptCallback(private val attemptGeneration: Int) : GattClientCallback {
    override fun onConnectionStateChange(status: Int, newState: Int) {
      if (attemptGeneration == generation) {
        onLinkState(status, newState)
      }
    }
  }

  private fun onLinkState(status: Int, newState: Int) {
    val up = newState == ConnectionStates.CONNECTED && status == GATT_SUCCESS
    val down = newState == ConnectionStates.DISCONNECTED
    when (state) {
      SessionState.CONNECTING -> if (up) {
        onLinkUp()
      } else if (down || status != GATT_SUCCESS) {
        onConnectFailed(status)
      }

      SessionState.CONNECTED, SessionState.READY -> if (down) {
        closeGatt(disconnectFirst = false)
        finishDisconnected(AndroidErrorMapping.connectionError(status, wasConnected = true))
      }

      SessionState.DISCONNECTING -> if (down) {
        closeGatt(disconnectFirst = false)
        finishDisconnected(null)
      }

      SessionState.DISCONNECTED -> Unit
    }
  }

  private fun onLinkUp() {
    connectTimeout?.cancel()
    connectTimeout = null
    setState(SessionState.CONNECTED, null)
    // P1-06 adds discovery (autoDiscover) and P1-09 the MTU request here, before READY.
    setState(SessionState.READY, null)
    // The state listener has seen `connected` before connect() resolves (plan §4.8).
    val waiters = connectWaiters.toList()
    connectWaiters.clear()
    waiters.forEach { it(null) }
  }

  private fun onConnectFailed(status: Int) {
    closeGatt(disconnectFirst = false)
    // Status 133 is often transient on Android: retry a few times, within the connect timeout.
    if (status == GATT_ERROR && attempts < MAX_CONNECT_ATTEMPTS) {
      retry = executor.executeDelayed(RETRY_BASE_DELAY_MS shl (attempts - 1)) {
        retry = null
        if (state == SessionState.CONNECTING) {
          open()
        }
      }
      return
    }
    failConnect(AndroidErrorMapping.connectionError(status, wasConnected = false))
  }

  /** Ends a connect attempt. [error] goes to the state listener; [connectError] to connect() callers. */
  private fun failConnect(error: CoreError?, connectError: CoreError = error!!) {
    closeGatt(disconnectFirst = true)
    finishDisconnected(error, connectError)
  }

  private fun closeGatt(disconnectFirst: Boolean) {
    val client = gatt ?: return
    gatt = null
    generation++
    if (disconnectFirst) {
      // Cancels a pending (auto)connect; close() alone can leave it registered on some devices.
      client.disconnect()
    }
    client.close()
  }

  private fun finishDisconnected(
    error: CoreError?,
    connectError: CoreError = error
      ?: CoreError(CoreError.Code.DISCONNECTED, "Disconnected before the connection was ready"),
  ) {
    connectTimeout?.cancel()
    connectTimeout = null
    retry?.cancel()
    retry = null
    disconnectTimeout?.cancel()
    disconnectTimeout = null
    queue.failAll(CoreError(CoreError.Code.DISCONNECTED, "Disconnected from $address"))
    setState(SessionState.DISCONNECTED, error)
    val connects = connectWaiters.toList()
    connectWaiters.clear()
    connects.forEach { it(connectError) }
    val disconnects = disconnectWaiters.toList()
    disconnectWaiters.clear()
    disconnects.forEach { it() }
  }

  /** The listener hears changes of the JS state only (plan §4.8 maps several native states to one). */
  private fun setState(newState: SessionState, error: CoreError?) {
    val previous = state
    state = newState
    if (newState.js != previous.js) {
      onStateChange(newState, error)
    }
  }

  companion object {
    /** `BluetoothGatt.GATT_ERROR` (0x85), Android's catch-all connect failure. */
    const val GATT_ERROR = 133
    const val MAX_CONNECT_ATTEMPTS = 3
    const val RETRY_BASE_DELAY_MS = 250L
    const val DISCONNECT_TIMEOUT_MS = 5_000L
  }
}
