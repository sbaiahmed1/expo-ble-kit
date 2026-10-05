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
 * Owns the adapter (plan §4.4): adapter state and permissions (P1-03), scanning (P1-04),
 * peripheral sessions (P1-05) and the foreground service that keeps them alive (P3-03).
 *
 * Threading (plan §4.7): call everything except [state] on the BLE thread ([executor]), where
 * adapter callbacks also arrive.
 */
class CentralEngine(
  private val adapter: BluetoothAdapterPort,
  val permissionSystem: PermissionSystem,
  private val executor: SerialExecutor,
  private val clock: EpochClock,
  /** Where log lines go besides JS: Logcat in the app ([BleLogger.logcat]), nowhere in JVM tests. */
  logOutput: (LogLevel, String) -> Unit = { _, _ -> },
  /** The foreground service of `keepAliveInBackground` ([AndroidKeepAlive] in the app). */
  private val keepAlive: KeepAlivePort = NoKeepAlive,
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

    /** A subscription ended while its connection reconnects (P2-01). */
    fun onSubscriptionEnded(peripheralId: String, subscriptionId: Int, error: CoreError)

    /** A batched subscriber's values (P2-04). */
    fun onNotificationBatch(peripheralId: String, subscriptionId: Int, batch: NotificationBatch)

    /** The peripheral's services changed and were discovered again (P2-06). */
    fun onServicesChanged(peripheralId: String)
  }

  var listener: Listener? = null

  /** The latest state. Safe to read from any thread (plan §4.7). */
  @Volatile
  var state: BleState = computeState(adapter.state)
    private set

  /** By normalized address. Read from any thread for the synchronous state getters. */
  private val sessions = ConcurrentHashMap<String, PeripheralSession>()

  /** The log of plan §4.16; the binding sets its level and forwards it to JS. */
  val logger = BleLogger(clock = { clock.epochMs(executor.nowMs()).toDouble() }, platform = logOutput)

  /** Advertised names from scans, then the device name once connected (plan §4.7). */
  private val names = PeripheralNames()

  /** Sessions connected with `keepAliveInBackground`, until they end (plan §4.14). */
  private val keepAliveSessions = mutableSetOf<String>()
  private var keepAliveRunning = false
  private var keepAliveNotification = KeepAliveNotification()

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
          logger.log(LogLevel.WARN) { "scan session $sessionId ended: ${error.code.value} ${error.message}" }
          listener?.onScanError(sessionId, error)
        }

        override fun onWarning(warning: CoreError) {
          warn(warning)
        }
      },
    )

  fun start() {
    adapter.setStateListener(::onAdapterState)
    keepAlive.onStopped = { error ->
      keepAliveRunning = false
      error?.let(::warn)
    }
    refresh()
  }

  fun close() {
    adapter.setStateListener(null)
    val error = CoreError(CoreError.Code.OPERATION_CANCELLED, "The module was destroyed")
    scanController.stopAll(error)
    sessions.values.forEach { it.forceDisconnected(error) }
    keepAliveSessions.clear()
    updateKeepAlive()
  }

  /**
   * Runs the foreground service while a keep-alive session is open (plan §4.14). Android only
   * allows the start while the app is in the foreground; a refusal is a warning and the
   * connection goes on without it.
   */
  private fun updateKeepAlive() {
    if (keepAliveSessions.isEmpty() && keepAliveRunning) {
      keepAlive.stop()
      keepAliveRunning = false
      logger.log(LogLevel.INFO) { "foreground service stopped" }
    } else if (keepAliveSessions.isNotEmpty() && !keepAliveRunning) {
      try {
        keepAlive.start(keepAliveNotification)
        keepAliveRunning = true
        logger.log(LogLevel.INFO) { "foreground service started" }
      } catch (error: CoreError) {
        warn(error)
      }
    }
  }

  /** What the keep-alive notification shows; updates it when the service runs. */
  fun setKeepAliveNotification(notification: KeepAliveNotification) {
    keepAliveNotification = notification
    if (keepAliveRunning) keepAlive.update(notification)
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
    logger.log(LogLevel.INFO) { "scan session $sessionId started" }
  }

  /** Throws unless a GATT server can be opened now: the connect permission and an adapter that is on (P4-01). */
  fun checkGattServer() {
    val policy = permissionPolicy()
    policy.checkDeclared(listOf(BleCapability.CONNECT))
    val missing = policy.runtimePermissions(BleCapability.CONNECT).filterNot(permissionSystem::isGranted)
    if (missing.isNotEmpty()) {
      throw CoreError(
        CoreError.Code.PERMISSION_DENIED,
        "A GATT server needs ${missing.joinToString()}. Call requestPermissionsAsync() first.",
      )
    }
    adapterError(adapter.state)?.let { throw it }
  }

  /** Throws unless the phone may advertise now (P4-03): the permission declared and granted, Bluetooth on. */
  fun checkAdvertising() {
    val policy = permissionPolicy()
    if (!policy.isDeclared(BleCapability.ADVERTISE)) {
      val missing = policy.missingDeclarations(listOf(BleCapability.ADVERTISE)).joinToString()
      throw CoreError(
        CoreError.Code.MISCONFIGURED,
        "AndroidManifest.xml doesn't declare $missing, which advertising needs. Set android.advertise: true in " +
          "the expo-ble-kit config plugin options, or add it by hand (${CoreError.SETUP_GUIDE}).",
      )
    }
    val missing = policy.runtimePermissions(BleCapability.ADVERTISE).filterNot(permissionSystem::isGranted)
    if (missing.isNotEmpty()) {
      throw CoreError(
        CoreError.Code.PERMISSION_DENIED,
        "Advertising needs ${missing.joinToString()}. Call requestPermissionsAsync({ advertise: true }) first.",
      )
    }
    adapterError(adapter.state)?.let { throw it }
  }

  /** A warning from another component (the GATT server) goes the same way as the engine's. */
  fun reportWarning(warning: CoreError) = warn(warning)

  /** Throws unless a background scan can be registered now (plan §4.13, P3-04). */
  fun checkBackgroundScan() =
    BackgroundScanning.check(permissionPolicy(), permissionSystem::isGranted, adapterError(adapter.state))

  fun stopScan(sessionId: Int) {
    scanController.stop(sessionId)
    logger.log(LogLevel.INFO) { "scan session $sessionId stopped" }
  }

  /** A warning goes to the log and to JS (`warning` event). */
  private fun warn(warning: CoreError) {
    logger.log(LogLevel.WARN) { "${warning.code.value}: ${warning.message}" }
    listener?.onWarning(warning)
  }

  /** The scanned handle for [address], which keeps its address type (plan §4.12). */
  fun seenDevice(address: String): RemoteDevicePort? = scanController.seenDevice(address)

  /** JS `ConnectionState` of [peripheralId]. Safe to read from any thread. */
  fun connectionState(peripheralId: String): String =
    normalizeAddress(peripheralId)?.let { sessions[it]?.visibleState?.js } ?: SessionState.DISCONNECTED.js

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
    if (spec.keepAliveInBackground) {
      keepAlive.missingDeclaration()?.let { missing ->
        throw CoreError(
          CoreError.Code.MISCONFIGURED,
          "keepAliveInBackground needs the foreground service: $missing. Set android.foregroundService " +
            "in the expo-ble-kit config plugin, or ${CoreError.SETUP_GUIDE}",
        )
      }
    }
    val session = sessions.getOrPut(address) {
      PeripheralSession(address, { seenDevice(address) ?: adapter.remoteDevice(address) }, executor) { state, error ->
        if (state == SessionState.READY) {
          // The name the device reports about itself; connecting needs the permission to read it.
          names[address] = runCatching { (seenDevice(address) ?: adapter.remoteDevice(address)).name }.getOrNull()
        }
        logger.log(if (error == null) LogLevel.INFO else LogLevel.WARN, address) {
          state.js + (error?.let { ": ${it.code.value} ${it.message}" } ?: "")
        }
        listener?.onConnectionStateChange(address, state, error)
        // Reconnecting keeps the service; only the end of the connection releases it.
        if (state == SessionState.DISCONNECTED && keepAliveSessions.remove(address)) updateKeepAlive()
      }.also { session ->
        session.logger = logger
        session.clock = { clock.epochMs(executor.nowMs()).toDouble() }
        session.onNotification = { ref, value, timestamp ->
          logger.log(LogLevel.VERBOSE, address) { "notification from ${ref.uuid}: ${value.size} bytes" }
          listener?.onNotification(address, ref.serviceUuid, ref.uuid, value, timestamp)
        }
        session.onNotificationBatch = { id, batch -> listener?.onNotificationBatch(address, id, batch) }
        session.onServicesChanged = { listener?.onServicesChanged(address) }
        session.onMtuChange = { mtu -> listener?.onMtuChange(address, mtu) }
        session.onSubscriptionEnded = { id, error -> listener?.onSubscriptionEnded(address, id, error) }
        session.onWarning = ::warn
      }
    }
    session.connect(spec, completion)
    // A connect that failed right away has already ended: nothing to keep alive.
    if (spec.keepAliveInBackground && session.visibleState != SessionState.DISCONNECTED) {
      keepAliveSessions += address
      updateKeepAlive()
    }
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

  fun writeStream(
    peripheralId: String,
    service: UUID,
    characteristic: UUID,
    data: ByteArray,
    withResponse: Boolean,
    chunkSize: Int?,
    timeoutMs: Long?,
    onProgress: (sent: Int, total: Int) -> Unit,
    completion: (Result<Unit>) -> Unit,
    operationId: Int? = null,
  ) = withSession(peripheralId, completion) {
    it.writeStream(
      service,
      characteristic,
      data,
      withResponse,
      chunkSize,
      timeoutMs,
      onProgress,
      completion,
      operationId,
    )
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
    batch: BatchSpec?,
    completion: (Result<Unit>) -> Unit,
  ) = withSession(peripheralId, completion) {
    it.subscribe(service, characteristic, mode, subscriptionId, timeoutMs, batch, completion)
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

  /** The hidden cache refresh (opt-in, P2-06); resolves false where Android lacks it. */
  fun refreshGattCache(peripheralId: String, completion: (Result<Boolean>) -> Unit) =
    withSession(peripheralId, completion) { it.refreshGattCache(completion) }

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
      mapOf(
        "id" to it.address,
        "state" to it.visibleState.js,
        "queueDepth" to it.queue.depth,
        "subscriptions" to it.subscriptionCount,
      )
    },
    "android" to mapOf(
      "openGattClients" to sessions.values.count { it.hasOpenClient },
      "foregroundService" to keepAliveRunning,
    ),
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
