package expo.modules.blekit.core

import android.app.PendingIntent
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanResult
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock

/**
 * PendingIntent scans (API 26+, plan §4.4): the Bluetooth stack runs them without the app process
 * and sends [target] with the results, which wakes the app. Called from the task consumer, on
 * whatever thread TaskManager uses; it holds no state.
 */
class AndroidBackgroundScanner(private val context: Context) {
  private val adapter get() = context.getSystemService(BluetoothManager::class.java)?.adapter

  /** Starts the scan for [spec]; returns null, or Android's error code (`ScanCallback.SCAN_FAILED_*`). */
  fun start(spec: ScanSpec, target: PendingIntent): Int? {
    val adapter = adapter ?: return SCAN_FAILED_INTERNAL_ERROR
    val scanner = adapter.bluetoothLeScanner ?: return SCAN_FAILED_INTERNAL_ERROR
    val settings = BackgroundScanning.settings(
      adapter.isOffloadedFilteringSupported,
      adapter.isOffloadedScanBatchingSupported,
    )
    val status = scanner.startScan(spec.platformFilters().map { it.toPlatform() }, settings.toPlatform(), target)
    return status.takeIf { it != 0 }
  }

  fun stop(target: PendingIntent) {
    try {
      adapter?.bluetoothLeScanner?.stopScan(target)
    } catch (_: IllegalStateException) {
      // The adapter is off, which ends the scan anyway.
    }
  }

  /** The results in a scan intent that match [spec] (Android can't filter by name prefix), as JS `ScanResult`s. */
  fun results(intent: Intent, spec: ScanSpec): List<Map<String, Any?>> {
    val results =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableArrayListExtra(BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT, ScanResult::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableArrayListExtra<ScanResult>(BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT)
      }
    val clock = EpochClock(System.currentTimeMillis(), SystemClock.elapsedRealtime())
    val handler = Handler(Looper.getMainLooper())
    return results.orEmpty().map { it.toRecord(context, handler) }.filter(spec::matches).map { it.toJs(clock) }
  }

  /** The error a scan intent carries instead of results, or null. */
  fun error(intent: Intent): Int? = intent.getIntExtra(BluetoothLeScanner.EXTRA_ERROR_CODE, 0).takeIf { it != 0 }
}
