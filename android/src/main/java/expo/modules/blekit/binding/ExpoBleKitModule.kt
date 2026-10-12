package expo.modules.blekit.binding

import android.os.SystemClock
import expo.modules.blekit.core.Advertiser
import expo.modules.blekit.core.AndroidAdvertiser
import expo.modules.blekit.core.AndroidBluetoothAdapterPort
import expo.modules.blekit.core.AndroidCompanion
import expo.modules.blekit.core.AndroidGattServerOpener
import expo.modules.blekit.core.AndroidKeepAlive
import expo.modules.blekit.core.AndroidPermissionSystem
import expo.modules.blekit.core.BleCapability
import expo.modules.blekit.core.BleLogger
import expo.modules.blekit.core.BlePermissionPolicy
import expo.modules.blekit.core.BlePermissions
import expo.modules.blekit.core.BleState
import expo.modules.blekit.core.CentralEngine
import expo.modules.blekit.core.CompanionAssociation
import expo.modules.blekit.core.CompanionDevices
import expo.modules.blekit.core.CoreError
import expo.modules.blekit.core.EpochClock
import expo.modules.blekit.core.GattServer
import expo.modules.blekit.core.HandlerExecutor
import expo.modules.blekit.core.LogLevel
import expo.modules.blekit.core.NotificationBatch
import expo.modules.blekit.core.PermissionResult
import expo.modules.blekit.core.PermissionStatus
import expo.modules.blekit.core.SessionState
import expo.modules.blekit.core.SubscribeMode
import expo.modules.blekit.core.normalizeAddress
import expo.modules.interfaces.permissions.Permissions
import expo.modules.interfaces.permissions.PermissionsResponse
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.interfaces.taskManager.TaskManagerInterface
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import java.util.UUID

/** A core error as a coded JS exception (plan §4.5). */
class BleKitException(error: CoreError) : CodedException(error.code.value, error.jsMessage, error)

class ExpoBleKitModule : Module() {
  private lateinit var executor: HandlerExecutor
  private lateinit var engine: CentralEngine

  /** The GATT server's own thread (plan §4.7: `blekit-server`) and the server open on it, if any. */
  private lateinit var serverExecutor: HandlerExecutor
  private var openServer: GattServerObject? = null

  /** The advertiser (P4-03), on the server thread too: both are the peripheral role. */
  private lateinit var advertiser: Advertiser

  /** The companion device picker showing (P5-05), if any. Main thread. */
  private var association: CompanionAssociation? = null

  /** One JS object per peripheral id while JS holds it (plan §4.5). Guarded by itself. */
  private val peripherals = HashMap<String, WeakReference<PeripheralObject>>()

  private val permissionManager: Permissions
    get() = appContext.permissions ?: throw Exceptions.PermissionsModuleNotFound()

