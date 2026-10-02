package expo.modules.blekit.core

/**
 * Runs one platform scan for all JS scan sessions (plan §5.3): the union of their filters and the
 * most demanding settings, with results filtered, de-duplicated and batched per session. Delays
 * starts that would pass Android's scan-start limit, and restarts long scans (plan §4.4).
 *
 * Threading (plan §4.7): everything on the BLE thread.
 */
class ScanController(
  private val adapter: BluetoothAdapterPort,
  private val executor: SerialExecutor,
  private val clock: EpochClock,
  private val events: Events,
) {
  interface Events {
    fun onScanResults(sessionId: Int, results: List<Map<String, Any?>>)

    /** The session has ended. */
    fun onScanError(sessionId: Int, error: CoreError)

    fun onWarning(warning: CoreError)
  }

  private class Session(val spec: ScanSpec) {
    val seen = mutableSetOf<String>()

    /** The current batch window, latest result per device. */
    val batch = LinkedHashMap<String, ScanRecordData>()
    var flush: Cancellable? = null
  }

  private val sessions = LinkedHashMap<Int, Session>()
  private var running: PlatformScan? = null
  private var pendingApply: Cancellable? = null
  private var longScanRestart: Cancellable? = null

  /** Monotonic times of the latest platform scan starts, oldest first. */
  private val recentStarts = ArrayDeque<Long>()

  /** Devices seen by scans in this process, most recent last (plan §4.12). */
  private val seenDevices = object : LinkedHashMap<String, RemoteDevicePort>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, RemoteDevicePort>) = size > MAX_SEEN_DEVICES
  }

  private val callback =
    object : LeScanCallback {
      override fun onScanResults(results: List<ScanRecordData>) = deliver(results)

      override fun onScanFailed(errorCode: Int) {
        // The platform scan is gone; the sessions end with the mapped error.
        running = null
        stopAll(AndroidErrorMapping.scanError(errorCode))
      }
    }

  val activeSessionIds: Set<Int> get() = sessions.keys

  /** The scanned handle for [address], if a scan in this process saw it. */
  fun seenDevice(address: String): RemoteDevicePort? = seenDevices[address]

  fun start(sessionId: Int, spec: ScanSpec) {
    check(sessionId !in sessions) { "Scan session $sessionId is already running" }
    sessions[sessionId] = Session(spec)
    reconcile()
  }

  fun stop(sessionId: Int) {
    val session = sessions.remove(sessionId) ?: return
    session.flush?.cancel()
    reconcile()
  }

  /** Ends every session with [error], for example when the adapter turns off. */
  fun stopAll(error: CoreError) {
    val ended = sessions.keys.toList()
    sessions.values.forEach { it.flush?.cancel() }
    sessions.clear()
    pendingApply?.cancel()
    pendingApply = null
    stopPlatform()
    ended.forEach { events.onScanError(it, error) }
  }

  private fun desired(): PlatformScan? = if (sessions.isEmpty()) {
    null
  } else {
    PlatformScan.union(
      sessions.values.map {
        it.spec
      },
    )
  }

  private fun reconcile() {
    val desired = desired()
    when {
      desired == running -> {
        pendingApply?.cancel()
        pendingApply = null
      }

      // From idle, start at once.
      running == null -> apply()

      // A restart counts against the start limit, so changes that come close together (a session
      // stopped and another started) are applied as one.
      pendingApply == null -> pendingApply = executor.executeDelayed(RESTART_DEBOUNCE_MS) { apply() }
    }
  }

  private fun apply(force: Boolean = false) {
    pendingApply?.cancel()
    pendingApply = null
    val desired = desired()
    if (desired == null) {
      stopPlatform()
      return
    }
    if (desired == running && !force) {
      return
    }
    val now = executor.nowMs()
    val allowedAt = nextStartAllowedAt()
    if (allowedAt > now) {
      // Android would accept the start but silently deliver nothing, so wait and say so.
      val delay = allowedAt - now
      events.onWarning(
        CoreError(
          CoreError.Code.SCAN_THROTTLED,
          "Android allows $MAX_STARTS scan starts per ${START_WINDOW_MS / 1000} s, so the scan starts in $delay ms",
        ),
      )
      pendingApply = executor.executeDelayed(delay) { apply(force) }
      return
    }
    startPlatform(desired, now)
  }

  private fun nextStartAllowedAt(): Long =
    if (recentStarts.size < MAX_STARTS) 0 else recentStarts.first() + START_WINDOW_MS + START_MARGIN_MS

  private fun startPlatform(scan: PlatformScan, now: Long) {
    stopPlatform()
    val scanner = adapter.leScanner
    if (scanner == null) {
      stopAll(CoreError(CoreError.Code.BLUETOOTH_POWERED_OFF, "Bluetooth is off"))
      return
    }
    recentStarts.addLast(now)
    while (recentStarts.size > MAX_STARTS) {
      recentStarts.removeFirst()
    }
    running = scan
    scanner.startScan(scan.filters, scan.settings, callback)
    // Android downgrades scans running for about 30 minutes to opportunistic (plan §4.4).
    longScanRestart = executor.executeDelayed(LONG_SCAN_RESTART_MS) {
      longScanRestart = null
      apply(force = true)
    }
  }

  private fun stopPlatform() {
    longScanRestart?.cancel()
    longScanRestart = null
    if (running == null) {
      return
    }
    running = null
    adapter.leScanner?.stopScan(callback)
  }

  private fun deliver(records: List<ScanRecordData>) {
    for (record in records) {
      record.device?.let { seenDevices[record.address] = it }
    }
    for ((sessionId, session) in sessions) {
      val spec = session.spec
      val matches = records.filter { spec.matches(it) && (spec.allowDuplicates || session.seen.add(it.address)) }
      if (matches.isEmpty()) {
        continue
      }
      if (spec.reportIntervalMs <= 0) {
        events.onScanResults(sessionId, matches.map { it.toJs(clock) })
        continue
      }
      matches.forEach { session.batch[it.address] = it }
      if (session.flush == null) {
        session.flush = executor.executeDelayed(spec.reportIntervalMs) { flush(sessionId) }
      }
    }
  }

  private fun flush(sessionId: Int) {
    val session = sessions[sessionId] ?: return
    session.flush = null
    if (session.batch.isNotEmpty()) {
      val results = session.batch.values.map { it.toJs(clock) }
      session.batch.clear()
      events.onScanResults(sessionId, results)
    }
  }

  companion object {
    /** Android's limit: a sixth start within 30 s of the fifth-latest is "scanning too frequently". */
    const val MAX_STARTS = 5
    const val START_WINDOW_MS = 30_000L

    /** Slack for the system's own clock reading. */
    const val START_MARGIN_MS = 1_000L
    const val RESTART_DEBOUNCE_MS = 300L
    const val LONG_SCAN_RESTART_MS = 25 * 60 * 1000L
    const val MAX_SEEN_DEVICES = 1_000
  }
}
