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

  fun close() {
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
      subscribers.forEach { (characteristic, centrals) ->
        if (centrals.remove(central) != null) listener?.onSubscriptionChange(central, characteristic, false)
      }
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
    val CCCD: UUID = PeripheralSession.CCCD
  }
}