  companion object {
    /** The companion device picker's activity request code (16 bits, for FragmentActivity). */
    const val ASSOCIATION_REQUEST = 0x0B1E
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoBleKit")

    Events("stateChange", "scanResults", "scanError", "warning", "log")

    OnCreate {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      executor = HandlerExecutor.start()
      val permissionSystem = AndroidPermissionSystem(context)
      engine = CentralEngine(
        AndroidBluetoothAdapterPort(context, executor.handler),
        permissionSystem,
        executor,
        EpochClock(System.currentTimeMillis(), SystemClock.elapsedRealtime()),
        BleLogger::logcat,
        AndroidKeepAlive(context, executor.handler, permissionSystem),
      )
      engine.listener = EngineEvents()
      executor.execute { engine.start() }
      serverExecutor = HandlerExecutor.start("blekit-server")
      advertiser = Advertiser(serverExecutor, AndroidAdvertiser(context, serverExecutor.handler))
      advertiser.onWarning = { warning -> executor.execute { engine.reportWarning(warning) } }
    }

    OnDestroy {
      executor.execute { engine.close() }
      executor.handler.looper.quitSafely()
      serverExecutor.execute {
        closeServer()
        advertiser.close(CoreError(CoreError.Code.DISCONNECTED, "The module was destroyed"))
      }
      serverExecutor.handler.looper.quitSafely()
    }

    OnActivityEntersForeground {
      executor.execute { engine.refresh() }
    }

    OnActivityResult { _, payload ->
      val association = association ?: return@OnActivityResult
      if (payload.requestCode == ASSOCIATION_REQUEST) {
        companion().onActivityResult(payload.resultCode, payload.data, association)
      }
    }

    Function("getState") {
      engine.state.js
    }

    AsyncFunction("getPermissionsAsync") { promise: Promise ->
      executor.execute {
        settle(promise) {
          val policy = engine.permissionPolicy()
          policy.checkDeclared(BleCapability.BASE)
          readPermissions(policy) { promise.resolve(it.toJs()) }
        }
      }
    }

    // Async functions run in call order on Expo's queue, so a stop never overtakes its start.
    AsyncFunction("startScan") { sessionId: Int, options: ScanOptionsRecord, promise: Promise ->
      executor.execute {
        settle(promise) {
          engine.startScan(sessionId, options.toSpec())
          promise.resolve(null)
        }
      }
    }

    AsyncFunction("stopScan") { sessionId: Int ->
      executor.execute { engine.stopScan(sessionId) }
    }

    // Never touches the adapter (plan §5.2). Android ids are addresses, normalized to upper case.
    Function("getPeripheral") { id: String ->
      val key = normalizeAddress(id) ?: id
      synchronized(peripherals) {
        peripherals[key]?.get() ?: PeripheralObject(key, appContext).also { peripherals[key] = WeakReference(it) }
      }
    }

    Class(PeripheralObject::class) {
      // Expo requires a constructor; peripherals only come from getPeripheral() (one object per id).
      Constructor {
        throw CodedException(
          CoreError.Code.INVALID_ARGUMENT.value,
          "Use getPeripheral(id) to get a peripheral",
          null,
        )
      }

      Property("id") { ref: PeripheralObject -> ref.id }

      Property("state") { ref: PeripheralObject -> engine.connectionState(ref.id) }

      Property("services") { ref: PeripheralObject -> engine.services(ref.id) }

      Property("mtu") { ref: PeripheralObject -> engine.mtu(ref.id) }

      Property("name") { ref: PeripheralObject -> engine.name(ref.id) }

      Property("bondState") { ref: PeripheralObject -> engine.bondState(ref.id) }

      // UUIDs arrive normalized and timeouts always set: the TS layer applies the defaults (rule 4).
      AsyncFunction("read") { ref: PeripheralObject, request: AttributeRequestRecord, promise: Promise ->
        attributeOperation(promise) {
          engine.read(
            ref.id,
            request.serviceUuid(),
            request.characteristicUuid(),
            request.timeout(),
            promise.settler(),
            request.operationId,
          )
        }
      }

      AsyncFunction("write") {
          ref: PeripheralObject,
          request: AttributeRequestRecord,
          value: ByteArray,
          promise: Promise,
        ->
        attributeOperation(promise) {
          engine.write(
            ref.id,
            request.serviceUuid(),
            request.characteristicUuid(),
            value,
            request.withResponse,
            request.timeout(),
            promise.settler(),
            request.operationId,
          )
        }
      }

      // Progress goes to the peripheral object as `streamProgress`, keyed by the operation id.
      AsyncFunction("writeStream") {
          ref: PeripheralObject,
          request: AttributeRequestRecord,
          data: ByteArray,
          chunkSize: Int?,
          promise: Promise,
        ->
        attributeOperation(promise) {
          engine.writeStream(
            ref.id,
            request.serviceUuid(),
            request.characteristicUuid(),
            data,
            request.withResponse,
            chunkSize,
            request.timeout(),
            { sent, total ->
              ref.emit("streamProgress", mapOf("operationId" to request.operationId, "sent" to sent, "total" to total))
            },
            promise.settler(),
            request.operationId,
          )
        }
      }

      AsyncFunction("readDescriptor") { ref: PeripheralObject, request: AttributeRequestRecord, promise: Promise ->
        attributeOperation(promise) {
          engine.readDescriptor(
            ref.id,
            request.serviceUuid(),
            request.characteristicUuid(),
            request.descriptorUuid(),
            request.timeout(),
            promise.settler(),
            request.operationId,
          )
        }
      }

      AsyncFunction("writeDescriptor") {
          ref: PeripheralObject,
          request: AttributeRequestRecord,
          value: ByteArray,
          promise: Promise,
        ->
        attributeOperation(promise) {
          engine.writeDescriptor(
            ref.id,
            request.serviceUuid(),
            request.characteristicUuid(),
            request.descriptorUuid(),
            value,
            request.timeout(),
            promise.settler(),
            request.operationId,
          )
        }
      }

      // JS numbers its subscriptions; one CCCD per characteristic is shared by them (plan §5.4).
      // `request.batch` null: one `notification` event per value; else `notificationBatch` (P2-04).
      AsyncFunction("subscribe") {
          ref: PeripheralObject,
          request: AttributeRequestRecord,
          subscriptionId: Int,
          mode: String,
          promise: Promise,
        ->
        attributeOperation(promise) {
          val subscribeMode = SubscribeMode.of(mode)
            ?: throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Invalid subscribe mode: $mode")
          engine.subscribe(
            ref.id,
            request.serviceUuid(),
            request.characteristicUuid(),
            subscribeMode,
            subscriptionId,
            request.timeout(),
            request.batch?.toSpec(),
            promise.settler(),
          )
        }
      }

      AsyncFunction("unsubscribe") { ref: PeripheralObject, subscriptionId: Int, timeoutMs: Double, promise: Promise ->
        attributeOperation(promise) {
          engine.unsubscribe(ref.id, subscriptionId, timeoutMs.toLong(), promise.settler())
        }
      }

      AsyncFunction("requestMtu") {
          ref: PeripheralObject,
          mtu: Int,
          timeoutMs: Double,
          operationId: Int?,
          promise: Promise,
        ->
        attributeOperation(promise) {
          engine.requestMtu(ref.id, mtu, timeoutMs.toLong(), promise.settler(), operationId)
        }
      }

      AsyncFunction("readRssi") { ref: PeripheralObject, timeoutMs: Double, operationId: Int?, promise: Promise ->
        attributeOperation(promise) { engine.readRssi(ref.id, timeoutMs.toLong(), promise.settler(), operationId) }
      }

      // P5-02: connection priority and PHY, queued like GATT operations.
      AsyncFunction("requestConnectionPriority") {
          ref: PeripheralObject,
          priority: String,
          timeoutMs: Double,
          operationId: Int?,
          promise: Promise,
        ->
        attributeOperation(promise) {
          engine.requestConnectionPriority(ref.id, priority, timeoutMs.toLong(), promise.settler(), operationId)
        }
      }

      AsyncFunction("setPreferredPhy") {
          ref: PeripheralObject,
          tx: List<String>,
          rx: List<String>,
          codedOption: String?,
          timeoutMs: Double,
          operationId: Int?,
          promise: Promise,
        ->
        attributeOperation(promise) {
          engine.setPreferredPhy(ref.id, tx, rx, codedOption, timeoutMs.toLong(), promise.settler(), operationId)
        }
      }

      // P5-01: queued like a GATT operation; Android's pairing dialog asks the user.
      AsyncFunction("createBond") { ref: PeripheralObject, timeoutMs: Double, operationId: Int?, promise: Promise ->
        attributeOperation(promise) { engine.createBond(ref.id, timeoutMs.toLong(), promise.settler(), operationId) }
      }

      // P5-03: not a GATT operation; resolves with the channel's own object.
      AsyncFunction("openL2CAPChannel") {
          ref: PeripheralObject,
          psm: Int,
          secure: Boolean,
          timeoutMs: Double,
          operationId: Int?,
          promise: Promise,
        ->
        attributeOperation(promise) {
          engine.openL2capChannel(ref.id, psm, secure, timeoutMs.toLong(), { result ->
            result.fold(
              onSuccess = { promise.resolve(L2capChannelObject(appContext, it)) },
              onFailure = { promise.reject(BleKitException(it as CoreError)) },
            )
          }, operationId)
        }
      }

      // Hidden API, opt-in by calling it (plan §4.4, P2-06): false where Android lacks it.
      AsyncFunction("refreshGattCache") { ref: PeripheralObject, promise: Promise ->
        attributeOperation(promise) { engine.refreshGattCache(ref.id, promise.settler()) }
      }

      // Calls run in order on Expo's queue and then on the BLE thread, so a cancel never overtakes
      // the operation it cancels.
      AsyncFunction("cancelOperation") { ref: PeripheralObject, operationId: Int ->
        executor.execute { engine.cancelOperation(ref.id, operationId) }
      }

      // `services` null discovers everything; the TS layer always passes a timeout (rule 4).
      AsyncFunction("discover") {
          ref: PeripheralObject,
          services: List<String>?,
          timeoutMs: Double,
          operationId: Int?,
          promise: Promise,
        ->
        executor.execute {
          settle(promise) {
            val filter = services?.map(::uuidArgument)
            engine.discover(ref.id, filter, timeoutMs.toLong(), promise.settler(), operationId)
          }
        }
      }

      AsyncFunction("connect") { ref: PeripheralObject, options: ConnectOptionsRecord, promise: Promise ->
        executor.execute {
          settle(promise) {
            engine.connect(ref.id, options.toSpec()) { error ->
              if (error == null) promise.resolve(null) else promise.reject(BleKitException(error))
            }
          }
        }
      }

      AsyncFunction("disconnect") { ref: PeripheralObject, promise: Promise ->
        executor.execute { engine.disconnect(ref.id) { promise.resolve(null) } }
      }
    }

    // Ids only: JS turns them into peripherals with getPeripheral().
    AsyncFunction("getKnownPeripherals") { ids: List<String> ->
      engine.knownPeripherals(ids)
    }

    AsyncFunction("getSystemConnectedPeripherals") { services: List<String>, promise: Promise ->
      executor.execute {
        settle(promise) { promise.resolve(engine.systemConnectedPeripherals(services.map(::uuidArgument))) }
      }
    }

    // Plan §4.16: the level applies to Logcat and to JS; JS gets `log` events only with a handler.
    // The peripheral role's GATT server (P4-01). One at a time; it runs on its own thread.
    AsyncFunction("openGattServer") { services: List<ServerServiceRecord>, promise: Promise ->
      executor.execute {
        settle(promise) {
          engine.checkGattServer()
          val specs = services.map { it.toSpec() }
          val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
          serverExecutor.execute {
            settle(promise) {
              if (openServer != null) {
                throw CoreError(CoreError.Code.INVALID_ARGUMENT, "A GATT server is already open: close it first")
              }
              val ref = GattServerObject(appContext)
              val opener = AndroidGattServerOpener(context, serverExecutor.handler)
              val server = GattServer(specs, serverExecutor, opener::open)
              server.listener = ref.listener { warning -> executor.execute { engine.reportWarning(warning) } }
              ref.server = server
              openServer = ref
              server.open { error ->
                if (error == null) {
                  promise.resolve(ref)
                } else {
                  ref.server = null
                  openServer = null
                  promise.reject(BleKitException(error))
                }
              }
            }
          }
        }
      }
    }

    // P4-03: one advertisement at a time; JS stops it by the id this resolves with.
    AsyncFunction("startAdvertising") {
        data: AdvertisingDataRecord,
        options: AdvertisingOptionsRecord,
        promise: Promise,
      ->
      executor.execute {
        settle(promise) {
          engine.checkAdvertising()
          val spec = advertisingSpec(data, options)
          serverExecutor.execute {
            advertiser.start(spec) { id, error ->
              if (error == null) promise.resolve(id) else promise.reject(BleKitException(error))
            }
          }
        }
      }
    }

    AsyncFunction("stopAdvertising") { id: Int, promise: Promise ->
      serverExecutor.execute {
        advertiser.stop(id)
        promise.resolve(null)
      }
    }

    Class(GattServerObject::class) {
      Constructor {
        throw CodedException(CoreError.Code.INVALID_ARGUMENT.value, "Use BleManager.openGattServer()", null)
      }

      // From JS handlers: the whole value or an ATT error code; the core slices and caches.
      Function("respondToRead") { ref: GattServerObject, requestId: Int, value: ByteArray?, attError: Int? ->
        serverExecutor.execute { ref.server?.respondToRead(requestId, value, attError) }
      }

      Function("respondToWrite") { ref: GattServerObject, requestId: Int, attError: Int? ->
        serverExecutor.execute { ref.server?.respondToWrite(requestId, attError) }
      }

      // P4-02: resolves once every subscribed target took the value (flow control in the core).
      AsyncFunction("notify") {
          ref: GattServerObject,
          characteristic: String,
          value: ByteArray,
          centrals: List<String>?,
          promise: Promise,
        ->
        serverExecutor.execute {
          val server = ref.server
            ?: return@execute promise.reject(
              BleKitException(CoreError(CoreError.Code.DISCONNECTED, "The GATT server is closed")),
            )
          server.notify(UUID.fromString(characteristic), value, centrals) { error ->
            if (error == null) promise.resolve(null) else promise.reject(BleKitException(error))
          }
        }
      }

      AsyncFunction("close") { ref: GattServerObject, promise: Promise ->
        serverExecutor.execute {
          if (openServer === ref) closeServer() else ref.server?.close()
          ref.server = null
          promise.resolve(null)
        }
      }
    }

    // P5-03: L2CAP servers and channels, on the BLE thread; their sockets block on threads of their own.
    AsyncFunction("publishL2CAPChannel") { secure: Boolean, promise: Promise ->
      executor.execute {
        settle(promise) {
          val server = engine.publishL2capChannel(secure)
          val ref = L2capServerObject(appContext, server)
          server.start()
          promise.resolve(ref)
        }
      }
    }

    Class(L2capServerObject::class) {
      Constructor {
        throw CodedException(CoreError.Code.INVALID_ARGUMENT.value, "Use BleManager.publishL2CAPChannel()", null)
      }

      Property("psm") { ref: L2capServerObject -> ref.server.psm }

      Function("takeChannel") { ref: L2capServerObject, channelId: Int -> ref.take(channelId) }

      AsyncFunction("close") { ref: L2capServerObject, promise: Promise ->
        executor.execute {
          ref.close()
          promise.resolve(null)
        }
      }
    }

    Class(L2capChannelObject::class) {
      Constructor {
        throw CodedException(CoreError.Code.INVALID_ARGUMENT.value, "Use openL2CAPChannel()", null)
      }

      Property("psm") { ref: L2capChannelObject -> ref.channel.psm }

      Property("peerId") { ref: L2capChannelObject -> ref.channel.peerId }

      Property("isOpen") { ref: L2capChannelObject -> ref.channel.isOpen }

      AsyncFunction("write") { ref: L2capChannelObject, data: ByteArray, promise: Promise ->
        executor.execute { ref.channel.write(data, promise.settler()) }
      }

      Function("receive") { ref: L2capChannelObject ->
        executor.execute { ref.channel.receive() }
      }

      AsyncFunction("close") { ref: L2capChannelObject, promise: Promise ->
        executor.execute {
          ref.channel.close(null)
          promise.resolve(null)
        }
      }
    }

    // Background scans (P3-04): a TaskManager task whose consumer runs a PendingIntent scan.
    AsyncFunction("registerBackgroundTask") { taskName: String, options: Map<String, Any?>, promise: Promise ->
      executor.execute {
        settle(promise) {
          val events = CompanionDevices.events(options)
          if (CompanionDevices.SCAN_EVENT in events) engine.checkBackgroundScan()
          if (CompanionDevices.PRESENCE_EVENT in events) companion().checkPresence(CompanionPresenceService::class.java)
          val taskManager = taskManager()
          try {
            taskManager.registerTask(taskName, BackgroundScanTaskConsumer::class.java, options)
          } catch (error: Exception) {
            throw CoreError(CoreError.Code.INTERNAL, "TaskManager couldn't register $taskName: ${error.message}")
          }
          promise.resolve(null)
        }
      }
    }

    AsyncFunction("unregisterBackgroundTask") { taskName: String, promise: Promise ->
      executor.execute {
        settle(promise) {
          val taskManager = taskManager()
          // Unknown names and other libraries' tasks are left alone: unregistering is idempotent.
          if (taskManager.taskHasConsumerOfClass(taskName, BackgroundScanTaskConsumer::class.java)) {
            try {
              taskManager.unregisterTask(taskName, BackgroundScanTaskConsumer::class.java)
            } catch (error: Exception) {
              throw CoreError(CoreError.Code.INTERNAL, "TaskManager couldn't unregister $taskName: ${error.message}")
            }
          }
          promise.resolve(null)
        }
      }
    }

    // CompanionDeviceManager (P5-05): the system picker; presence goes to tasks (above).
    AsyncFunction("associateCompanionDevice") {
        services: List<String>,
        namePattern: String?,
        singleDevice: Boolean,
        promise: Promise,
      ->
      settle(promise) {
        val spec = CompanionDevices.spec(services, namePattern, singleDevice)
        val companion = companion()
        companion.checkAssociation()
        if (association != null) {
          throw CoreError(CoreError.Code.INVALID_ARGUMENT, "The companion device picker is already showing")
        }
        val activity = appContext.currentActivity
          ?: throw CoreError(
            CoreError.Code.INVALID_ARGUMENT,
            "The companion device picker needs the app in the foreground",
          )
        val pending = CompanionAssociation { result ->
          association = null
          result.onSuccess { id ->
            if (id != null) observeNewAssociation(companion, id)
            promise.resolve(id)
          }
          result.onFailure { error -> promise.reject(BleKitException(error as CoreError)) }
        }
        association = pending
        try {
          companion.associate(activity, spec, ASSOCIATION_REQUEST, pending)
        } catch (error: CoreError) {
          pending.fail(error)
        }
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("isLocationServicesEnabled") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      AndroidPermissionSystem(context).isLocationEnabled()
    }

    Function("setForegroundServiceNotification") { notification: ForegroundServiceNotificationRecord ->
      executor.execute { engine.setKeepAliveNotification(notification.toNotification()) }
    }

    Function("setLogLevel") { level: String ->
      engine.logger.level = LogLevel.of(level)
        ?: throw BleKitException(CoreError(CoreError.Code.INVALID_ARGUMENT, "Invalid log level: $level"))
    }

    Function("setLogForwarding") { enabled: Boolean ->
      engine.logger.forward = if (!enabled) {
        null
      } else {
        { entry ->
          sendEvent(
            "log",
            mapOf(
              "level" to entry.level.js,
              "message" to entry.message,
              "timestamp" to entry.timestamp,
              "peripheralId" to entry.peripheralId,
              "opId" to entry.opId?.toDouble(),
            ),
          )
        }
      }
    }

    AsyncFunction("getDiagnosticsAsync") { promise: Promise ->
      executor.execute { promise.resolve(engine.diagnostics()) }
    }

    AsyncFunction("requestPermissionsAsync") { request: PermissionRequestRecord?, promise: Promise ->
      val capabilities = (request ?: PermissionRequestRecord()).capabilities()
      executor.execute {
        settle(promise) {
          val policy = engine.permissionPolicy()
          policy.checkDeclared(capabilities)
          requestStages(policy.requestStages(capabilities), promise) {
            engine.refresh()
            readPermissions(policy) { promise.resolve(it.toJs()) }
          }
        }
      }
    }
  }

  private inner class EngineEvents : CentralEngine.Listener {
    override fun onStateChange(state: BleState) {
      sendEvent("stateChange", mapOf("state" to state.js))
      // Android drops the server's services with the adapter: the server closes (plan §5.5).
      if (state != BleState.POWERED_ON) {
        serverExecutor.execute {
          closeServer()
          advertiser.close(CoreError(CoreError.Code.BLUETOOTH_POWERED_OFF, "Bluetooth went off"))
        }
      }
    }

    override fun onScanResults(sessionId: Int, results: List<Map<String, Any?>>) {
      sendEvent("scanResults", mapOf("sessionId" to sessionId, "results" to results))
    }

    override fun onScanError(sessionId: Int, error: CoreError) {
      sendEvent("scanError", mapOf("sessionId" to sessionId, "code" to error.code.value, "message" to error.jsMessage))
    }

    override fun onWarning(warning: CoreError) {
      sendEvent("warning", mapOf("code" to warning.code.value, "message" to warning.jsMessage))
    }

    override fun onNotification(
      peripheralId: String,
      service: UUID,
      characteristic: UUID,
      value: ByteArray,
      timestamp: Double,
    ) {
      val peripheral = synchronized(peripherals) { peripherals[peripheralId]?.get() } ?: return
      peripheral.emit(
        "notification",
        mapOf(
          "service" to service.toString(),
          "characteristic" to characteristic.toString(),
          "value" to value,
          "timestamp" to timestamp,
        ),
      )
    }

    override fun onSubscriptionEnded(peripheralId: String, subscriptionId: Int, error: CoreError) {
      val peripheral = synchronized(peripherals) { peripherals[peripheralId]?.get() } ?: return
      peripheral.emit(
        "subscriptionEnded",
        mapOf("subscriptionId" to subscriptionId, "code" to error.code.value, "message" to error.jsMessage),
      )
    }

    override fun onServicesChanged(peripheralId: String) {
      val peripheral = synchronized(peripherals) { peripherals[peripheralId]?.get() } ?: return
      peripheral.emit("servicesChanged", emptyMap<String, Any>())
    }

    // One buffer for all values, cut by `lengths` in JS: fewer objects across the bridge.
    override fun onNotificationBatch(peripheralId: String, subscriptionId: Int, batch: NotificationBatch) {
      val peripheral = synchronized(peripherals) { peripherals[peripheralId]?.get() } ?: return
      val bytes = ByteArray(batch.values.sumOf { it.size })
      var offset = 0
      batch.values.forEach { value ->
        value.copyInto(bytes, offset)
        offset += value.size
      }
      peripheral.emit(
        "notificationBatch",
        mapOf(
          "subscriptionId" to subscriptionId,
          "bytes" to bytes,
          "lengths" to batch.values.map { it.size },
          "timestamps" to batch.timestamps,
          "dropped" to batch.dropped,
        ),
      )
    }

    override fun onMtuChange(peripheralId: String, mtu: Int) {
      val peripheral = synchronized(peripherals) { peripherals[peripheralId]?.get() } ?: return
      peripheral.emit("mtuChange", mapOf("mtu" to mtu))
    }

    override fun onConnectionStateChange(peripheralId: String, state: SessionState, error: CoreError?) {
      val peripheral = synchronized(peripherals) { peripherals[peripheralId]?.get() } ?: return
      peripheral.emit(
        "connectionStateChange",
        mapOf("state" to state.js, "code" to error?.code?.value, "message" to error?.jsMessage),
      )
    }
  }

  private fun attributeOperation(promise: Promise, block: () -> Unit) {
    executor.execute { settle(promise, block) }
  }

  /** Closes the open GATT server. On the server thread. */
  private fun closeServer() {
    openServer?.server?.close()
    openServer?.server = null
    openServer = null
  }

  /** expo-task-manager's native side, which the app installs for background tasks. */
  private fun companion() = AndroidCompanion(appContext.reactContext ?: throw Exceptions.ReactContextLost())

  /** A device associated while a task wants presence is observed at once (the task observed the others). */
  private fun observeNewAssociation(companion: AndroidCompanion, id: String) {
    val context = appContext.reactContext ?: return
    if (!PresenceTasks.any(context)) return
    companion.associations().find { normalizeAddress(it.address) == id }?.let { companion.observe(it, observe = true) }
  }

  private fun taskManager(): TaskManagerInterface = appContext.legacyModule<TaskManagerInterface>()
    ?: throw CoreError(
      CoreError.Code.MISCONFIGURED,
      "Background tasks need expo-task-manager: run npx expo install expo-task-manager, then rebuild the app",
    )

  /** Runs [block] on the BLE thread, rejecting [promise] with whatever it throws. */
  private fun settle(promise: Promise, block: () -> Unit) {
    try {
      block()
    } catch (error: CoreError) {
      promise.reject(BleKitException(error))
    } catch (error: CodedException) {
      promise.reject(error)
    }
  }

  /** Asks stage by stage; a stage is only asked once the previous one is fully granted. */
  private fun requestStages(stages: List<List<String>>, promise: Promise, done: () -> Unit) {
    val stage = stages.firstOrNull() ?: return done()
    if (stage.all(engine.permissionSystem::isGranted)) {
      return requestStages(stages.drop(1), promise, done)
    }
    permissionManager.askForPermissions(
      { results ->
        executor.execute {
          settle(promise) {
            val granted = results.values.all { it.status == PermissionsStatus.GRANTED }
            if (granted) requestStages(stages.drop(1), promise, done) else done()
          }
        }
      },
      *stage.toTypedArray(),
    )
  }

  private fun readPermissions(policy: BlePermissionPolicy, completion: (BlePermissions) -> Unit) {
    val names = policy.declaredRuntimePermissions()
    if (names.isEmpty()) {
      completion(policy.permissions(emptyMap()))
      return
    }
    permissionManager.getPermissions(
      { results -> completion(policy.permissions(results.mapValues { (_, response) -> response.toCore() })) },
      *names.toTypedArray(),
    )
  }
}

private fun uuidArgument(value: String): UUID = runCatching { UUID.fromString(value) }.getOrElse {
  throw CoreError(CoreError.Code.INVALID_ARGUMENT, "Invalid UUID: $value")
}

private fun AttributeRequestRecord.serviceUuid() = uuidArgument(service)

private fun AttributeRequestRecord.characteristicUuid() = uuidArgument(characteristic)

private fun AttributeRequestRecord.descriptorUuid() =
  uuidArgument(descriptor ?: throw CoreError(CoreError.Code.INVALID_ARGUMENT, "No descriptor given"))

private fun AttributeRequestRecord.timeout() = timeoutMs.toLong()

/** Settles the promise with a core result: the value (Unit as undefined), or the coded error. */
private fun <T> Promise.settler(): (Result<T>) -> Unit = { result ->
  result.fold(
    onSuccess = { value -> resolve(value.takeUnless { it is Unit }) },
    onFailure = { reject(BleKitException(it as CoreError)) },
  )
}

private fun PermissionsResponse.toCore() = PermissionResult(
  status = when (status) {
    PermissionsStatus.GRANTED -> PermissionStatus.GRANTED
    PermissionsStatus.DENIED -> PermissionStatus.DENIED
    else -> PermissionStatus.UNDETERMINED
  },
  canAskAgain = canAskAgain,
)
