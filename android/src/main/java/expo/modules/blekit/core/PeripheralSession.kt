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
  ;

  /** JS `ConnectionState` (plan §4.8). */
  val js: String
    get() = when (this) {
      DISCONNECTED -> "disconnected"
      CONNECTING, CONNECTED, DISCOVERING -> "connecting"
      READY -> "connected"
      DISCONNECTING -> "disconnecting"
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
) {
  companion object {
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

  /** Operations on this connection (Appendix B rule 2). */
  val queue = GattQueue(executor).also { queue ->
    // Plan §4.9: on Android, two operations in a row that time out mean a stuck stack.
    queue.onTimeout = { _, consecutiveTimeouts ->
      if (consecutiveTimeouts >= 2 && state != SessionState.DISCONNECTED) {
        closeGatt(disconnectFirst = true)
        finishDisconnected(
          CoreError(CoreError.Code.DISCONNECTED, "Two operations in a row timed out, so the connection was reset"),
        )
      }
    }
  }

  /** A changed ATT MTU on a ready connection, on the BLE thread: after a request, or one the stack or peer started. */
  var onMtuChange: ((Int) -> Unit)? = null

  /** A non-fatal problem, such as a refused MTU request during setup. */
  var onWarning: ((CoreError) -> Unit)? = null

  /** Notifications and indications of subscribed characteristics, on the BLE thread. */
  var onNotification: ((GattCharacteristicRef, ByteArray) -> Unit)? = null

  /** One CCCD per characteristic, shared by its subscribers (plan §5.4). */
  private class CharacteristicSubscriptions(val ref: GattCharacteristicRef, val indicate: Boolean) {
    val subscribers = mutableSetOf<Int>()

    /** Subscribers waiting for the CCCD write that enables delivery. */
    val waiting = mutableMapOf<Int, (Result<Unit>) -> Unit>()
    var enabled = false
  }

  private val subscriptions = mutableMapOf<String, CharacteristicSubscriptions>()

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

  /** A GATT client is open and not yet closed. */
  val hasOpenClient: Boolean get() = gatt != null

  /**
   * Resolves (null) once the connection is ready. A connect while one is pending joins it, with the
   * first call's options.
   */
  fun connect(spec: ConnectSpec, completion: (CoreError?) -> Unit) {
    when (state) {
      SessionState.READY -> completion(null)

      SessionState.CONNECTING, SessionState.CONNECTED, SessionState.DISCOVERING -> connectWaiters += completion

      SessionState.DISCONNECTING -> disconnectWaiters += { connect(spec, completion) }

      SessionState.DISCONNECTED -> {
        connectWaiters += completion
        attempts = 0
        autoConnect = spec.autoConnect
        autoDiscover = spec.autoDiscover
        setupMtu = spec.requestMtu
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
  ) {
    if (state != SessionState.READY && state != SessionState.DISCOVERING) {
      completion(Result.failure(CoreError(CoreError.Code.DISCONNECTED, "Not connected to $address")))
      return
    }
    val operation = queue.enqueue(
      GattOperation.Kind.DISCOVER_SERVICES,
      timeoutMs = timeoutMs ?: DISCOVERY_TIMEOUT_MS,
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
      submitWrite(kind, "Write") { gatt?.writeCharacteristic(ref, value, writeType) ?: SubmitStatus.ERROR_UNKNOWN }
    }
  }

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
    setNotification(entry, enable = false, timeoutMs, completion)
  }

  /** Android needs both the local registration and the CCCD write on the peripheral. */
  private fun setNotification(
    entry: CharacteristicSubscriptions,
    enable: Boolean,
    timeoutMs: Long?,
    completion: (Result<Unit>) -> Unit,
  ) {
    val value = when {
      !enable -> CCCD_DISABLE
      entry.indicate -> CCCD_INDICATE
      else -> CCCD_NOTIFY
    }
    val kind = GattOperation.Kind.SET_NOTIFY
    enqueueAttributeOperation(kind, key(entry.ref), timeoutMs, completion, operationId = null, valueOf = {}) {
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

    override fun onCharacteristicRead(ref: GattCharacteristicRef, value: ByteArray, status: Int) {
      if (attemptGeneration == generation) onAttributeResult(GattOperation.Kind.READ, key(ref), status, value, "Read")
    }

    override fun onCharacteristicWrite(ref: GattCharacteristicRef, status: Int) {
      if (attemptGeneration == generation) {
        // Android reports both write types here; whichever is in flight for this characteristic.
        val kind = queue.current?.kind.takeIf { it == GattOperation.Kind.WRITE_WITHOUT_RESPONSE }
          ?: GattOperation.Kind.WRITE
        onAttributeResult(kind, key(ref), status, null, "Write")
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
      if (attemptGeneration == generation && subscriptions[key(ref)]?.enabled == true) {
        onNotification?.invoke(ref, value)
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

      // The link dropped during post-connect setup: the connect failed.
      SessionState.CONNECTED, SessionState.DISCOVERING -> if (down) {
        closeGatt(disconnectFirst = false)
        finishDisconnected(AndroidErrorMapping.connectionError(status, wasConnected = false))
      }

      SessionState.READY -> if (down) {
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
    start: () -> Unit,
  ) {
    if (state != SessionState.READY) {
      return completion(Result.failure(CoreError(CoreError.Code.DISCONNECTED, "Not connected to $address")))
    }
    val operation = queue.enqueue(kind, target, timeoutMs, start) { result ->
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
   * Submits a write. A busy stack (Android 13+) is retried after a short pause while the operation's
   * timeout runs (basic pacing; flow control is P2-02).
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
    if (!autoDiscover) {
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
    val requested = setupMtu ?: return becomeReady()
    val setupState = state
    enqueueSetupOperation(GattOperation.Kind.REQUEST_MTU, { gatt?.requestMtu(requested) == true }) { result ->
      if (state != setupState) return@enqueueSetupOperation
      (result as? GattResult.Failure)?.let { failure ->
        val reason = failure.error
        val message = "$address: the MTU request after connecting failed, so the MTU stays $mtu (${reason.message})"
        onWarning?.invoke(CoreError(reason.code, message, reason.gattStatus))
      }
      becomeReady()
    }
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
    // Handles, the database and the MTU can differ on the next connection.
    services = emptyList()
    mtu = DEFAULT_MTU
    // The state changes first, so callbacks of the operations failed below see the final state.
    setState(SessionState.DISCONNECTED, error)
    queue.failAll(CoreError(CoreError.Code.DISCONNECTED, "Disconnected from $address"))
    // Subscriptions end with the connection (plan §4.8); restoring them is P2-01's.
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

    /** Discovery is one queued operation, and slower than the 10 s default (plan §4.9). */
    const val DISCOVERY_TIMEOUT_MS = 30_000L
    const val DEFAULT_MTU = 23
    const val MAX_MTU = 517

    /** The ATT maximum for an attribute value. */
    const val MAX_ATTRIBUTE_LENGTH = 512
    const val BUSY_RETRY_DELAY_MS = 5L
    val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    private val CCCD_NOTIFY = byteArrayOf(0x01, 0x00)
    private val CCCD_INDICATE = byteArrayOf(0x02, 0x00)
    private val CCCD_DISABLE = byteArrayOf(0x00, 0x00)

    private fun key(ref: GattCharacteristicRef) =
      "${ref.serviceUuid}#${ref.serviceInstanceId}/${ref.uuid}#${ref.instanceId}"

    private fun key(ref: GattDescriptorRef) = "${key(ref.characteristic)}/${ref.uuid}"
  }
}
