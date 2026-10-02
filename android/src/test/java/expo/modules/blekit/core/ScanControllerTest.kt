package expo.modules.blekit.core

import android.bluetooth.le.ScanCallback
import expo.modules.blekit.core.fakes.FakeBluetoothAdapter
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import expo.modules.blekit.core.fakes.scanRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

/** P1-04: session multiplexing, the scan-start limit, batching and long scans on Android. */
class ScanControllerTest {
  private val heartRate = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb")
  private val battery = UUID.fromString("0000180f-0000-1000-8000-00805f9b34fb")

  private val adapter = FakeBluetoothAdapter()
  private val scanner = adapter.scanner
  private val executor = ManualExecutor()

  /** Session id → delivered batches of result ids. */
  private val delivered = mutableMapOf<Int, MutableList<List<String>>>()
  private val ended = mutableMapOf<Int, CoreError>()
  private val warnings = mutableListOf<CoreError>()

  private val controller = ScanController(
    adapter,
    executor,
    EpochClock(wallAtStartMs = 1_000_000, monotonicAtStartMs = 0),
    object : ScanController.Events {
      override fun onScanResults(sessionId: Int, results: List<Map<String, Any?>>) {
        delivered.getOrPut(sessionId) { mutableListOf() }.add(results.map { it["id"] as String })
      }

      override fun onScanError(sessionId: Int, error: CoreError) {
        ended[sessionId] = error
      }

      override fun onWarning(warning: CoreError) {
        warnings.add(warning)
      }
    },
  )

  private fun ids(sessionId: Int) = delivered[sessionId].orEmpty().flatten()

  @Test
  fun `two sessions share one platform scan and each sees only its matches`() {
    controller.start(1, ScanSpec(services = listOf(heartRate)))
    controller.start(2, ScanSpec(namePrefix = "BleKit"))
    executor.advanceBy(ScanController.RESTART_DEBOUNCE_MS)
    assertEquals(1, scanner.active.size)
    // A name-prefix session can't be filtered in hardware, so the platform scan is unfiltered.
    assertEquals(emptyList<ScanFilterSpec>(), scanner.active[0].filters)

    scanner.emit(scanRecord("A", name = "Pulse", services = listOf(heartRate)), scanRecord("B", name = "BleKit-Test"))
    assertEquals(listOf("A"), ids(1))
    assertEquals(listOf("B"), ids(2))

    controller.stop(1)
    executor.advanceBy(ScanController.RESTART_DEBOUNCE_MS)
    assertEquals("same union, no restart", 2, scanner.startCount)
    scanner.emit(scanRecord("C", name = "BleKit-2"))
    assertEquals(listOf("B", "C"), ids(2))
    assertEquals(listOf("A"), ids(1))
  }

  @Test
  fun `the platform scan follows the union of filters, with restarts debounced`() {
    controller.start(1, ScanSpec(services = listOf(heartRate)))
    assertEquals(1, scanner.startCount)
    controller.start(2, ScanSpec(services = listOf(battery)))
    controller.stop(2)
    controller.start(3, ScanSpec(services = listOf(battery)))
    executor.advanceBy(ScanController.RESTART_DEBOUNCE_MS)
    assertEquals("three changes, one restart", 2, scanner.startCount)
    assertEquals(setOf(heartRate, battery), scanner.active.single().filters.map { it.serviceUuid }.toSet())

    controller.stop(1)
    controller.stop(3)
    executor.advanceBy(ScanController.RESTART_DEBOUNCE_MS)
    assertTrue(scanner.active.isEmpty())
  }

  @Test
  fun `starts past Android's limit are delayed with a SCAN_THROTTLED warning`() {
    // P1-04 accept: 10 start/stop cycles within 20 s.
    for (sessionId in 1..10) {
      controller.start(sessionId, ScanSpec())
      executor.advanceBy(1_000)
      controller.stop(sessionId)
      executor.advanceBy(1_000)
    }
    assertEquals(ScanController.MAX_STARTS, scanner.startCount)
    assertEquals(5, warnings.size)
    assertTrue(warnings.all { it.code == CoreError.Code.SCAN_THROTTLED && it.retryable })

    // A session started now runs as soon as the window allows: 30 s after the first start, plus margin.
    controller.start(11, ScanSpec())
    executor.advanceBy(30_000 + ScanController.START_MARGIN_MS - executor.nowMs() - 1)
    assertEquals(ScanController.MAX_STARTS, scanner.startCount)
    executor.advanceBy(1)
    assertEquals(ScanController.MAX_STARTS + 1, scanner.startCount)
    scanner.emit(scanRecord("A"))
    assertEquals(listOf("A"), ids(11))
  }

