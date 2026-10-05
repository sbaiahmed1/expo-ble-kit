package expo.modules.blekit.core

import java.util.UUID

/**
 * The local GATT server of the peripheral role (plan §4.4, §5.5, P4-01).
 *
 * Static values and descriptors are answered here; reads and writes of dynamic characteristics go
 * to JS ([Listener]) and must be answered within [RESPONSE_DEADLINE_MS], or the core answers with
 * an ATT error. Long reads come from the [ServerReadCache]; long writes (prepared writes) reach JS
 * as one write per characteristic when the central executes them. On Android the server tracks
 * subscriptions itself, through each notifiable characteristic's CCCD.
 *
 * Threading (plan §4.7): everything on the server thread ([executor]).
 */
class GattServer(
  private val services: List<ServerServiceSpec>,
  private val executor: SerialExecutor,
  /** Opens the platform server; null when Android refuses. */
  private val openPort: (GattServerEvents) -> GattServerPort?,
) {
  interface Listener {
    fun onReadRequest(requestId: Int, central: String, characteristic: UUID, offset: Int)

    fun onWriteRequest(
      requestId: Int,
      central: String,
      characteristic: UUID,
      offset: Int,
      value: ByteArray,
      withResponse: Boolean,
    )

    fun onSubscriptionChange(central: String, characteristic: UUID, subscribed: Boolean)

    fun onWarning(warning: CoreError)
  }

  var listener: Listener? = null

  private val characteristics = services.flatMap { it.characteristics }.associateBy { it.uuid }
  private val readCache = ServerReadCache(executor::nowMs)
  private var port: GattServerPort? = null
  private var nextRequestId = 1

  /** A JS request waiting for its answer. A write of an execute has an [execute] group. */
  private class Pending(
    val read: Boolean,
    val central: String,
    val platformRequestId: Int,
    val characteristic: UUID,
    val offset: Int,
    val responseNeeded: Boolean,
    val execute: ExecuteGroup?,
    var deadline: Cancellable? = null,
  )

  /** The writes of one execute request, answered once all of them are. */
  private class ExecuteGroup(val central: String, val platformRequestId: Int, var remaining: Int) {
    var error: Int = AttErrors.SUCCESS
  }

  private class PreparedWrite(val characteristic: UUID, val offset: Int, val value: ByteArray)

  private val pending = HashMap<Int, Pending>()
  private val prepared = HashMap<String, MutableList<PreparedWrite>>()

  /** Notify (1) or indicate (2) per central, by characteristic. */
  private val subscribers = HashMap<UUID, MutableMap<String, Int>>()

  /** P4-02: one call of [notify], done once every target central is. */
  private class NotifyCall(var remaining: Int, val completion: (CoreError?) -> Unit) {
    var error: CoreError? = null

    fun done(error: CoreError?) {
      if (error != null && this.error == null) this.error = error
      if (--remaining == 0) completion(this.error)
    }
  }

  private class Notification(val characteristic: UUID, val value: ByteArray, val confirm: Boolean, val call: NotifyCall)

  /**
   * Per central: notifications waiting, whether Android is sending the first (wait for
   * onNotificationSent), a busy retry, and the first one's deadline (from its first attempt).
   */
  private class Outbox {
    val queue = ArrayDeque<Notification>()
    var sending = false
    var retry: Cancellable? = null
    var deadline: Cancellable? = null

    fun cancelTimers() {
      retry?.cancel()
      retry = null
      deadline?.cancel()
      deadline = null
    }
  }

  private val outboxes = HashMap<String, Outbox>()
  private val mtus = HashMap<String, Int>()

  /** Opens the server and adds the services one at a time, as Android requires. */
  fun open(completion: (CoreError?) -> Unit) {
    val opened = openPort(Events())
    if (opened == null) {
      completion(CoreError(CoreError.Code.INTERNAL, "Android refused to open a GATT server"))
      return
    }
    port = opened
    addServices(services, completion)
  }

  private var adding: ((Int, UUID) -> Unit)? = null

  private fun addServices(remaining: List<ServerServiceSpec>, completion: (CoreError?) -> Unit) {
    val service = remaining.firstOrNull() ?: return completion(null)
    val port = port ?: return
    val timeout = executor.executeDelayed(ADD_SERVICE_TIMEOUT_MS) {
      adding = null
      fail(completion, CoreError(CoreError.Code.OPERATION_TIMEOUT, "Adding service ${service.uuid} timed out"))
    }
    adding = { status, uuid ->
      if (uuid == service.uuid) {
        timeout.cancel()
        adding = null
        if (status == GATT_SUCCESS) {
          addServices(remaining.drop(1), completion)
        } else {
          fail(completion, CoreError(CoreError.Code.GATT_ERROR, "Android couldn't add service $uuid", status))
        }
      }
    }
    if (!port.addService(service)) {
      timeout.cancel()
      adding = null
      fail(completion, CoreError(CoreError.Code.INTERNAL, "Android refused to add service ${service.uuid}"))
    }
  }

  private fun fail(completion: (CoreError?) -> Unit, error: CoreError) {
    close()
    completion(error)
  }

  /** JS answers a read: the whole value, or an ATT error. Unknown or expired requests are ignored. */
  fun respondToRead(requestId: Int, value: ByteArray?, attError: Int?) {
    val request = pending.remove(requestId) ?: return
    request.deadline?.cancel()
    if (attError != null || value == null) {
      respond(request.central, request.platformRequestId, attError ?: AttErrors.UNLIKELY_ERROR, request.offset, null)
      return
    }
    readCache.store(request.central, request.characteristic, value)
    answerRead(request.central, request.platformRequestId, value, request.offset)
  }

  /** JS answers a write: null for success, or an ATT error. */
  fun respondToWrite(requestId: Int, attError: Int?) {
    val request = pending.remove(requestId) ?: return
    request.deadline?.cancel()
    val status = attError ?: AttErrors.SUCCESS
    val group = request.execute
    if (group != null) {
      if (status != AttErrors.SUCCESS && group.error == AttErrors.SUCCESS) group.error = status
      if (--group.remaining == 0) respond(group.central, group.platformRequestId, group.error, 0, null)
    } else if (request.responseNeeded) {
      respond(request.central, request.platformRequestId, status, request.offset, null)
    }
  }

  /**
   * Sends [value] to the centrals subscribed to [characteristic] (only those in [centrals] when
   * given), one notification in flight per central (plan §4.4: wait for `onNotificationSent`).
   * [completion] gets null once every target took it, or the first error; a central that
   * disconnects meanwhile just drops out. The value must fit every target's MTU − 3.
   */
  fun notify(characteristic: UUID, value: ByteArray, centrals: List<String>?, completion: (CoreError?) -> Unit) {
    val spec = characteristics[characteristic]
    val error = when {
      port == null -> CoreError(CoreError.Code.DISCONNECTED, "The GATT server is closed")

      spec == null -> CoreError(
        CoreError.Code.CHARACTERISTIC_NOT_FOUND,
        "No characteristic $characteristic on the server",
      )

      !spec.notifiable -> CoreError(CoreError.Code.NOT_SUPPORTED, "$characteristic doesn't notify or indicate")

      else -> null
    }
    if (error != null) return completion(error)
    val targets = subscribers[characteristic].orEmpty().filterKeys { centrals == null || it in centrals }
    targets.keys.firstOrNull { value.size > (mtus[it] ?: DEFAULT_MTU) - 3 }?.let { central ->
      val limit = (mtus[central] ?: DEFAULT_MTU) - 3
      return completion(
        CoreError(
          CoreError.Code.INVALID_ATTRIBUTE_LENGTH,
          "A notification to $central takes at most $limit bytes (MTU − 3), got ${value.size}",
        ),
      )
    }
    if (targets.isEmpty()) return completion(null)
    val call = NotifyCall(targets.size, completion)
    for ((central, mode) in targets) {
      outboxes.getOrPut(central) { Outbox() }.queue.addLast(Notification(characteristic, value, mode == 2, call))
      pump(central)
    }
  }

  private fun pump(central: String) {
    val outbox = outboxes[central] ?: return
    if (outbox.sending || outbox.retry != null) return
    val next = outbox.queue.firstOrNull() ?: return
    val port = port ?: return
    // One deadline over busy retries and the wait for onNotificationSent.
    if (outbox.deadline == null) {
      outbox.deadline = executor.executeDelayed(NOTIFY_TIMEOUT_MS) {
        outbox.deadline = null
        finishHead(
          central,
          CoreError(CoreError.Code.OPERATION_TIMEOUT, "Notifying $central timed out after $NOTIFY_TIMEOUT_MS ms"),
        )
      }
    }
    when (val status = port.notify(central, next.characteristic, next.value, next.confirm)) {
      SubmitStatus.SUCCESS -> outbox.sending = true

      // The stack is still sending the previous packets: try again shortly (as for client writes, P2-02).
      SubmitStatus.ERROR_GATT_WRITE_REQUEST_BUSY -> outbox.retry = executor.executeDelayed(BUSY_RETRY_MS) {
        outbox.retry = null
        pump(central)
      }

      else -> finishHead(
        central,
        CoreError(CoreError.Code.GATT_ERROR, "Android refused to notify $central (status $status)"),
      )
    }
  }

  private fun finishHead(central: String, error: CoreError?) {
    val outbox = outboxes[central] ?: return
    outbox.cancelTimers()
    outbox.sending = false
    outbox.queue.removeFirstOrNull()?.call?.done(error)
    pump(central)
  }

  /** The central is gone: its notifications count as done, without an error. */
  private fun dropOutbox(central: String) {
    val outbox = outboxes.remove(central) ?: return
    outbox.cancelTimers()
    outbox.queue.forEach { it.call.done(null) }
  }

  fun close() {
    outboxes.keys.toList().forEach { central ->
      val outbox = outboxes.remove(central) ?: return@forEach
      outbox.cancelTimers()
      outbox.queue.forEach { it.call.done(CoreError(CoreError.Code.DISCONNECTED, "The GATT server closed")) }
    }
    mtus.clear()
    pending.values.forEach { it.deadline?.cancel() }
    pending.clear()
    prepared.clear()
    subscribers.clear()
    readCache.clear()
    adding = null
    port?.close()
    port = null
  }

  /** Centrals subscribed to [characteristic], for P4-02's notifications. */
  fun subscribedCentrals(characteristic: UUID): Set<String> = subscribers[characteristic]?.keys.orEmpty()

  private fun answerRead(central: String, requestId: Int, value: ByteArray, offset: Int) {
    val slice = ServerReadCache.slice(value, offset)
    if (slice == null) {
      respond(central, requestId, AttErrors.INVALID_OFFSET, offset, null)
    } else {
      respond(central, requestId, AttErrors.SUCCESS, offset, slice)
    }
  }

  private fun respond(central: String, requestId: Int, status: Int, offset: Int, value: ByteArray?) {
    port?.sendResponse(central, requestId, status, offset, value)
  }

  private fun ask(request: Pending, notify: (Int) -> Unit) {
    val id = nextRequestId++
    pending[id] = request
    request.deadline = executor.executeDelayed(RESPONSE_DEADLINE_MS) {
      if (!pending.containsKey(id)) return@executeDelayed
      val kind = if (request.read) "read" else "write"
      listener?.onWarning(
        CoreError(
          CoreError.Code.OPERATION_TIMEOUT,
          "The $kind request for ${request.characteristic} wasn't answered within $RESPONSE_DEADLINE_MS ms; " +
            "the server answered with an ATT error",
        ),
      )
      // The same path as a JS error, so an execute group still completes.
      if (request.read) {
        respondToRead(
          id,
          null,
          AttErrors.UNLIKELY_ERROR,
        )
      } else {
        respondToWrite(id, AttErrors.UNLIKELY_ERROR)
      }
    }
    notify(id)
  }

  private inner class Events : GattServerEvents {
    override fun onConnectionStateChange(central: String, connected: Boolean) {
      if (connected) return
      // The link is gone: nothing to answer any more.
      pending.values.removeAll { request ->
        (request.central == central).also { gone -> if (gone) request.deadline?.cancel() }
      }
      prepared.remove(central)
      readCache.drop(central)
      mtus.remove(central)
      dropOutbox(central)
      subscribers.forEach { (characteristic, centrals) ->
        if (centrals.remove(central) != null) listener?.onSubscriptionChange(central, characteristic, false)
      }
    }

    override fun onNotificationSent(central: String, status: Int) {
      val outbox = outboxes[central] ?: return
      if (!outbox.sending) return
      val error = if (status ==
        GATT_SUCCESS
      ) {
        null
      } else {
        CoreError(CoreError.Code.GATT_ERROR, "Notifying $central failed", status)
      }
      finishHead(central, error)
    }

    override fun onMtuChanged(central: String, mtu: Int) {
      mtus[central] = mtu
    }

    override fun onServiceAdded(status: Int, service: UUID) {
      adding?.invoke(status, service)
    }

    override fun onCharacteristicReadRequest(central: String, requestId: Int, offset: Int, characteristic: UUID) {
      val spec = characteristics[characteristic]
      if (spec == null) {
        respond(central, requestId, AttErrors.UNLIKELY_ERROR, offset, null)
        return
      }
      spec.value?.let { return answerRead(central, requestId, it, offset) }
      readCache.lookup(central, characteristic, offset)?.let { return answerRead(central, requestId, it, offset) }
      ask(Pending(true, central, requestId, characteristic, offset, responseNeeded = true, execute = null)) { id ->
        listener?.onReadRequest(id, central, characteristic, offset)
      }
    }

    override fun onCharacteristicWriteRequest(
      central: String,
      requestId: Int,
      characteristic: UUID,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      val spec = characteristics[characteristic]
      if (spec == null || spec.value != null) {
        if (responseNeeded) respond(central, requestId, AttErrors.WRITE_NOT_PERMITTED, offset, null)
        return
      }
      if (preparedWrite) {
        // Prepare Write Response echoes the part; the value reaches JS at execute.
        prepared.getOrPut(central) { mutableListOf() } += PreparedWrite(characteristic, offset, value)
        if (responseNeeded) respond(central, requestId, AttErrors.SUCCESS, offset, value)
        return
      }
      ask(Pending(false, central, requestId, characteristic, offset, responseNeeded, execute = null)) { id ->
        listener?.onWriteRequest(id, central, characteristic, offset, value, responseNeeded)
      }
    }

    override fun onExecuteWrite(central: String, requestId: Int, execute: Boolean) {
      val writes = prepared.remove(central).orEmpty()
      if (!execute || writes.isEmpty()) {
        respond(central, requestId, AttErrors.SUCCESS, 0, null)
        return
      }
      // One value per characteristic, assembled from its parts in order.
      val values = LinkedHashMap<UUID, ByteArray>()
      for (write in writes) {
        val current = values[write.characteristic] ?: ByteArray(0)
        val end = write.offset + write.value.size
        if (write.offset > current.size || end > MAX_VALUE_LENGTH) {
          val status = if (write.offset > current.size) AttErrors.INVALID_OFFSET else AttErrors.INVALID_ATTRIBUTE_LENGTH
          respond(central, requestId, status, 0, null)
          return
        }
        val next = current.copyOf(maxOf(current.size, end))
        write.value.copyInto(next, write.offset)
        values[write.characteristic] = next
      }
      val group = ExecuteGroup(central, requestId, values.size)
      for ((characteristic, value) in values) {
        ask(Pending(false, central, requestId, characteristic, 0, responseNeeded = true, execute = group)) { id ->
          listener?.onWriteRequest(id, central, characteristic, 0, value, true)
        }
      }
    }

    override fun onDescriptorReadRequest(
      central: String,
      requestId: Int,
      offset: Int,
      characteristic: UUID,
      descriptor: UUID,
    ) {
      val value =
        if (descriptor == CCCD) {
          val mode = subscribers[characteristic]?.get(central) ?: 0
          byteArrayOf(mode.toByte(), 0)
        } else {
          characteristics[characteristic]?.descriptors?.firstOrNull { it.uuid == descriptor }?.value
        }
      if (value == null) {
        respond(central, requestId, AttErrors.UNLIKELY_ERROR, offset, null)
      } else {
        answerRead(central, requestId, value, offset)
      }
    }

    override fun onDescriptorWriteRequest(
      central: String,
      requestId: Int,
      characteristic: UUID,
      descriptor: UUID,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      val spec = characteristics[characteristic]
      val status =
        when {
          descriptor != CCCD || spec == null || preparedWrite -> AttErrors.WRITE_NOT_PERMITTED
          value.size != 2 || offset != 0 -> AttErrors.INVALID_ATTRIBUTE_LENGTH
          else -> subscribe(central, spec, value[0].toInt() and 0x03)
        }
      if (responseNeeded) respond(central, requestId, status, offset, null)
    }
  }

  /** A CCCD write: 0 off, 1 notifications, 2 indications, if the characteristic has them. */
  private fun subscribe(central: String, spec: ServerCharacteristicSpec, mode: Int): Int {
    val allowed = when (mode) {
      0 -> true
      1 -> spec.properties and CharacteristicProperties.NOTIFY != 0
      2 -> spec.properties and CharacteristicProperties.INDICATE != 0
      else -> false
    }
    if (!allowed) return AttErrors.CCCD_IMPROPERLY_CONFIGURED
    val centrals = subscribers.getOrPut(spec.uuid) { mutableMapOf() }
    val was = centrals.containsKey(central)
    if (mode == 0) centrals.remove(central) else centrals[central] = mode
    if (was != (mode != 0)) listener?.onSubscriptionChange(central, spec.uuid, mode != 0)
    return AttErrors.SUCCESS
  }

  companion object {
    /**
     * JS must answer before this. ATT gives a request 30 s before the link is dropped (Core spec
     * Vol 3 Part F 3.3.3); the core answers with an ATT error first.
     */
    const val RESPONSE_DEADLINE_MS = 25_000L
    const val ADD_SERVICE_TIMEOUT_MS = 10_000L
    const val MAX_VALUE_LENGTH = 512
    const val DEFAULT_MTU = 23

    /** How long one notification may wait, busy retries and `onNotificationSent` included (rule 4). */
    const val NOTIFY_TIMEOUT_MS = 10_000L
    const val BUSY_RETRY_MS = 10L
    val CCCD: UUID = PeripheralSession.CCCD
  }
}
