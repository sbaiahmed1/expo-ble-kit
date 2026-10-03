package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

/** P2-07: the core's log: levels, forwarding, and one debug line per GATT operation. */
class LoggingTest {
  private val lines = mutableListOf<String>()
  private val entries = mutableListOf<LogEntry>()

  @Test
  fun `only lines at or above the level are written, and built`() {
    val logger = BleLogger(clock = { 42.0 }, platform = { level, line -> lines += "${level.js} $line" })
    var built = 0
    logger.log(LogLevel.DEBUG) { "debug ${++built}" }
    logger.log(LogLevel.WARN, "AA:BB", 7) { "warn ${++built}" }
    assertEquals("the default level is warn", listOf("warn AA:BB op #7: warn 1"), lines)
    assertEquals("messages below the level are never built", 1, built)

    logger.level = LogLevel.NONE
    logger.log(LogLevel.ERROR) { "error" }
    assertEquals(1, lines.size)

    logger.level = LogLevel.VERBOSE
    logger.forward = { entries += it }
    logger.log(LogLevel.VERBOSE, "AA:BB", 3) { "values" }
    val entry = entries.single()
    assertEquals(
      listOf(LogLevel.VERBOSE, "values", 42.0, "AA:BB", 3L),
      listOf(entry.level, entry.message, entry.timestamp, entry.peripheralId, entry.opId),
    )
    assertFalse(logger.isOn(LogLevel.NONE))
  }

  private val testService = UUID.fromString("0c6c1000-b347-4cfa-9827-1c5a13658519")
  private val staticRead = UUID.fromString("0c6c1001-b347-4cfa-9827-1c5a13658519")
  private val readRef = GattCharacteristicRef(testService, 0, staticRead, 0)

  @Test
  fun `every GATT operation logs its id, kind, status and duration at debug`() {
    val executor = ManualExecutor()
    val device = FakeRemoteDevice("C0:FF:EE:00:00:01").apply {
      services =
        listOf(
          GattServiceInfo(
            testService,
            0,
            true,
            listOf(GattCharacteristicInfo(readRef, CharacteristicProperties.READ, emptyList())),
          ),
        )
    }
    val session = PeripheralSession(device.address, { device }, executor) { _, _ -> }
    session.logger = BleLogger(clock = { executor.nowMs().toDouble() }, platform = { _, line -> lines += line }).apply {
      level = LogLevel.DEBUG
      forward = { entries += it }
    }
    session.connect(ConnectSpec(15_000, requestMtu = null)) {}
    val client: FakeGattClient = device.clients.single()
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    executor.runUntilIdle()
    client.completeServiceDiscovery()
    lines.clear()
    entries.clear()

    session.read(testService, staticRead, null, {})
    executor.runUntilIdle()
    executor.advanceBy(34)
    client.callback.onCharacteristicRead(readRef, byteArrayOf(1), GATT_SUCCESS)
    session.read(testService, staticRead, 1_000, {})
    executor.advanceBy(1_000)
    session.read(testService, staticRead, null, {})
    session.read(testService, staticRead, null, {}, operationId = 9)
    executor.runUntilIdle()
    session.cancel(9)

    assertEquals(
      listOf(
        "C0:FF:EE:00:00:01 op #2: read $testService#0/$staticRead#0: ok in 34 ms",
        "C0:FF:EE:00:00:01 op #3: read $testService#0/$staticRead#0: OPERATION_TIMEOUT (Operation READ timed out after 1000 ms) in 1000 ms",
        "C0:FF:EE:00:00:01 op #5: read $testService#0/$staticRead#0: OPERATION_CANCELLED (Operation READ was cancelled) before it started",
      ),
      lines,
    )
    assertEquals(listOf(2L, 3L, 5L), entries.map { it.opId })
    assertTrue(entries.all { it.level == LogLevel.DEBUG && it.peripheralId == device.address })
  }
}
