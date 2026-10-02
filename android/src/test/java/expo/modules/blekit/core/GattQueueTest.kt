package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.ManualExecutor
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import kotlin.random.Random

/**
 * P1-02: ordering, per-operation timeouts, cancellation, reject-all on disconnect, and a randomized
 * check that no operation starts while another is in flight. Mirrors ios/Tests/GattQueueTests.swift.
 */
class GattQueueTest {
  private lateinit var executor: ManualExecutor
  private lateinit var queue: GattQueue
  private val started = mutableListOf<String>()
  private val results = mutableMapOf<String, GattResult>()

  @Before
  fun setUp() {
    executor = ManualExecutor()
    queue = GattQueue(executor)
  }

  private fun enqueue(name: String, timeoutMs: Long? = null): GattOperation =
    queue.enqueue(GattOperation.Kind.READ, target = name, timeoutMs = timeoutMs, start = { started.add(name) }) {
      if (results.containsKey(name)) fail("$name answered twice")
      results[name] = it
    }

  private fun complete(name: String, value: ByteArray? = null) =
    queue.complete(GattResult.Success(value)) { it.target == name }

  private fun errorCode(name: String) = (results[name] as? GattResult.Failure)?.error?.code

  @Test
  fun `runs one operation at a time in submission order`() {
    enqueue("a")
    enqueue("b")
    enqueue("c")
    assertEquals("nothing starts synchronously", emptyList<String>(), started)
    executor.runUntilIdle()
    assertEquals(listOf("a"), started)
    assertEquals(3, queue.depth)

    assertFalse("only the in-flight operation can complete", complete("b"))
    assertTrue(complete("a", byteArrayOf(1)))
    assertEquals("the next operation starts on the next turn", listOf("a"), started)
    executor.runUntilIdle()
    assertEquals(listOf("a", "b"), started)
    assertTrue(complete("b"))
    executor.runUntilIdle()
    assertTrue(complete("c"))
    executor.runUntilIdle()

    assertEquals(listOf("a", "b", "c"), started)
    assertArrayEquals(byteArrayOf(1), (results["a"] as GattResult.Success).value)
    assertEquals(0, queue.depth)
  }

  @Test
  fun `timeout rejects the operation, moves on and ignores the late result`() {
    val timeouts = mutableListOf<Int>()
    queue.onTimeout = { _, count -> timeouts.add(count) }
    enqueue("a", timeoutMs = 2_000)
    enqueue("b")
    executor.runUntilIdle()

    executor.advanceBy(1_999)
    assertNull(results["a"])
    executor.advanceBy(1)
    assertEquals(CoreError.Code.OPERATION_TIMEOUT, errorCode("a"))
    assertEquals(listOf("a", "b"), started)
    assertFalse("a late result for the timed-out operation is ignored", complete("a"))
    assertEquals(listOf(1), timeouts)

    executor.advanceBy(GattQueue.DEFAULT_TIMEOUT_MS)
    assertEquals("the default timeout is 10 s", CoreError.Code.OPERATION_TIMEOUT, errorCode("b"))
    assertEquals(listOf(1, 2), timeouts)

    enqueue("c")
    executor.runUntilIdle()
    assertTrue(complete("c"))
    assertEquals("a completion resets the count", 0, queue.consecutiveTimeouts)
  }

  @Test
  fun `cancelling a queued operation removes it`() {
    enqueue("a")
    val second = enqueue("b")
    executor.runUntilIdle()

    queue.cancel(second)
    assertEquals(CoreError.Code.OPERATION_CANCELLED, errorCode("b"))
    assertTrue(complete("a"))
    executor.runUntilIdle()
    assertEquals(listOf("a"), started)
    assertEquals(0, queue.depth)
  }

  @Test
  fun `cancelling the running operation answers at once but keeps the radio busy`() {
    val first = enqueue("a")
    enqueue("b")
    executor.runUntilIdle()

    queue.cancel(first)
    assertEquals(CoreError.Code.OPERATION_CANCELLED, errorCode("a"))
    executor.runUntilIdle()
    assertEquals("b must wait: the platform read can't be aborted", listOf("a"), started)

    assertTrue("the radio's answer frees the queue", complete("a", byteArrayOf(9)))
    assertEquals("but the caller keeps the cancellation", CoreError.Code.OPERATION_CANCELLED, errorCode("a"))
    executor.runUntilIdle()
    assertEquals(listOf("a", "b"), started)
  }

