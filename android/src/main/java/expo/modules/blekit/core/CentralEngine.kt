package expo.modules.blekit.core

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** What the engine reads about the app's permissions. Real implementation: [AndroidPermissionSystem]. */
interface PermissionSystem {
  val sdkInt: Int

  fun declaredPermissions(): DeclaredPermissions

  fun isGranted(permission: String): Boolean
}

/**
 * Owns the adapter (plan §4.4): adapter state and permissions (P1-03), scanning (P1-04) and
 * peripheral sessions (P1-05).
 *
 * Threading (plan §4.7): call everything except [state] on the BLE thread ([executor]), where
 * adapter callbacks also arrive.
 */
class CentralEngine(
  private val adapter: BluetoothAdapterPort,
  val permissionSystem: PermissionSystem,
  private val executor: SerialExecutor,
  private val clock: EpochClock,
) {
  /** Engine events, delivered on the BLE thread. */
  interface Listener : ScanController.Events {
    fun onStateChange(state: BleState)

    /** [error] is set when the connection ended or failed unexpectedly. */
    fun onConnectionStateChange(peripheralId: String, state: SessionState, error: CoreError?)

    /** A notification or indication; [timestamp] in epoch milliseconds (plan §4.10). */
    fun onNotification(peripheralId: String, service: UUID, characteristic: UUID, value: ByteArray, timestamp: Double)

    /** The ATT MTU of a ready connection changed (P1-09). */
    fun onMtuChange(peripheralId: String, mtu: Int)
  }

  var listener: Listener? = null

  /** The latest state. Safe to read from any thread (plan §4.7). */
  @Volatile
  var state: BleState = computeState(adapter.state)
    private set

  /** By normalized address. Read from any thread for the synchronous state getters. */
  private val sessions = ConcurrentHashMap<String, PeripheralSession>()

  /** Advertised names from scans, then the device name once connected (plan §4.7). */
  private val names = PeripheralNames()

  private val scanController =
    ScanController(
      adapter,
      executor,
      clock,
      object : ScanController.Events {
        override fun onScanResults(sessionId: Int, results: List<Map<String, Any?>>) {
          results.forEach { result -> names[result["id"] as String] = result["name"] as String? }
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
    val error = CoreError(CoreError.Code.OPERATION_CANCELLED, "The module was destroyed")
    scanController.stopAll(error)
    sessions.values.forEach { it.forceDisconnected(error) }
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

  /** JS `ConnectionState` of [peripheralId]. Safe to read from any thread. */
  fun connectionState(peripheralId: String): String =
    normalizeAddress(peripheralId)?.let { sessions[it]?.state?.js } ?: SessionState.DISCONNECTED.js

  /**
   * Connects to [peripheralId] (plan §5.4). Throws when connecting can't start: an invalid id, a
   * missing declaration or permission, or an adapter that is off. [completion] gets null once the
   * connection is ready, or the error.
   */
  fun connect(peripheralId: String, spec: ConnectSpec, completion: (CoreError?) -> Unit) {
    val address = normalizeAddress(peripheralId)
      ?: throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Not a Bluetooth address: $peripheralId")
    val policy = permissionPolicy()
    policy.checkDeclared(listOf(BleCapability.CONNECT))
    val missing = policy.runtimePermissions(BleCapability.CONNECT).filterNot(permissionSystem::isGranted)
    if (missing.isNotEmpty()) {
      throw CoreError(
        CoreError.Code.PERMISSION_DENIED,
        "Connecting needs ${missing.joinToString()}. Call requestPermissionsAsync() first.",
      )
    }
    adapterError(adapter.state)?.let { throw it }
    val session = sessions.getOrPut(address) {
      PeripheralSession(address, { seenDevice(address) ?: adapter.remoteDevice(address) }, executor) { state, error ->
        if (state == SessionState.READY) {
          // The name the device reports about itself; connecting needs the permission to read it.
          names[address] = runCatching { (seenDevice(address) ?: adapter.remoteDevice(address)).name }.getOrNull()
        }
        listener?.onConnectionStateChange(address, state, error)
      }.also { session ->
        session.onNotification = { ref, value ->
          val timestamp = clock.epochMs(executor.nowMs()).toDouble()
          listener?.onNotification(address, ref.serviceUuid, ref.uuid, value, timestamp)
        }
        session.onMtuChange = { mtu -> listener?.onMtuChange(address, mtu) }
        session.onWarning = { warning -> listener?.onWarning(warning) }
      }
    }
    session.connect(spec, completion)
  }

  /** The latest name seen for [peripheralId], or null. Safe to read from any thread. */
  fun name(peripheralId: String): String? = normalizeAddress(peripheralId)?.let { names[it] }

  /** Android can't tell whether an address exists, so every valid one is kept (plan §4.12). */
  fun knownPeripherals(ids: List<String>): List<String> = ids.mapNotNull(::normalizeAddress).distinct()

  /**
   * LE devices connected at the OS level, possibly by another app. Android can't see their services
   * without connecting, so [services] doesn't filter them (plan §6).
   */
  @Suppress("UNUSED_PARAMETER")
  fun systemConnectedPeripherals(services: List<UUID>): List<String> {
    val policy = permissionPolicy()
    policy.checkDeclared(listOf(BleCapability.CONNECT))
    val missing = policy.runtimePermissions(BleCapability.CONNECT).filterNot(permissionSystem::isGranted)
    if (missing.isNotEmpty()) {
      throw CoreError(
        CoreError.Code.PERMISSION_DENIED,
        "Listing connected devices needs ${missing.joinToString()}. Call requestPermissionsAsync() first.",
      )
    }
    adapterError(adapter.state)?.let { throw it }
    return adapter.connectedGattDevices().mapNotNull(::normalizeAddress)
  }

  /** ATT MTU of [peripheralId]; 23 when not connected. Safe to read from any thread. */
  fun mtu(peripheralId: String): Int =
    normalizeAddress(peripheralId)?.let { sessions[it]?.mtu } ?: PeripheralSession.DEFAULT_MTU

  /** The discovery cache of [peripheralId] as JS `Service[]`. Safe to read from any thread. */
  fun services(peripheralId: String): List<Map<String, Any?>> =
    normalizeAddress(peripheralId)?.let { sessions[it]?.services }.orEmpty().map { it.toJs() }

  /** Discovers [filter] (all when null) on a ready connection; DISCONNECTED otherwise. */
  fun discover(
    peripheralId: String,
    filter: List<UUID>?,
    timeoutMs: Long?,
    completion: (Result<List<Map<String, Any?>>>) -> Unit,
    operationId: Int? = null,
  ) {
    val session = normalizeAddress(peripheralId)?.let { sessions[it] }
    if (session == null) {
      completion(Result.failure(CoreError(CoreError.Code.DISCONNECTED, "Not connected to $peripheralId")))
      return
    }
    val done: (Result<List<GattServiceInfo>>) -> Unit = { result ->
      completion(result.map { found -> found.map { it.toJs() } })
    }
    session.discover(filter, timeoutMs, done, operationId)
  }

  /** The ready session of [peripheralId], or DISCONNECTED through [completion]. */
  private fun <T> withSession(
    peripheralId: String,
    completion: (Result<T>) -> Unit,
    block: (PeripheralSession) -> Unit,
  ) {
    val session = normalizeAddress(peripheralId)?.let { sessions[it] }
    if (session == null) {
      completion(Result.failure(CoreError(CoreError.Code.DISCONNECTED, "Not connected to $peripheralId")))
    } else {
      block(session)
    }
  }

  fun read(
    peripheralId: String,
    service: UUID,
    characteristic: UUID,
    timeoutMs: Long?,
    completion: (Result<ByteArray>) -> Unit,
    operationId: Int? = null,
  ) = withSession(peripheralId, completion) { it.read(service, characteristic, timeoutMs, completion, operationId) }

  fun write(
    peripheralId: String,
    service: UUID,
    characteristic: UUID,
    value: ByteArray,
    withResponse: Boolean,
    timeoutMs: Long?,
    completion: (Result<Unit>) -> Unit,
    operationId: Int? = null,
  ) = withSession(peripheralId, completion) {
    it.write(service, characteristic, value, withResponse, timeoutMs, completion, operationId)
  }

  fun readDescriptor(
    peripheralId: String,
    service: UUID,
    characteristic: UUID,
    descriptor: UUID,
    timeoutMs: Long?,
    completion: (Result<ByteArray>) -> Unit,
    operationId: Int? = null,
  ) = withSession(peripheralId, completion) {
    it.readDescriptor(service, characteristic, descriptor, timeoutMs, completion, operationId)
  }

  fun writeDescriptor(
    peripheralId: String,
    service: UUID,
    characteristic: UUID,
    descriptor: UUID,
    value: ByteArray,
    timeoutMs: Long?,
    completion: (Result<Unit>) -> Unit,
    operationId: Int? = null,
  ) = withSession(peripheralId, completion) {
    it.writeDescriptor(service, characteristic, descriptor, value, timeoutMs, completion, operationId)
  }

  fun subscribe(
    peripheralId: String,
    service: UUID,
    characteristic: UUID,
    mode: SubscribeMode,
    subscriptionId: Int,
    timeoutMs: Long?,
    completion: (Result<Unit>) -> Unit,
  ) = withSession(peripheralId, completion) {
    it.subscribe(service, characteristic, mode, subscriptionId, timeoutMs, completion)
  }

  fun requestMtu(
    peripheralId: String,
    mtu: Int,
    timeoutMs: Long?,
    completion: (Result<Int>) -> Unit,
    operationId: Int? = null,
  ) = withSession(peripheralId, completion) { it.requestMtu(mtu, timeoutMs, completion, operationId) }

  fun readRssi(peripheralId: String, timeoutMs: Long?, completion: (Result<Int>) -> Unit, operationId: Int? = null) =
    withSession(peripheralId, completion) { it.readRssi(timeoutMs, completion, operationId) }

  /** Cancels an operation started with [operationId] (plan §4.9); unknown ids do nothing. */
  fun cancelOperation(peripheralId: String, operationId: Int) {
    normalizeAddress(peripheralId)?.let { sessions[it] }?.cancel(operationId)
  }

  /** Unknown peripherals have nothing to unsubscribe: success. */
  fun unsubscribe(peripheralId: String, subscriptionId: Int, timeoutMs: Long?, completion: (Result<Unit>) -> Unit) {
    val session = normalizeAddress(peripheralId)?.let { sessions[it] }
    if (session ==
      null
    ) {
      completion(Result.success(Unit))
    } else {
      session.unsubscribe(subscriptionId, timeoutMs, completion)
    }
  }

  fun disconnect(peripheralId: String, completion: () -> Unit) {
    val session = normalizeAddress(peripheralId)?.let { sessions[it] }
    if (session == null) completion() else session.disconnect(completion)
  }

  /** JS `Diagnostics` so far (plan §5.7): the rest lands with P2-07. */
  fun diagnostics(): Map<String, Any?> = mapOf(
    "state" to state.js,
    "sessions" to sessions.values.map {
      mapOf("id" to it.address, "state" to it.state.js, "queueDepth" to it.queue.depth, "subscriptions" to 0)
    },
    "android" to mapOf("openGattClients" to sessions.values.count { it.hasOpenClient }),
  )

  private fun onAdapterState(adapterState: Int) {
    adapterError(adapterState)?.let { error ->
      scanController.stopAll(error)
      sessions.values.forEach { it.forceDisconnected(error) }
    }
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

private val ADDRESS = Regex("^([0-9A-F]{2}:){5}[0-9A-F]{2}$")

/** Android ids are device addresses, which `getRemoteDevice` wants in upper case. */
fun normalizeAddress(id: String): String? = id.uppercase().takeIf(ADDRESS::matches)