  @Test
  fun `allowDuplicates false reports each device once per session`() {
    controller.start(1, ScanSpec())
    controller.start(2, ScanSpec(allowDuplicates = true))
    scanner.emit(scanRecord("A"), scanRecord("A"))
    scanner.emit(scanRecord("A"), scanRecord("B"))
    assertEquals(listOf("A", "B"), ids(1))
    assertEquals(listOf("A", "A", "A", "B"), ids(2))
  }

  @Test
  fun `reportIntervalMs batches and keeps the latest result per device`() {
    val rssi = mutableListOf<Int>()
    val batching = ScanController(
      adapter,
      executor,
      EpochClock(0, 0),
      object : ScanController.Events {
        override fun onScanResults(sessionId: Int, results: List<Map<String, Any?>>) {
          delivered.getOrPut(sessionId) { mutableListOf() }.add(results.map { it["id"] as String })
          rssi.addAll(results.map { it["rssi"] as Int })
        }

        override fun onScanError(sessionId: Int, error: CoreError) = Unit

        override fun onWarning(warning: CoreError) = Unit
      },
    )
    batching.start(1, ScanSpec(allowDuplicates = true, reportIntervalMs = 500))
    scanner.emit(scanRecord("A", rssi = -70))
    executor.advanceBy(200)
    scanner.emit(scanRecord("B"), scanRecord("A", rssi = -50))
    assertEquals(emptyList<String>(), ids(1))
    executor.advanceBy(300)
    assertEquals(listOf(listOf("A", "B")), delivered[1])
    assertEquals(listOf(-50, -60), rssi)
    executor.advanceBy(1_000)
    assertEquals("no empty batches", 1, delivered[1]!!.size)
  }

  @Test
  fun `stopAll and platform failures end every session`() {
    controller.start(1, ScanSpec())
    controller.start(2, ScanSpec(services = listOf(heartRate)))
    controller.stopAll(CoreError(CoreError.Code.BLUETOOTH_POWERED_OFF, "Bluetooth is off"))
    assertEquals(setOf(1, 2), ended.keys)
    assertEquals(CoreError.Code.BLUETOOTH_POWERED_OFF, ended[1]!!.code)
    assertTrue(scanner.active.isEmpty())
    assertEquals(emptySet<Int>(), controller.activeSessionIds)

    controller.start(3, ScanSpec())
    scanner.active.single().callback.onScanFailed(ScanCallback.SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES)
    assertEquals(CoreError.Code.SCAN_FAILED, ended[3]!!.code)
    assertTrue(ended[3]!!.retryable)
    controller.start(4, ScanSpec())
    assertEquals("a failed scan isn't stopped again, and a new one starts", 3, scanner.startCount)
  }

  @Test
  fun `long scans restart before Android downgrades them`() {
    controller.start(1, ScanSpec())
    executor.advanceBy(ScanController.LONG_SCAN_RESTART_MS - 1)
    assertEquals(1, scanner.startCount)
    executor.advanceBy(1)
    assertEquals(2, scanner.startCount)
    assertEquals(1, scanner.active.size)
  }

  @Test
  fun `remembers the scanned device handle and stamps epoch times`() {
    val device = FakeRemoteDevice("C0:FF:EE:00:00:01")
    val stamped = mutableListOf<Any?>()
    val clocked = ScanController(
      adapter,
      executor,
      EpochClock(wallAtStartMs = 1_000_000, monotonicAtStartMs = 0),
      object : ScanController.Events {
        override fun onScanResults(sessionId: Int, results: List<Map<String, Any?>>) {
          stamped.addAll(results.map { it["timestamp"] })
        }

        override fun onScanError(sessionId: Int, error: CoreError) = Unit

        override fun onWarning(warning: CoreError) = Unit
      },
    )
    clocked.start(1, ScanSpec())
    scanner.emit(scanRecord(device.address, timestampNanos = 5_000_000, device = device))
    assertSame(device, clocked.seenDevice(device.address))
    assertEquals(listOf(1_000_005.0), stamped)
  }
}
