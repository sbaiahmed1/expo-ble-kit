package expo.modules.blekit.core

import java.util.UUID

/** Native connection states (plan §4.8). */
enum class SessionState {
  DISCONNECTED,
  CONNECTING,

  /** The link is up; post-connect setup is running. */
  CONNECTED,

  /** `autoDiscover` is running before the connection is ready. */
  DISCOVERING,

  /** Link up and setup done: what JS calls `connected`. */
  READY,
  DISCONNECTING,

  /** Waiting before the next reconnection attempt (P2-01). JS also sees the attempts as this. */
  RECONNECTING,
  ;

  /** JS `ConnectionState` (plan §4.8). */
  val js: String
    get() = when (this) {
      DISCONNECTED -> "disconnected"
      CONNECTING, CONNECTED, DISCOVERING -> "connecting"
      READY -> "connected"
      DISCONNECTING -> "disconnecting"
      RECONNECTING -> "reconnecting"
    }
}

/** How a batched subscriber receives values (plan §4.10, P2-04). */
data class BatchSpec(val intervalMs: Long, val maxItems: Int = DEFAULT_MAX_ITEMS) {
  companion object {
    const val DEFAULT_MAX_ITEMS = 4096
  }
}

/** JS `SubscribeOptions.mode` (plan §5.4). `AUTO` takes notify when the characteristic has both. */
enum class SubscribeMode {
  AUTO,
  NOTIFY,
  INDICATE,
  ;

  companion object {
    fun of(js: String): SubscribeMode? = when (js) {
      "auto" -> AUTO
      "notify" -> NOTIFY
      "indicate" -> INDICATE
      else -> null
    }
  }
}

/** Connect options after the TS layer applied its defaults (plan §5.4). */
class ConnectSpec(
  /** Null: no timeout ("connect when in range"). Only an explicit JS `timeoutMs: null` gets here. */
  val timeoutMs: Long?,
  /** Android `autoConnect`. By default, a background connect exactly when there is no timeout. */
  val autoConnect: Boolean = timeoutMs == null,
  /** Discover every service before the connection counts as ready (plan §4.8). */
  val autoDiscover: Boolean = true,
  /** Android: the MTU to request before the connection counts as ready; null asks for none (Q3). */
  val requestMtu: Int? = DEFAULT_REQUESTED_MTU,
  /** Reconnect after an unexpected link loss of a ready connection; null never does (P2-01). */
  val reconnect: ReconnectPolicy? = null,
  /** With [reconnect]: enable the subscriptions again before the connection counts as ready. */
  val restoreSubscriptions: Boolean = true,
  /** Operations in a row that time out before the connection is reset (plan §4.9); null never. */
  val resetAfterTimeouts: Int? = DEFAULT_RESET_AFTER_TIMEOUTS,
  /** Run the foreground service until this connection ends (plan §4.14, P3-03); read by the engine. */
  val keepAliveInBackground: Boolean = false,
) {
  companion object {
    /** Plan §4.9: two timeouts in a row mean a stuck Android stack. */
    const val DEFAULT_RESET_AFTER_TIMEOUTS = 2

    /** Plan §5.4 / Q3. Android 14+ asks for 517 whatever the app requests (measured in P0-06). */
    const val DEFAULT_REQUESTED_MTU = 517
  }
}

