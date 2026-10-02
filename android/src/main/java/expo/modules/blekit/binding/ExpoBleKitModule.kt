package expo.modules.blekit.binding

import android.os.SystemClock
import expo.modules.blekit.core.AndroidBluetoothAdapterPort
import expo.modules.blekit.core.AndroidPermissionSystem
import expo.modules.blekit.core.BleCapability
import expo.modules.blekit.core.BlePermissionPolicy
import expo.modules.blekit.core.BlePermissions
import expo.modules.blekit.core.BleState
import expo.modules.blekit.core.CentralEngine
import expo.modules.blekit.core.CoreError
import expo.modules.blekit.core.EpochClock
import expo.modules.blekit.core.HandlerExecutor
import expo.modules.blekit.core.PermissionResult
import expo.modules.blekit.core.PermissionStatus
import expo.modules.interfaces.permissions.Permissions
import expo.modules.interfaces.permissions.PermissionsResponse
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** A core error as a coded JS exception (plan §4.5). */
class BleKitException(error: CoreError) : CodedException(error.code.value, error.jsMessage, error)

class ExpoBleKitModule : Module() {
  private lateinit var executor: HandlerExecutor
  private lateinit var engine: CentralEngine

  private val permissionManager: Permissions
    get() = appContext.permissions ?: throw Exceptions.PermissionsModuleNotFound()

  override fun definition() = ModuleDefinition {
    Name("ExpoBleKit")

    Events("stateChange", "scanResults", "scanError", "warning")

    OnCreate {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      executor = HandlerExecutor.start()
      engine = CentralEngine(
        AndroidBluetoothAdapterPort(context, executor.handler),
        AndroidPermissionSystem(context),
        executor,
        EpochClock(System.currentTimeMillis(), SystemClock.elapsedRealtime()),
      )
      engine.listener = EngineEvents()
      executor.execute { engine.start() }
    }

    OnDestroy {
      executor.execute { engine.close() }
      executor.handler.looper.quitSafely()
    }

    OnActivityEntersForeground {
      executor.execute { engine.refresh() }
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
  }

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

private fun PermissionsResponse.toCore() = PermissionResult(
  status = when (status) {
    PermissionsStatus.GRANTED -> PermissionStatus.GRANTED
    PermissionsStatus.DENIED -> PermissionStatus.DENIED
    else -> PermissionStatus.UNDETERMINED
  },
  canAskAgain = canAskAgain,
)
