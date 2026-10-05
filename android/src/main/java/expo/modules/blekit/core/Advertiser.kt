package expo.modules.blekit.core

/**
 * The peripheral role's advertiser (plan §5.5, P4-03): one advertisement at a time, known to JS by
 * an id, so a stale `stop` can't stop a newer advertisement. A start that Android doesn't confirm
 * within [START_TIMEOUT_MS] fails (rule 4). What Android can't advertise as asked becomes a
 * NOT_SUPPORTED warning.
 *
 * Threading (plan §4.7): on the server thread ([executor]), where the port delivers its events.
 */
class Advertiser(private val executor: SerialExecutor, private val port: AdvertiserPort) {
  /** Warnings for the engine's log and the JS `warning` event. */
  var onWarning: ((CoreError) -> Unit)? = null

  private var nextId = 1
  private var starting: Starting? = null

  /** The id of the advertisement running now. */
  var running: Int? = null
    private set

  private class Starting(val id: Int, val completion: (Int?, CoreError?) -> Unit, val timeout: Cancellable)

  /** Starts advertising; [completion] gets the advertisement's id, or why it didn't start. */
  fun start(spec: AdvertisingSpec, completion: (Int?, CoreError?) -> Unit) {
    if (starting != null || running != null) {
      return completion(
        null,
        CoreError(CoreError.Code.ADVERTISING_FAILED, "Already advertising: stop the current advertisement first"),
      )
    }
    val capabilities = port.capabilities()
      ?: return completion(null, CoreError(CoreError.Code.NOT_SUPPORTED, "This phone can't advertise"))
    if (spec.extended && !capabilities.extended) {
      return completion(null, CoreError(CoreError.Code.NOT_SUPPORTED, "This phone can't do extended advertising"))
    }
    val layout = try {
      AdvertisingLayouts.plan(
        spec,
        capabilities.deviceName?.toByteArray(Charsets.UTF_8)?.size,
        capabilities.maxExtendedLength,
      )
    } catch (error: CoreError) {
      return completion(null, error)
    }
    warnAbout(spec, layout, capabilities.deviceName)

    val id = nextId++
    val timeout = executor.executeDelayed(START_TIMEOUT_MS) {
      if (starting?.id != id) return@executeDelayed
      starting = null
      stopPort()
      completion(
        null,
        CoreError(CoreError.Code.OPERATION_TIMEOUT, "Advertising didn't start within ${START_TIMEOUT_MS / 1000} s"),
      )
    }
    starting = Starting(id, completion, timeout)
    try {
      port.start(layout, spec, Events(id))
    } catch (error: IllegalArgumentException) {
      fail(id, CoreError(CoreError.Code.ADVERTISING_FAILED, "Android refused the advertisement: ${error.message}"))
    } catch (error: IllegalStateException) {
      fail(id, CoreError(CoreError.Code.BLUETOOTH_POWERED_OFF, "Bluetooth is off: ${error.message}"))
    } catch (error: SecurityException) {
      fail(id, CoreError(CoreError.Code.PERMISSION_DENIED, "Advertising needs BLUETOOTH_ADVERTISE: ${error.message}"))
    }
  }

  /** Stops advertisement [id]; nothing when another one (or none) runs. */
  fun stop(id: Int) {
    if (running != id) return
    running = null
    stopPort()
  }

  /** Bluetooth went off or the module closes: the advertisement ends, a start fails. */
  fun close(reason: CoreError) {
    starting?.let { fail(it.id, reason) }
    if (running != null) {
      running = null
      stopPort()
    }
  }

  private fun fail(id: Int, error: CoreError) {
    val pending = starting?.takeIf { it.id == id } ?: return
    starting = null
    pending.timeout.cancel()
    stopPort()
    pending.completion(null, error)
  }

  private fun stopPort() {
    try {
      port.stop()
    } catch (_: RuntimeException) {
      // Bluetooth already off, or never registered: nothing left to stop.
    }
  }

  private fun warnAbout(spec: AdvertisingSpec, layout: AdvertisingLayout, deviceName: String?) {
    val name = spec.localName
    if (name != null && name != deviceName) {
      val advertised = deviceName?.let { "its Bluetooth name '$it'" } ?: "its Bluetooth name"
      onWarning?.invoke(
        CoreError(CoreError.Code.NOT_SUPPORTED, "Android can't advertise the name '$name': it advertises $advertised"),
      )
    }
    for (warning in layout.warnings) {
      onWarning?.invoke(CoreError(CoreError.Code.NOT_SUPPORTED, "Not advertised: $warning"))
    }
  }

  private inner class Events(private val id: Int) : AdvertiserEvents {
    override fun onStarted(status: Int) {
      val pending = starting?.takeIf { it.id == id } ?: return
      if (status != AdvertisingLayouts.ADVERTISE_SUCCESS) return fail(id, AdvertisingLayouts.startError(status))
      starting = null
      pending.timeout.cancel()
      running = id
      pending.completion(id, null)
    }

    override fun onDisabled() {
      if (running == id) {
        running = null
        stopPort()
      }
    }
  }

  companion object {
    const val START_TIMEOUT_MS = 10_000L
  }
}