/**
 * One peripheral's connection (plan §4.4, §4.8): connect with a timeout and a bounded retry of
 * status 133, service discovery and its cache, disconnect, and link loss. Every GATT client it
 * opens is closed exactly once, on every path (Appendix B rule 3).
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

  /** The engine's log (plan §4.16); silent until the engine sets it. */
  var logger = BleLogger(clock = { executor.nowMs().toDouble() }, platform = { _, _ -> }).apply {
    level = LogLevel.NONE
  }

  /** Operations on this connection (Appendix B rule 2). */
  val queue = GattQueue(executor).also { queue ->
    queue.onSettled = { operation, result, elapsedMs ->
      logger.log(LogLevel.DEBUG, address, operation.id) { describe(operation, result, elapsedMs) }
    }
    // Plan §4.9: on Android, operations in a row that time out mean a stuck stack.
    queue.onTimeout = { _, consecutiveTimeouts ->
      val limit = resetAfterTimeouts
      if (limit != null && consecutiveTimeouts >= limit) resetStuckConnection(consecutiveTimeouts)
    }
  }

  /** A changed ATT MTU on a ready connection, on the BLE thread: after a request, or one the stack or peer started. */
  var onMtuChange: ((Int) -> Unit)? = null

  /** A non-fatal problem, such as a refused MTU request during setup. */
  var onWarning: ((CoreError) -> Unit)? = null

  /**
   * Notifications and indications for the characteristic's unbatched subscribers, on the BLE
   * thread, with their arrival time from [clock].
   */
  var onNotification: ((GattCharacteristicRef, ByteArray, Double) -> Unit)? = null

  /** A batched subscriber's values (P2-04). */
  var onNotificationBatch: ((subscriptionId: Int, batch: NotificationBatch) -> Unit)? = null

  /** Arrival times of notifications; the engine makes them epoch milliseconds (plan §4.10). */
  var clock: () -> Double = { executor.nowMs().toDouble() }

  /**
   * Subscriptions that end while the connection lives on (reconnecting): a reconnection without
   * subscription restore, or a restore that failed. On the BLE thread.
   */
  var onSubscriptionEnded: ((subscriptionId: Int, error: CoreError) -> Unit)? = null

  /** One CCCD per characteristic, shared by its subscribers (plan §5.4). */
  private class CharacteristicSubscriptions(var ref: GattCharacteristicRef, val indicate: Boolean) {
    val subscribers = mutableSetOf<Int>()

    /** Subscribers waiting for the CCCD write that enables delivery. */
    val waiting = mutableMapOf<Int, (Result<Unit>) -> Unit>()
    var enabled = false
  }

  private val subscriptions = mutableMapOf<String, CharacteristicSubscriptions>()

  /** Active subscriptions (their subscriber ids), for diagnostics. */
  val subscriptionCount: Int get() = subscriptions.values.sumOf { it.subscribers.size }

  /** The batched subscribers' batchers, by subscription id (P2-04). */
  private val batchers = mutableMapOf<Int, NotificationBatcher>()

  /** Characteristic key of every active or pending subscription id. */
  private val subscriptionKeys = mutableMapOf<Int, String>()

  /** Running and queued operations JS may cancel, by the id JS gave them. */
  private val cancellable = mutableMapOf<Int, GattOperation>()

  /** ATT MTU. 23 until an exchange raises it (P1-09). */
  @Volatile
  var mtu = DEFAULT_MTU
    private set

  /** The discovery cache: every service the last discovery found. Empty when disconnected. */
  @Volatile
  var services: List<GattServiceInfo> = emptyList()
    private set

  private var gatt: GattClientPort? = null

  /** The reconnection attempt running or waiting (1-based); 0 when not reconnecting. */
  @Volatile
  private var reconnectAttempt = 0
  private var reconnect: ReconnectPolicy? = null
  private var restoreSubscriptions = true
  private var resetAfterTimeouts: Int? = ConnectSpec.DEFAULT_RESET_AFTER_TIMEOUTS

  /** The peripheral's GATT database changed and the session discovered it again (P2-06). */
  var onServicesChanged: (() -> Unit)? = null
  private var connectTimeoutMs: Long? = null
  private var reconnectTimer: Cancellable? = null

  /** The state the listener last heard, as JS sees it. */
  private var reported = SessionState.DISCONNECTED

  /** The state as JS sees it: the setup steps of a reconnection read as `reconnecting` (plan §4.8). */
  val visibleState: SessionState
    get() = visible(state)

  /** Bumped whenever a client is opened or closed; callbacks from older clients are ignored. */
  private var generation = 0
  private var attempts = 0
  private var autoConnect = false
  private var autoDiscover = true
  private var setupMtu: Int? = null
  private var connectTimeout: Cancellable? = null
  private var retry: Cancellable? = null
  private var disconnectTimeout: Cancellable? = null
  private val connectWaiters = mutableListOf<(CoreError?) -> Unit>()
  private val disconnectWaiters = mutableListOf<() -> Unit>()

  /** The stack reported congestion on the last write without response (P2-02). */
  private var linkCongested = false

  /** The write without response in flight, and how to send its packet again (P2-02). */
  private var packetInFlight: Pair<GattOperation, () -> Unit>? = null

  /** A GATT client is open and not yet closed. */
  val hasOpenClient: Boolean get() = gatt != null

  /**
   * Resolves (null) once the connection is ready. A connect while one is pending joins it, with the
   * first call's options.
   */
  fun connect(spec: ConnectSpec, completion: (CoreError?) -> Unit) {
    when (state) {
      SessionState.READY -> completion(null)

      SessionState.CONNECTING,
      SessionState.CONNECTED,
      SessionState.DISCOVERING,
      SessionState.RECONNECTING,
      -> connectWaiters += completion

      SessionState.DISCONNECTING -> disconnectWaiters += { connect(spec, completion) }

      SessionState.DISCONNECTED -> {
        connectWaiters += completion
        attempts = 0
        autoConnect = spec.autoConnect
        autoDiscover = spec.autoDiscover
        setupMtu = spec.requestMtu
        reconnect = spec.reconnect
        restoreSubscriptions = spec.restoreSubscriptions
        resetAfterTimeouts = spec.resetAfterTimeouts
        connectTimeoutMs = spec.timeoutMs
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

      SessionState.CONNECTING, SessionState.CONNECTED, SessionState.DISCOVERING -> {
        disconnectWaiters += completion
        failConnect(
          error = null,
          connectError = CoreError(CoreError.Code.OPERATION_CANCELLED, "disconnect() cancelled the connection attempt"),
        )
      }

      SessionState.RECONNECTING -> {
        disconnectWaiters += completion
        finishDisconnected(null, CoreError(CoreError.Code.OPERATION_CANCELLED, "disconnect() stopped reconnecting"))
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

  /**
   * Discovers services through the queue (plan §4.9). Android always discovers the whole database,
   * so [filter] narrows the result, not the work. The cache keeps everything found.
   */
  fun discover(
    filter: List<UUID>?,
    timeoutMs: Long?,
    completion: (Result<List<GattServiceInfo>>) -> Unit,
    operationId: Int? = null,
    first: Boolean = false,
  ) {
    if (state != SessionState.READY && state != SessionState.DISCOVERING) {
      completion(Result.failure(CoreError(CoreError.Code.DISCONNECTED, "Not connected to $address")))
      return
    }
    val operation = queue.enqueue(
      GattOperation.Kind.DISCOVER_SERVICES,
      timeoutMs = timeoutMs ?: DISCOVERY_TIMEOUT_MS,
      first = first,
      start = {
        if (gatt?.discoverServices() != true) {
          val error = CoreError(CoreError.Code.GATT_ERROR, "Android refused to start service discovery")
          queue.complete(GattResult.Failure(error)) { it.kind == GattOperation.Kind.DISCOVER_SERVICES }
        }
      },
      completion = { result ->
        operationId?.let(cancellable::remove)
        when (result) {
          is GattResult.Failure -> completion(Result.failure(result.error))

          is GattResult.Success -> {
            services = gatt?.services().orEmpty()
            completion(Result.success(services.filter { filter == null || it.uuid in filter }))
          }
        }
      },
    )
    operationId?.let { cancellable[it] = operation }
  }

  /**
   * Cancels the operation JS started with [operationId] (plan §4.9): a queued one is removed, a
   * running one is answered at once while the radio finishes it. Unknown or finished ids do nothing.
   */
  fun cancel(operationId: Int) {
    cancellable[operationId]?.let(queue::cancel)
  }

  /** Reads a characteristic (plan §5.4). Long values are read in full by the stack. */
  fun read(
    service: UUID,
    characteristic: UUID,
    timeoutMs: Long?,
    completion: (Result<ByteArray>) -> Unit,
    operationId: Int? = null,
  ) {
    val ref = try {
      findCharacteristic(service, characteristic, CharacteristicProperties.READ, CoreError.Code.READ_NOT_PERMITTED)
    } catch (error: CoreError) {
      return completion(Result.failure(error))
    }
    enqueueAttributeOperation(GattOperation.Kind.READ, key(ref), timeoutMs, completion, operationId, valueOf = {
      it.value
        ?: ByteArray(0)
    }) {
      if (gatt?.readCharacteristic(ref) != true) refused("read")
    }
  }

  /**
   * Writes a characteristic (plan §5.4). With response, values up to 512 bytes (longer than one
   * packet use the stack's long write); without response, one packet (MTU − 3).
   */
  fun write(
    service: UUID,
    characteristic: UUID,
    value: ByteArray,
    withResponse: Boolean,
    timeoutMs: Long?,
    completion: (Result<Unit>) -> Unit,
    operationId: Int? = null,
  ) {
    val ref = try {
      val property = if (withResponse) CharacteristicProperties.WRITE else CharacteristicProperties.WRITE_NO_RESPONSE
      findCharacteristic(service, characteristic, property, CoreError.Code.WRITE_NOT_PERMITTED).also {
        checkLength(value, if (withResponse) MAX_ATTRIBUTE_LENGTH else mtu - 3)
      }
    } catch (error: CoreError) {
      return completion(Result.failure(error))
    }
    val kind = if (withResponse) GattOperation.Kind.WRITE else GattOperation.Kind.WRITE_WITHOUT_RESPONSE
    val writeType = if (withResponse) WriteTypes.DEFAULT else WriteTypes.NO_RESPONSE
    enqueueAttributeOperation(kind, key(ref), timeoutMs, completion, operationId, valueOf = {}) {
      val submit = {
        submitWrite(kind, "Write") { gatt?.writeCharacteristic(ref, value, writeType) ?: SubmitStatus.ERROR_UNKNOWN }
      }
      if (withResponse) submit() else sendPacket(submit)
    }
  }

  /**
   * Writes [data] in chunks (plan §5.4, P2-03): [chunkSize] bytes each, one packet (MTU − 3) by
   * default, every chunk one write through the queue with the flow control of §4.9. Each chunk queues
   * the next one first, so operations issued later wait for the end of the stream. [onProgress] hears
   * the bytes written about every 1 % and at the end. [timeoutMs] applies to each chunk; cancelling
   * [operationId] stops the stream within the chunk in flight.
   */
  fun writeStream(
    service: UUID,
    characteristic: UUID,
    data: ByteArray,
    withResponse: Boolean,
    chunkSize: Int?,
    timeoutMs: Long?,
    onProgress: (sent: Int, total: Int) -> Unit,
    completion: (Result<Unit>) -> Unit,
    operationId: Int? = null,
  ) {
    val ref: GattCharacteristicRef
    val size: Int
    try {
      val property = if (withResponse) CharacteristicProperties.WRITE else CharacteristicProperties.WRITE_NO_RESPONSE
      ref = findCharacteristic(service, characteristic, property, CoreError.Code.WRITE_NOT_PERMITTED)
      val max = if (withResponse) MAX_ATTRIBUTE_LENGTH else mtu - 3
      size = chunkSize ?: (mtu - 3)
      if (size !in 1..max) {
        throw CoreError(CoreError.Code.INVALID_ARGUMENT, "chunkSize $size is outside 1…$max for this write type")
      }
    } catch (error: CoreError) {
      return completion(Result.failure(error))
    }
    if (data.isEmpty()) return completion(Result.success(Unit))
    val kind = if (withResponse) GattOperation.Kind.WRITE else GattOperation.Kind.WRITE_WITHOUT_RESPONSE
    val writeType = if (withResponse) WriteTypes.DEFAULT else WriteTypes.NO_RESPONSE
    val progressStep = maxOf(size, data.size / PROGRESS_STEPS)
    var reported = 0

    fun sendChunk(offset: Int) {
      val end = minOf(offset + size, data.size)
      val chunk = data.copyOfRange(offset, end)
      val chunkDone = { result: Result<Unit> ->
        val error = result.exceptionOrNull() as CoreError?
        when {
          error != null -> completion(Result.failure(streamError(error, offset, data.size)))

          else -> {
            if (end == data.size || end - reported >= progressStep) {
              reported = end
              onProgress(end, data.size)
            }
            if (end == data.size) completion(Result.success(Unit)) else sendChunk(end)
          }
        }
      }
      enqueueAttributeOperation(kind, key(ref), timeoutMs, chunkDone, operationId, valueOf = {}, first = offset > 0) {
        val submit = {
          submitWrite(kind, "Write") { gatt?.writeCharacteristic(ref, chunk, writeType) ?: SubmitStatus.ERROR_UNKNOWN }
        }
        if (withResponse) submit() else sendPacket(submit)
      }
    }
    sendChunk(0)
  }

  /** `read <target>: ok in 12 ms` (plan §4.16: op kind, status and duration). */
  private fun describe(operation: GattOperation, result: GattResult, elapsedMs: Long?): String {
    val what = listOfNotNull(operation.kind.name.lowercase(), operation.target).joinToString(" ")
    val status = if (result is GattResult.Failure) "${result.error.code.value} (${result.error.message})" else "ok"
    return "$what: $status " + if (elapsedMs == null) "before it started" else "in $elapsedMs ms"
  }

  /** A chunk's error, saying how far the stream got. */
  private fun streamError(error: CoreError, sent: Int, total: Int) = CoreError(
    error.code,
    "${error.message} (stream stopped after $sent of $total bytes)",
    error.gattStatus,
    error.retryable,
  )

  fun readDescriptor(
    service: UUID,
    characteristic: UUID,
    descriptor: UUID,
    timeoutMs: Long?,
    completion: (Result<ByteArray>) -> Unit,
    operationId: Int? = null,
  ) {
    val ref = try {
      findDescriptor(service, characteristic, descriptor)
    } catch (error: CoreError) {
      return completion(Result.failure(error))
    }
    val kind = GattOperation.Kind.READ_DESCRIPTOR
    enqueueAttributeOperation(kind, key(ref), timeoutMs, completion, operationId, valueOf = {
      it.value
        ?: ByteArray(0)
    }) {
      if (gatt?.readDescriptor(ref) != true) refused("descriptor read")
    }
  }

  /** The CCCD is off limits: subscriptions own it (P1-08), and iOS throws if it is written directly. */
  fun writeDescriptor(
    service: UUID,
    characteristic: UUID,
    descriptor: UUID,
    value: ByteArray,
    timeoutMs: Long?,
    completion: (Result<Unit>) -> Unit,
    operationId: Int? = null,
  ) {
    val ref = try {
      if (descriptor == CCCD) {
        throw CoreError(
          CoreError.Code.INVALID_ARGUMENT,
          "The Client Characteristic Configuration descriptor (0x2902) is managed by subscribe()",
        )
      }
      checkLength(value, MAX_ATTRIBUTE_LENGTH)
      findDescriptor(service, characteristic, descriptor)
    } catch (error: CoreError) {
      return completion(Result.failure(error))
    }
    val kind = GattOperation.Kind.WRITE_DESCRIPTOR
    enqueueAttributeOperation(kind, key(ref), timeoutMs, completion, operationId, valueOf = {}) {
      submitWrite(GattOperation.Kind.WRITE_DESCRIPTOR, "Descriptor write") {
        gatt?.writeDescriptor(ref, value) ?: SubmitStatus.ERROR_UNKNOWN
      }
    }
  }

  /**
   * Subscribes [subscriptionId] to a characteristic (plan §5.4). The first subscriber enables the
   * CCCD through the queue; later ones share it. An explicit [mode] different from the active one is
   * INVALID_ARGUMENT.
   */
  fun subscribe(
    service: UUID,
    characteristic: UUID,
    mode: SubscribeMode,
    subscriptionId: Int,
    timeoutMs: Long?,
    batch: BatchSpec? = null,
    completion: (Result<Unit>) -> Unit,
  ) {
    val entry = try {
      if (subscriptionId in subscriptionKeys) {
        throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Subscription $subscriptionId already exists")
      }
      val ref = findCharacteristic(
        service,
        characteristic,
        CharacteristicProperties.NOTIFY or CharacteristicProperties.INDICATE,
        CoreError.Code.NOT_SUPPORTED,
      )
      val properties = services.first { it.uuid == service }.characteristics.first { it.ref == ref }
      if (CCCD !in properties.descriptors) {
        throw CoreError(CoreError.Code.DESCRIPTOR_NOT_FOUND, "Characteristic $characteristic has no CCCD (0x2902)")
      }
      val indicate = resolveIndicate(mode, properties.properties, characteristic)
      subscriptions[key(ref)]?.also { existing ->
        if (mode != SubscribeMode.AUTO && existing.indicate != indicate) {
          throw CoreError(
            CoreError.Code.INVALID_ARGUMENT,
            "Characteristic $characteristic is already subscribed with ${if (existing.indicate) "indications" else "notifications"}",
          )
        }
      } ?: CharacteristicSubscriptions(ref, indicate)
    } catch (error: CoreError) {
      return completion(Result.failure(error))
    }
    val key = key(entry.ref)
    subscriptionKeys[subscriptionId] = key
    batch?.let { batchers[subscriptionId] = batcher(subscriptionId, it) }
    if (entry.enabled) {
      entry.subscribers += subscriptionId
      return completion(Result.success(Unit))
    }
    entry.waiting[subscriptionId] = completion
    if (subscriptions.put(key, entry) != null) {
      return // The CCCD write is already on its way.
    }
    setNotification(entry, enable = true, timeoutMs) { result ->
      val waiting = entry.waiting.toMap()
      entry.waiting.clear()
      result.fold(
        onSuccess = {
          entry.enabled = true
          entry.subscribers += waiting.keys
        },
        onFailure = {
          waiting.keys.forEach(subscriptionKeys::remove)
          waiting.keys.forEach { batchers.remove(it)?.cancel() }
          if (subscriptions[key] === entry && entry.subscribers.isEmpty()) subscriptions.remove(key)
        },
      )
      waiting.values.forEach { it(result) }
    }
  }

  /**
   * Ends [subscriptionId]. Delivery to it stops at once; the last subscriber of a characteristic also
   * disables its CCCD, and a failed write rejects. Unknown ids and lost connections succeed.
   */
  fun unsubscribe(subscriptionId: Int, timeoutMs: Long?, completion: (Result<Unit>) -> Unit) {
    val key = subscriptionKeys.remove(subscriptionId) ?: return completion(Result.success(Unit))
    batchers.remove(subscriptionId)?.cancel()
    val entry = subscriptions[key] ?: return completion(Result.success(Unit))
    entry.subscribers -= subscriptionId
    entry.waiting.remove(subscriptionId)?.invoke(
      Result.failure(CoreError(CoreError.Code.OPERATION_CANCELLED, "unsubscribed before the subscription was ready")),
    )
    if (entry.subscribers.isNotEmpty() || entry.waiting.isNotEmpty()) {
      return completion(Result.success(Unit))
    }
    subscriptions.remove(key)
    if (state != SessionState.READY) {
      return completion(Result.success(Unit))
    }
    setNotification(entry, enable = false, timeoutMs, completion = completion)
  }

  /** A batcher for [subscriptionId], whose first drop is a BUFFER_OVERFLOW warning (plan §4.10). */
  private fun batcher(subscriptionId: Int, spec: BatchSpec) = NotificationBatcher(
    spec.intervalMs,
    spec.maxItems,
    executor,
    onFirstDrop = {
      val message = "Subscription $subscriptionId dropped values: more than ${spec.maxItems} arrived within " +
        "${spec.intervalMs} ms. Later drops are counted in NotificationBatch.dropped"
      onWarning?.invoke(CoreError(CoreError.Code.BUFFER_OVERFLOW, message))
    },
  ) { onNotificationBatch?.invoke(subscriptionId, it) }

  /** One value to the characteristic's subscribers: the batched ones collect it (P2-04). */
  private fun deliver(entry: CharacteristicSubscriptions, value: ByteArray) {
    val timestamp = clock()
    var unbatched = false
    for (id in entry.subscribers) {
      val batcher = batchers[id]
      if (batcher == null) unbatched = true else batcher.add(value, timestamp)
    }
    if (unbatched) onNotification?.invoke(entry.ref, value, timestamp)
  }

  /** The batched subscribers get what they collected before their subscriptions end with the link. */
  private fun flushBatches(ids: Collection<Int>) {
    ids.forEach { batchers.remove(it)?.flush() }
  }

  /** Android needs both the local registration and the CCCD write on the peripheral. */
  private fun setNotification(
    entry: CharacteristicSubscriptions,
    enable: Boolean,
    timeoutMs: Long?,
    setup: Boolean = false,
    completion: (Result<Unit>) -> Unit,
  ) {
    val value = when {
      !enable -> CCCD_DISABLE
      entry.indicate -> CCCD_INDICATE
      else -> CCCD_NOTIFY
    }
    val kind = GattOperation.Kind.SET_NOTIFY
    enqueueAttributeOperation(
      kind,
      key(entry.ref),
      timeoutMs,
      completion,
      operationId = null,
      requireReady = !setup,
      valueOf = {},
    ) {
      if (gatt?.setCharacteristicNotification(entry.ref, enable) != true) {
        refused(if (enable) "notification registration" else "notification removal")
      } else {
        submitWrite(GattOperation.Kind.SET_NOTIFY, "CCCD write") {
          gatt?.writeDescriptor(GattDescriptorRef(entry.ref, CCCD), value) ?: SubmitStatus.ERROR_UNKNOWN
        }
      }
    }
  }

  private fun resolveIndicate(mode: SubscribeMode, properties: Int, characteristic: UUID): Boolean {
    val notifies = properties and CharacteristicProperties.NOTIFY != 0
    val indicates = properties and CharacteristicProperties.INDICATE != 0
    return when (mode) {
      SubscribeMode.AUTO -> !notifies
      SubscribeMode.NOTIFY -> if (notifies) false else throw notSupported(characteristic, "notifications")
      SubscribeMode.INDICATE -> if (indicates) true else throw notSupported(characteristic, "indications")
    }
  }

  private fun notSupported(characteristic: UUID, what: String) =
    CoreError(CoreError.Code.NOT_SUPPORTED, "Characteristic $characteristic doesn't support $what")

  /** Negotiates the ATT MTU (23–517) and resolves the value both sides agreed on (plan §5.4). */
  fun requestMtu(mtu: Int, timeoutMs: Long?, completion: (Result<Int>) -> Unit, operationId: Int? = null) {
    if (mtu !in DEFAULT_MTU..MAX_MTU) {
      val error = CoreError(CoreError.Code.INVALID_ARGUMENT, "MTU $mtu is outside $DEFAULT_MTU–$MAX_MTU")
      return completion(Result.failure(error))
    }
    val kind = GattOperation.Kind.REQUEST_MTU
    enqueueAttributeOperation(kind, "mtu", timeoutMs, completion, operationId, valueOf = { it.number ?: this.mtu }) {
      if (gatt?.requestMtu(mtu) != true) refused("MTU request")
    }
  }

  /** Reads the link's RSSI in dBm. */
  fun readRssi(timeoutMs: Long?, completion: (Result<Int>) -> Unit, operationId: Int? = null) {
    val kind = GattOperation.Kind.READ_RSSI
    enqueueAttributeOperation(kind, "rssi", timeoutMs, completion, operationId, valueOf = { it.number ?: 0 }) {
      if (gatt?.readRemoteRssi() != true) refused("RSSI read")
    }
  }

  /**
   * Bonds with the device (P5-01, Android): a queued operation, finished by the bond-state broadcast
   * ([onBondStateChanged]). Already bonded resolves at once. It never confirms a pairing itself:
   * Android shows its pairing dialog when the device asks for one, and the user decides.
   */
  fun createBond(timeoutMs: Long?, completion: (Result<Unit>) -> Unit, operationId: Int? = null) {
    enqueueAttributeOperation(GattOperation.Kind.BOND, "bond", timeoutMs, completion, operationId, valueOf = { }) {
      val remote = device()
      when {
        remote.bondState == BondStates.BONDED -> completeBond(null)

        // Bonding started, or another app's bonding is under way: the broadcast finishes it.
        remote.createBond() || remote.bondState == BondStates.BONDING -> Unit

        else -> completeBond(CoreError(CoreError.Code.BOND_FAILED, "Android refused to start bonding with $address"))
      }
    }
  }

  /** The bond-state broadcast for this device, from the engine. */
  fun onBondStateChanged(bondState: Int) {
    when (bondState) {
      BondStates.BONDED -> completeBond(null)

      BondStates.NONE -> completeBond(
        CoreError(CoreError.Code.BOND_FAILED, "Bonding with $address failed or was refused"),
      )
    }
  }

  private fun completeBond(error: CoreError?) {
    queue.complete(error?.let(GattResult::Failure) ?: GattResult.Success()) { it.kind == GattOperation.Kind.BOND }
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
    linkCongested = false
    packetInFlight = null
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

    override fun onCharacteristicRead(ref: GattCharacteristicRef, value: ByteArray, status: Int) {
      if (attemptGeneration == generation) onAttributeResult(GattOperation.Kind.READ, key(ref), status, value, "Read")
    }

    override fun onCharacteristicWrite(ref: GattCharacteristicRef, status: Int) {
      if (attemptGeneration == generation) {
        // Android reports both write types here; whichever is in flight for this characteristic.
        if (queue.current?.kind == GattOperation.Kind.WRITE_WITHOUT_RESPONSE) {
          onPacketResult(key(ref), status)
        } else {
          onAttributeResult(GattOperation.Kind.WRITE, key(ref), status, null, "Write")
        }
      }
    }

    override fun onDescriptorRead(ref: GattDescriptorRef, value: ByteArray, status: Int) {
      if (attemptGeneration == generation) {
        onAttributeResult(GattOperation.Kind.READ_DESCRIPTOR, key(ref), status, value, "Descriptor read")
      }
    }

    override fun onDescriptorWrite(ref: GattDescriptorRef, status: Int) {
      if (attemptGeneration == generation) {
        if (ref.uuid == CCCD) {
          onAttributeResult(GattOperation.Kind.SET_NOTIFY, key(ref.characteristic), status, null, "CCCD write")
        } else {
          onAttributeResult(GattOperation.Kind.WRITE_DESCRIPTOR, key(ref), status, null, "Descriptor write")
        }
      }
    }

    override fun onCharacteristicChanged(ref: GattCharacteristicRef, value: ByteArray) {
      // Only subscribed characteristics deliver; a stray value after unsubscribing is dropped.
      val entry = subscriptions[key(ref)]
      if (attemptGeneration == generation && entry?.enabled == true) {
        deliver(entry, value)
      }
    }

    override fun onMtuChanged(mtu: Int, status: Int) {
      if (attemptGeneration != generation) return
      val error = AndroidErrorMapping.operationError(status, "MTU request")
      if (error == null) updateMtu(mtu)
      queue.complete(error?.let(GattResult::Failure) ?: GattResult.Success(number = mtu)) {
        it.kind == GattOperation.Kind.REQUEST_MTU
      }
    }

    override fun onReadRemoteRssi(rssi: Int, status: Int) {
      if (attemptGeneration != generation) return
      val result = AndroidErrorMapping.operationError(status, "RSSI read")?.let(GattResult::Failure)
        ?: GattResult.Success(number = rssi)
      queue.complete(result) { it.kind == GattOperation.Kind.READ_RSSI }
    }

    override fun onServiceChanged() {
      if (attemptGeneration == generation) servicesChanged()
    }

    override fun onServicesDiscovered(status: Int) {
      if (attemptGeneration == generation) {
        val result = AndroidErrorMapping.operationError(status, "Service discovery")?.let(GattResult::Failure)
          ?: GattResult.Success()
        queue.complete(result) { it.kind == GattOperation.Kind.DISCOVER_SERVICES }
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

      // The link dropped during post-connect setup: the connect (or reconnection attempt) failed.
      SessionState.CONNECTED, SessionState.DISCOVERING -> if (down) {
        failConnect(AndroidErrorMapping.connectionError(status, wasConnected = false))
      }

      SessionState.READY -> if (down) {
        closeGatt(disconnectFirst = false)
        val error = AndroidErrorMapping.connectionError(status, wasConnected = true)
        if (reconnect != null) startReconnecting(error) else finishDisconnected(error)
      }

      SessionState.DISCONNECTING -> if (down) {
        closeGatt(disconnectFirst = false)
        finishDisconnected(null)
      }

      SessionState.DISCONNECTED, SessionState.RECONNECTING -> Unit
    }
  }

  private fun onAttributeResult(
    kind: GattOperation.Kind,
    target: String,
    status: Int,
    value: ByteArray?,
    operation: String,
  ) {
    val result = AndroidErrorMapping.operationError(status, operation)?.let(GattResult::Failure)
      ?: GattResult.Success(value)
    queue.complete(result) { it.kind == kind && it.target == target }
  }

  /** Queues one attribute operation; [start] submits it, and a callback completes it. */
  private fun <T> enqueueAttributeOperation(
    kind: GattOperation.Kind,
    target: String,
    timeoutMs: Long?,
    completion: (Result<T>) -> Unit,
    operationId: Int?,
    valueOf: (GattResult.Success) -> T,
    requireReady: Boolean = true,
    first: Boolean = false,
    start: () -> Unit,
  ) {
    if (requireReady && state != SessionState.READY) {
      return completion(Result.failure(CoreError(CoreError.Code.DISCONNECTED, "Not connected to $address")))
    }
    val operation = queue.enqueue(kind, target, timeoutMs, first, start) { result ->
      operationId?.let(cancellable::remove)
      when (result) {
        is GattResult.Success -> completion(Result.success(valueOf(result)))
        is GattResult.Failure -> completion(Result.failure(result.error))
      }
    }
    operationId?.let { cancellable[it] = operation }
  }

  /** The stack refused to start the in-flight operation. */
  private fun refused(operation: String) {
    val current = queue.current ?: return
    queue.complete(
      GattResult.Failure(CoreError(CoreError.Code.GATT_ERROR, "Android refused to start the $operation")),
    ) {
      it === current
    }
  }

  /**
   * Flow control for writes without response (plan §4.9, P2-02). The packet waits
   * [CONGESTION_RETRY_DELAY_MS] when the stack reported congestion on the previous one: L2CAP
   * refuses packets until the controller drains its queue.
   */
  private fun sendPacket(submit: () -> Unit) {
    val current = queue.current ?: return
    packetInFlight = current to submit
    if (!linkCongested) return submit()
    linkCongested = false
    executor.executeDelayed(CONGESTION_RETRY_DELAY_MS) {
      if (queue.current === current) submit()
    }
  }

  /**
   * The stack's answer to a write without response. CONGESTED means it took the packet and the link
   * is now congested, so the write succeeded (AOSP maps it to success too). INTERNAL_ERROR means
   * L2CAP refused the packet while congested and nothing was sent, so it is sent again after a
   * pause, within the operation's timeout.
   */
  private fun onPacketResult(target: String, status: Int) {
    val current = queue.current?.takeIf { it.kind == GattOperation.Kind.WRITE_WITHOUT_RESPONSE && it.target == target }
      ?: return
    when (status) {
      WriteStatuses.CONGESTED -> {
        linkCongested = true
        queue.complete(GattResult.Success()) { it === current }
      }

      WriteStatuses.INTERNAL_ERROR -> {
        val (operation, submit) = packetInFlight ?: return
        if (operation !== current) return
        linkCongested = true
        sendPacket(submit)
      }

      else -> onAttributeResult(GattOperation.Kind.WRITE_WITHOUT_RESPONSE, target, status, null, "Write")
    }
  }

  /**
   * Submits a write. A busy stack is retried after a short pause while the operation's timeout runs:
   * Android allows one outstanding write per device, and before Android 13 a refused write can't be
   * told apart from a busy one (see AndroidGattClient.writeCharacteristic).
   */
  private fun submitWrite(kind: GattOperation.Kind, operation: String, submit: () -> Int) {
    val current = queue.current ?: return
    val status = submit()
    when {
      status == SubmitStatus.SUCCESS -> Unit

      status == SubmitStatus.ERROR_GATT_WRITE_REQUEST_BUSY -> executor.executeDelayed(BUSY_RETRY_DELAY_MS) {
        if (queue.current === current && current.kind == kind) submitWrite(kind, operation, submit)
      }

      else -> {
        val error = AndroidErrorMapping.submitError(status, operation)
          ?: CoreError(CoreError.Code.GATT_ERROR, "$operation was refused with status $status")
        queue.complete(GattResult.Failure(error)) { it === current }
      }
    }
  }

  /** The first discovered instance of [characteristic] in [service], if it allows [property]. */
  private fun findCharacteristic(
    service: UUID,
    characteristic: UUID,
    property: Int,
    notPermitted: CoreError.Code,
  ): GattCharacteristicRef {
    if (state != SessionState.READY) {
      throw CoreError(CoreError.Code.DISCONNECTED, "Not connected to $address")
    }
    val found = services.firstOrNull { it.uuid == service }
      ?: throw CoreError(CoreError.Code.SERVICE_NOT_FOUND, "Service $service not found; discover() it first")
    val info = found.characteristics.firstOrNull { it.ref.uuid == characteristic }
      ?: throw CoreError(
        CoreError.Code.CHARACTERISTIC_NOT_FOUND,
        "Characteristic $characteristic not found in $service",
      )
    if (info.properties and property == 0) {
      throw CoreError(notPermitted, "Characteristic $characteristic doesn't allow this (properties ${info.properties})")
    }
    return info.ref
  }

  private fun findDescriptor(service: UUID, characteristic: UUID, descriptor: UUID): GattDescriptorRef {
    if (state != SessionState.READY) {
      throw CoreError(CoreError.Code.DISCONNECTED, "Not connected to $address")
    }
    val found = services.firstOrNull { it.uuid == service }
      ?: throw CoreError(CoreError.Code.SERVICE_NOT_FOUND, "Service $service not found; discover() it first")
    val info = found.characteristics.firstOrNull { it.ref.uuid == characteristic }
      ?: throw CoreError(
        CoreError.Code.CHARACTERISTIC_NOT_FOUND,
        "Characteristic $characteristic not found in $service",
      )
    if (descriptor !in info.descriptors) {
      throw CoreError(CoreError.Code.DESCRIPTOR_NOT_FOUND, "Descriptor $descriptor not found on $characteristic")
    }
    return GattDescriptorRef(info.ref, descriptor)
  }

  private fun checkLength(value: ByteArray, max: Int) {
    if (value.size > max) {
      throw CoreError(CoreError.Code.INVALID_ATTRIBUTE_LENGTH, "${value.size} bytes is more than the $max allowed here")
    }
  }

  /** The connect timeout keeps running through setup: connect() covers it all (plan §4.8). */
  private fun onLinkUp() {
    setState(SessionState.CONNECTED, null)
    // Restoring subscriptions needs the characteristics, whatever autoDiscover says.
    if (!autoDiscover && !(reconnectAttempt > 0 && subscriptions.isNotEmpty())) {
      exchangeMtu()
      return
    }
    setState(SessionState.DISCOVERING, null)
    discover(filter = null, timeoutMs = null, completion = { result ->
      if (state == SessionState.DISCOVERING) {
        result.fold(onSuccess = { exchangeMtu() }, onFailure = { failConnect(it as CoreError) })
      }
    })
  }

  /**
   * The last setup step (plan §4.8): ask for the configured MTU. A refusal or failure isn't fatal:
   * the connection keeps the MTU it has, and a warning says why.
   */
  private fun exchangeMtu() {
    val requested = setupMtu ?: return restoreSubscriptions()
    val setupState = state
    enqueueSetupOperation(GattOperation.Kind.REQUEST_MTU, { gatt?.requestMtu(requested) == true }) { result ->
      if (state != setupState) return@enqueueSetupOperation
      (result as? GattResult.Failure)?.let { failure ->
        val reason = failure.error
        val message = "$address: the MTU request after connecting failed, so the MTU stays $mtu (${reason.message})"
        onWarning?.invoke(CoreError(reason.code, message, reason.gattStatus))
      }
      restoreSubscriptions()
    }
  }

  /**
   * After a reconnection (P2-01) or a service change (P2-06): enables the CCCD of every subscription
   * again, then calls [then] (by default the connection is ready). A subscription whose
   * characteristic is gone or whose CCCD write fails ends alone.
   */
  private fun restoreSubscriptions(after: String = "reconnecting", then: () -> Unit = ::becomeReady) {
    val entries = subscriptions.values.toList()
    if (entries.isEmpty()) return then()
    val setupState = state
    var remaining = entries.size
    val done = {
      remaining -= 1
      if (remaining == 0 && state == setupState) then()
    }
    for (entry in entries) {
      val ref = services.firstOrNull { it.uuid == entry.ref.serviceUuid }
        ?.characteristics
        ?.firstOrNull { it.ref.uuid == entry.ref.uuid && CCCD in it.descriptors }
        ?.ref
      if (ref == null) {
        endSubscriptions(
          entry,
          CoreError(CoreError.Code.CHARACTERISTIC_NOT_FOUND, "${entry.ref.uuid} is gone after $after"),
        )
        done()
        continue
      }
      rekey(entry, ref)
      setNotification(entry, enable = true, timeoutMs = null, setup = true) { result ->
        if (state != setupState) return@setNotification
        result.fold(onSuccess = { entry.enabled = true }, onFailure = { endSubscriptions(entry, it as CoreError) })
        done()
      }
    }
  }

  /** Discovery gives new handles: the entry and its subscribers move to the new key. */
  private fun rekey(entry: CharacteristicSubscriptions, ref: GattCharacteristicRef) {
    val oldKey = key(entry.ref)
    val newKey = key(ref)
    entry.ref = ref
    if (oldKey == newKey) return
    subscriptions.remove(oldKey)
    subscriptions[newKey] = entry
    entry.subscribers.forEach { subscriptionKeys[it] = newKey }
  }

  private fun endSubscriptions(entry: CharacteristicSubscriptions, error: CoreError) {
    subscriptions.remove(key(entry.ref))
    flushBatches(entry.subscribers)
    entry.subscribers.forEach { id ->
      subscriptionKeys.remove(id)
      onSubscriptionEnded?.invoke(id, error)
    }
  }

  /**
   * The peripheral's GATT database changed (P2-06): Android 12+ `onServiceChanged`, or a cache
   * refresh. The cache is stale, so it is emptied and discovered again ahead of queued operations;
   * the subscriptions are restored on what is still there, then [onServicesChanged] fires. During
   * setup the discovery under way picks up the new database.
   */
  private fun servicesChanged(done: () -> Unit = {}) {
    if (state != SessionState.READY) return done()
    services = emptyList()
    subscriptions.values.forEach { it.enabled = false }
    discover(filter = null, timeoutMs = null, first = true, completion = { result ->
      if (state != SessionState.READY) return@discover done()
      result.onFailure { error ->
        onWarning?.invoke(
          CoreError((error as CoreError).code, "$address: discovering the changed services failed (${error.message})"),
        )
      }
      restoreSubscriptions(after = "the service change") {
        onServicesChanged?.invoke()
        done()
      }
    })
  }

  /**
   * Clears Android's GATT cache for this device with the hidden `BluetoothGatt.refresh()` (opt-in,
   * plan §4.4), then discovers again like after a service change. False when the platform lacks it.
   */
  fun refreshGattCache(completion: (Result<Boolean>) -> Unit) {
    if (state != SessionState.READY) {
      return completion(Result.failure(CoreError(CoreError.Code.DISCONNECTED, "Not connected to $address")))
    }
    if (gatt?.refreshCache() != true) return completion(Result.success(false))
    servicesChanged { completion(Result.success(true)) }
  }

  /** Operations in a row timed out: the stack is stuck, so the connection is reset (plan §4.9). */
  private fun resetStuckConnection(timeouts: Int) {
    val error = CoreError(
      CoreError.Code.DISCONNECTED,
      "$timeouts operations in a row timed out, so the connection to $address was reset",
    )
    when (state) {
      SessionState.READY -> {
        closeGatt(disconnectFirst = true)
        if (reconnect != null) startReconnecting(error) else finishDisconnected(error)
      }

      SessionState.CONNECTED, SessionState.DISCOVERING -> failConnect(error)

      SessionState.DISCONNECTED, SessionState.RECONNECTING -> Unit

      else -> {
        closeGatt(disconnectFirst = true)
        finishDisconnected(error)
      }
    }
  }

  /** A ready connection was lost unexpectedly and a policy is set: wait, then try again (P2-01). */
  private fun startReconnecting(error: CoreError) {
    services = emptyList()
    mtu = DEFAULT_MTU
    reconnectAttempt = 1
    setState(SessionState.RECONNECTING, error)
    queue.failAll(CoreError(CoreError.Code.DISCONNECTED, "Disconnected from $address"))
    if (restoreSubscriptions) {
      subscriptions.values.forEach { it.enabled = false }
    } else {
      subscriptions.values.toList().forEach { endSubscriptions(it, error) }
    }
    scheduleReconnect()
  }

  private fun scheduleReconnect() {
    val policy = reconnect ?: return
    reconnectTimer = executor.executeDelayed(policy.delayMs(reconnectAttempt)) {
      reconnectTimer = null
      if (state == SessionState.RECONNECTING) beginReconnectAttempt()
    }
  }

  /** Direct first, then autoConnect (plan P2-01): a quick try while the device is likely near. */
  private fun beginReconnectAttempt() {
    attempts = 0
    autoConnect = reconnectAttempt > 1
    setState(SessionState.CONNECTING, null)
    connectTimeoutMs?.let { timeoutMs ->
      connectTimeout = executor.executeDelayed(timeoutMs) {
        connectTimeout = null
        failConnect(
          CoreError(CoreError.Code.CONNECTION_TIMEOUT, "Reconnecting to $address timed out after $timeoutMs ms"),
        )
      }
    }
    open()
  }

  /** A reconnection attempt failed: wait for the next one, or give up with [error]. */
  private fun retryReconnect(error: CoreError) {
    connectTimeout?.cancel()
    connectTimeout = null
    retry?.cancel()
    retry = null
    services = emptyList()
    mtu = DEFAULT_MTU
    queue.failAll(CoreError(CoreError.Code.DISCONNECTED, "Disconnected from $address"))
    val next = reconnectAttempt + 1
    if (reconnect?.allows(next) != true) {
      finishDisconnected(error)
      return
    }
    reconnectAttempt = next
    subscriptions.values.forEach { it.enabled = false }
    setState(SessionState.RECONNECTING, error)
    scheduleReconnect()
  }

  /** Like an attribute operation, but allowed before READY (setup steps). */
  private fun enqueueSetupOperation(kind: GattOperation.Kind, submit: () -> Boolean, completion: (GattResult) -> Unit) {
    queue.enqueue(kind, timeoutMs = null, start = { if (!submit()) refused("MTU request") }, completion = completion)
  }

  /** Only a ready connection reports changes: the value set up before is in [mtu] at `connected`. */
  private fun updateMtu(newMtu: Int) {
    if (newMtu != mtu) {
      mtu = newMtu
      if (state == SessionState.READY) onMtuChange?.invoke(newMtu)
    }
  }

  private fun becomeReady() {
    connectTimeout?.cancel()
    connectTimeout = null
    reconnectAttempt = 0
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
    if (reconnectAttempt > 0 && error != null) {
      retryReconnect(error)
    } else {
      finishDisconnected(error, connectError)
    }
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
    reconnectTimer?.cancel()
    reconnectTimer = null
    reconnectAttempt = 0
    // Handles, the database and the MTU can differ on the next connection.
    services = emptyList()
    mtu = DEFAULT_MTU
    // Batched subscribers get their last values before JS hears that their subscriptions ended.
    flushBatches(batchers.keys.toList())
    // The state changes first, so callbacks of the operations failed below see the final state.
    setState(SessionState.DISCONNECTED, error)
    queue.failAll(CoreError(CoreError.Code.DISCONNECTED, "Disconnected from $address"))
    // Subscriptions end with the connection (plan §4.8); a reconnection keeps them (P2-01).
    subscriptions.clear()
    subscriptionKeys.clear()
    val connects = connectWaiters.toList()
    connectWaiters.clear()
    connects.forEach { it(connectError) }
    val disconnects = disconnectWaiters.toList()
    disconnectWaiters.clear()
    disconnects.forEach { it() }
  }

  /** The listener hears changes of the JS state only (plan §4.8 maps several native states to one). */
  private fun setState(newState: SessionState, error: CoreError?) {
    state = newState
    val now = visible(newState)
    if (now.js != reported.js) {
      reported = now
      onStateChange(now, error)
    }
  }

  private fun visible(state: SessionState): SessionState = when {
    reconnectAttempt > 0 && state in SETUP_STATES -> SessionState.RECONNECTING
    else -> state
  }

  companion object {
    /** `BluetoothGatt.GATT_ERROR` (0x85), Android's catch-all connect failure. */
    const val GATT_ERROR = 133
    const val MAX_CONNECT_ATTEMPTS = 3
    const val RETRY_BASE_DELAY_MS = 250L
    const val DISCONNECT_TIMEOUT_MS = 5_000L

    /** Discovery is one queued operation, and slower than the 10 s default (plan §4.9). */
    const val DISCOVERY_TIMEOUT_MS = 30_000L
    const val DEFAULT_MTU = 23
    const val MAX_MTU = 517
    private val SETUP_STATES = setOf(SessionState.CONNECTING, SessionState.CONNECTED, SessionState.DISCOVERING)

    /** The ATT maximum for an attribute value. */
    const val MAX_ATTRIBUTE_LENGTH = 512
    const val BUSY_RETRY_DELAY_MS = 5L

    /** writeStream reports progress about this many times (P2-03). */
    const val PROGRESS_STEPS = 100

    /** The pause before a write without response on a congested link (P2-02). */
    const val CONGESTION_RETRY_DELAY_MS = 10L
    val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    private val CCCD_NOTIFY = byteArrayOf(0x01, 0x00)
    private val CCCD_INDICATE = byteArrayOf(0x02, 0x00)
    private val CCCD_DISABLE = byteArrayOf(0x00, 0x00)

    private fun key(ref: GattCharacteristicRef) =
      "${ref.serviceUuid}#${ref.serviceInstanceId}/${ref.uuid}#${ref.instanceId}"

    private fun key(ref: GattDescriptorRef) = "${key(ref.characteristic)}/${ref.uuid}"
  }
}