  @Test
  fun `failAll rejects everything and starts nothing`() {
    enqueue("a")
    enqueue("b")
    executor.runUntilIdle()

    queue.failAll(CoreError(CoreError.Code.DISCONNECTED, "link lost"))
    executor.advanceBy(60_000)

    assertEquals(CoreError.Code.DISCONNECTED, errorCode("a"))
    assertEquals(CoreError.Code.DISCONNECTED, errorCode("b"))
    assertEquals(listOf("a"), started)
    assertEquals(0, queue.depth)
  }

  @Test
  fun `an operation completing inside start does not start the next re-entrantly`() {
    var insideStart = false
    queue.enqueue(GattOperation.Kind.WRITE_WITHOUT_RESPONSE, target = "a", start = {
      insideStart = true
      assertTrue(complete("a"))
      insideStart = false
    }) {}
    queue.enqueue(GattOperation.Kind.WRITE_WITHOUT_RESPONSE, target = "b", start = {
      assertFalse("b started inside a's start", insideStart)
    }) {}

    executor.runUntilIdle()
    assertEquals("b", queue.current?.target)
  }

  /**
   * Randomized: whatever happens, an operation never starts while another holds the radio, every
   * caller is answered exactly once, and successful results arrive in submission order.
   */
  @Test
  fun `randomized operations never overlap`() {
    for (seed in 1L..25L) runRandomized(seed, steps = 2_000)
  }

  private fun runRandomized(seed: Long, steps: Int) {
    val executor = ManualExecutor()
    val queue = GattQueue(executor, defaultTimeoutMs = 3_000)
    val random = Random(seed)
    var radioHolder: Long? = null
    val answers = mutableMapOf<Long, Int>()
    val successes = mutableListOf<Long>()
    val operations = mutableListOf<GattOperation>()

    // The radio is held from `start` until the operation completes, times out or the queue fails.
    queue.onTimeout = { operation, _ -> if (radioHolder == operation.id) radioHolder = null }

    fun enqueueOne() {
      lateinit var operation: GattOperation
      operation =
        queue.enqueue(GattOperation.Kind.READ, timeoutMs = (random.nextInt(5) + 1) * 1_000L, start = {
          if (radioHolder != null) fail("seed $seed: op ${operation.id} started while op $radioHolder was in flight")
          radioHolder = operation.id
        }) { result ->
          answers[operation.id] = (answers[operation.id] ?: 0) + 1
          if (result is GattResult.Success) successes.add(operation.id)
        }
      operations.add(operation)
    }

    repeat(steps) {
      when (random.nextInt(10)) {
        0, 1, 2 -> enqueueOne()

        3, 4 ->
          radioHolder?.let { holder ->
            val result =
              if (random.nextInt(4) != 0) {
                GattResult.Success()
              } else {
                GattResult.Failure(CoreError(CoreError.Code.GATT_ERROR, "status 133"))
              }
            if (queue.complete(result) { it.id == holder }) radioHolder = null
          }

        5 -> if (operations.isNotEmpty()) queue.cancel(operations[random.nextInt(operations.size)])

        6, 7 -> executor.advanceBy(random.nextLong(2_000))

        8 -> executor.runUntilIdle()

        else ->
          if (random.nextInt(20) == 0) {
            queue.failAll(CoreError(CoreError.Code.DISCONNECTED, "link lost"))
            radioHolder = null
          }
      }
    }

    queue.failAll(CoreError(CoreError.Code.DISCONNECTED, "end of test"))
    executor.advanceBy(60_000)
    operations.forEach {
      assertEquals("seed $seed: op ${it.id} answered ${answers[it.id] ?: 0} times", 1, answers[it.id])
    }
    assertEquals("seed $seed: successes out of submission order", successes.sorted(), successes)
  }
}
