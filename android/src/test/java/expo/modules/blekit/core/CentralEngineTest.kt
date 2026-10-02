package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeBluetoothAdapter
import expo.modules.blekit.core.fakes.ManualExecutor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** P1-03: adapter state as JS sees it. */
class CentralEngineTest {
  private class FakePermissionSystem(override val sdkInt: Int) : PermissionSystem {
    val granted = mutableSetOf<String>()
    var declared = setOf(AndroidPermissions.BLUETOOTH_SCAN, AndroidPermissions.BLUETOOTH_CONNECT)

    override fun declaredPermissions() = DeclaredPermissions(declared, scanNeverForLocation = true)

    override fun isGranted(permission: String) = permission in granted
  }

  private val adapter = FakeBluetoothAdapter(state = AdapterStates.ON)
  private val permissions = FakePermissionSystem(sdkInt = 34)
  private val events = mutableListOf<BleState>()

  private fun engine() = CentralEngine(adapter, permissions, ManualExecutor(), EpochClock(0, 0)).also { engine ->
    engine.listener =
      object : CentralEngine.Listener {
        override fun onStateChange(state: BleState) {
          events.add(state)
        }

        override fun onScanResults(sessionId: Int, results: List<Map<String, Any?>>) = Unit

        override fun onScanError(sessionId: Int, error: CoreError) = Unit

        override fun onWarning(warning: CoreError) = Unit
      }
    engine.start()
  }

  @Test
  fun `maps every adapter state`() {
    val on = { state: Int -> BleState.of(isAvailable = true, isAuthorized = true, adapterState = state) }
    assertEquals(BleState.POWERED_OFF, on(AdapterStates.OFF))
    assertEquals(BleState.RESETTING, on(AdapterStates.TURNING_ON))
    assertEquals(BleState.POWERED_ON, on(AdapterStates.ON))
    assertEquals(BleState.RESETTING, on(AdapterStates.TURNING_OFF))
    assertEquals(BleState.UNKNOWN, on(-1))
    assertEquals(BleState.UNSUPPORTED, BleState.of(isAvailable = false, isAuthorized = false, adapterState = 12))
    assertEquals(BleState.UNAUTHORIZED, BleState.of(isAvailable = true, isAuthorized = false, adapterState = 12))
  }

  @Test
  fun `follows the adapter while authorized`() {
    permissions.granted += AndroidPermissions.BLUETOOTH_CONNECT
    val engine = engine()
    assertEquals(BleState.POWERED_ON, engine.state)
    adapter.simulateState(AdapterStates.TURNING_OFF)
    adapter.simulateState(AdapterStates.OFF)
    adapter.simulateState(AdapterStates.OFF)
    adapter.simulateState(AdapterStates.TURNING_ON)
    adapter.simulateState(AdapterStates.ON)
    assertEquals(
      listOf(BleState.RESETTING, BleState.POWERED_OFF, BleState.RESETTING, BleState.POWERED_ON),
      events,
    )
  }

  @Test
  fun `unauthorized until BLUETOOTH_CONNECT is granted, then refresh picks it up`() {
    val engine = engine()
    assertEquals(BleState.UNAUTHORIZED, engine.state)
    adapter.simulateState(AdapterStates.OFF)
    assertEquals(emptyList<BleState>(), events)

    permissions.granted += AndroidPermissions.BLUETOOTH_CONNECT
    engine.refresh()
    assertEquals(listOf(BleState.POWERED_OFF), events)
  }

  @Test
  fun `no runtime permission gates the adapter up to API 30`() {
    val legacy = FakePermissionSystem(sdkInt = 30)
    assertEquals(BleState.POWERED_ON, CentralEngine(adapter, legacy, ManualExecutor(), EpochClock(0, 0)).state)
  }

  @Test
  fun `unsupported without an LE adapter`() {
    adapter.isAvailable = false
    permissions.granted += AndroidPermissions.BLUETOOTH_CONNECT
    assertEquals(BleState.UNSUPPORTED, engine().state)
  }

  @Test
  fun `close stops listening`() {
    val engine = engine()
    engine.close()
    assertNull(adapter.stateListener)
  }
}
