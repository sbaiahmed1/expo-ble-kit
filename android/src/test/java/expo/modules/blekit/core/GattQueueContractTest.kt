package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.ManualExecutor
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * The shared GATT queue contract (test-contracts/gatt-queue.json): the Swift queue and the fake
 * adapter's TypeScript queue run the same cases.
 */
class GattQueueContractTest {
  private val contract = JSONObject(File(System.getProperty("blekit.contracts"), "gatt-queue.json").readText())

  @Test
  fun `every contract case passes`() {
    val cases = contract.getJSONArray("cases")
    for (index in 0 until cases.length()) {
      val case = cases.getJSONObject(index)
      run(
        case.getString("name"),
        case.getJSONArray("steps").let { steps ->
          (0 until steps.length()).map(steps::getJSONObject)
        },
      )
    }
  }

  private fun run(name: String, steps: List<JSONObject>) {
    val executor = ManualExecutor()
    val queue = GattQueue(executor)
    val operations = mutableMapOf<String, GattOperation>()
    val started = mutableListOf<String>()
    val results = mutableMapOf<String, String>()

    fun enqueue(op: String, timeout: Long?, first: Boolean, thenFirst: String?) {
      operations[op] = queue.enqueue(GattOperation.Kind.READ, op, timeout, first, start = { started += op }) { result ->
        results[op] = when (result) {
          is GattResult.Success -> "ok"
          is GattResult.Failure -> result.error.code.value
        }
        if (result is GattResult.Success && thenFirst != null) enqueue(thenFirst, null, true, null)
      }
    }

    for (step in steps) {
      when {
        step.has("enqueue") -> enqueue(
          step.getString("enqueue"),
          if (step.has("timeoutMs")) step.getLong("timeoutMs") else null,
          step.optBoolean("first"),
          step.optString("thenFirst").ifEmpty { null },
        )

        step.has("complete") -> {
          val op = step.getString("complete")
          val result = if (step.has("error")) {
            GattResult.Failure(CoreError(CoreError.Code.valueOf(step.getString("error")), "from the radio"))
          } else {
            GattResult.Success()
          }
          queue.complete(result) { it.target == op }
        }

        step.has("cancel") -> queue.cancel(operations.getValue(step.getString("cancel")))

        step.has("failAll") -> queue.failAll(CoreError(CoreError.Code.valueOf(step.getString("failAll")), "failed"))

        step.has("advance") -> executor.advanceBy(step.getLong("advance"))
      }
      executor.runUntilIdle()

      val expectation = step.optJSONObject("expect") ?: continue
      expectation.optJSONArray("started")?.let { expected ->
        assertEquals("$name: started", (0 until expected.length()).map(expected::getString), started)
      }
      expectation.optJSONObject("results")?.let { expected ->
        for (op in expected.keys()) {
          val value = if (expected.isNull(op)) null else expected.getString(op)
          assertEquals("$name: result of $op", value, results[op])
        }
      }
      if (expectation.has("depth")) {
        assertEquals("$name: depth", expectation.getInt("depth"), queue.depth)
      }
    }
  }
}
