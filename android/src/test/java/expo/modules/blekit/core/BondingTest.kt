package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.FakeBluetoothAdapter
import expo.modules.blekit.core.fakes.FakeGattClient
import expo.modules.blekit.core.fakes.FakeRemoteDevice
import expo.modules.blekit.core.fakes.ManualExecutor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** P5-01: createBond() through the queue, finished by the bond-state broadcast; bondState. */
class BondingTest {
  private val executor = ManualExecutor()
  private val device = FakeRemoteDevice("C0:FF:EE:00:00:01")
  private val session = PeripheralSession(device.address, { device }, executor) { _, _ -> }

  private val client: FakeGattClient get() = device.clients.last()

  private fun connect() {
    session.connect(ConnectSpec(15_000, autoDiscover = false, requestMtu = null)) {}
    client.callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    executor.runUntilIdle()
  }

  private fun bond(timeoutMs: Long? = 30_000): () -> String {
    var result = "pending"
    session.createBond(timeoutMs, { outcome ->
      result = (outcome.exceptionOrNull() as? CoreError)?.code?.value ?: "ok"
    })
    executor.runUntilIdle()
    return { result }
  }

  @Test
  fun `bonding starts once, and the broadcast settles it`() {
    connect()
    val pending = bond()
    assertEquals(1, device.bondRequests)
    assertEquals("pending", pending())
    session.onBondStateChanged(BondStates.BONDING)
    assertEquals("pending", pending())
    session.onBondStateChanged(BondStates.BONDED)
    assertEquals("ok", pending())
  }

  @Test
  fun `already bonded resolves at once, a refusal or a failed pairing is BOND_FAILED`() {
    connect()
    device.bondState = BondStates.BONDED
    assertEquals("ok", bond()())
    assertEquals(0, device.bondRequests)

    device.bondState = BondStates.NONE
    device.acceptsBond = false
    assertEquals("BOND_FAILED", bond()())

    device.acceptsBond = true
    val rejected = bond()
    session.onBondStateChanged(BondStates.NONE) // the user declined, or the device rejected the pairing
    assertEquals("BOND_FAILED", rejected())
  }

  @Test
  fun `a bond waiting for the user times out without resetting the connection`() {
    connect()
    val first = bond(timeoutMs = 1_000)
    executor.advanceBy(1_000)
    assertEquals("OPERATION_TIMEOUT", first())
    device.bondState = BondStates.NONE
    val second = bond(timeoutMs = 1_000)
    executor.advanceBy(1_000)
    assertEquals("OPERATION_TIMEOUT", second())
    assertEquals("two bond timeouts aren't a stuck stack", SessionState.READY, session.state)
  }

  @Test
  fun `operations queued behind a bond wait for it, and bonding needs a connection`() {
    assertEquals("DISCONNECTED", bond()())
    connect()
    val pending = bond()
    var rssi: Int? = null
    session.readRssi(null, { rssi = it.getOrNull() })
    executor.runUntilIdle()
    assertEquals("the RSSI read waits", 0, client.calls.filterIsInstance<FakeGattClient.Call.ReadRssi>().size)
    session.onBondStateChanged(BondStates.BONDED)
    executor.runUntilIdle()
    assertEquals("ok", pending())
    assertEquals(1, client.calls.filterIsInstance<FakeGattClient.Call.ReadRssi>().size)
    assertNull(rssi)
  }

  private class Permissions : PermissionSystem {
    override val sdkInt = 34
    val granted = mutableSetOf(AndroidPermissions.BLUETOOTH_SCAN, AndroidPermissions.BLUETOOTH_CONNECT)

    override fun declaredPermissions() = DeclaredPermissions(
      setOf(AndroidPermissions.BLUETOOTH_SCAN, AndroidPermissions.BLUETOOTH_CONNECT),
      scanNeverForLocation = true,
    )

    override fun isGranted(permission: String) = permission in granted
  }

  @Test
  fun `the engine publishes bond states and routes the broadcast to the session`() {
    val adapter = FakeBluetoothAdapter()
    val permissions = Permissions()
    val engineExecutor = ManualExecutor()
    val engine = CentralEngine(adapter, permissions, engineExecutor, EpochClock(0, 0)).apply { start() }
    val id = "C0:FF:EE:00:00:02"
    assertEquals("none", engine.bondState(id))
    adapter.simulateBond(id, BondStates.BONDING)
    assertEquals("bonding", engine.bondState("c0:ff:ee:00:00:02"))

    engine.connect(id, ConnectSpec(15_000, autoDiscover = false, requestMtu = null)) {}
    val remote = adapter.devices.getValue(id)
    remote.clients.last().callback.onConnectionStateChange(GATT_SUCCESS, ConnectionStates.CONNECTED)
    engineExecutor.runUntilIdle()
    var result: String? = null
    engine.createBond(id, 30_000, { result = (it.exceptionOrNull() as? CoreError)?.code?.value ?: "ok" })
    engineExecutor.runUntilIdle()
    adapter.simulateBond(id, BondStates.BONDED)
    engineExecutor.runUntilIdle()
    assertEquals("ok", result)
    assertEquals("bonded", engine.bondState(id))

    permissions.granted.remove(AndroidPermissions.BLUETOOTH_CONNECT)
    engine.createBond(id, 30_000, { result = (it.exceptionOrNull() as? CoreError)?.code?.value })
    assertEquals("PERMISSION_DENIED", result)
  }
}
