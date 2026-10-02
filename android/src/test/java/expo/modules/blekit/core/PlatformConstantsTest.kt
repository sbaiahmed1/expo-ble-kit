package expo.modules.blekit.core

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanSettings
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The core mirrors Android's Bluetooth constants so it can run in JVM tests. These are compile-time
 * constants in android.jar, so the comparison runs without an Android runtime.
 */
class PlatformConstantsTest {
  @Test
  fun `adapter, connection and bond states match Android`() {
    assertEquals(BluetoothAdapter.STATE_OFF, AdapterStates.OFF)
    assertEquals(BluetoothAdapter.STATE_TURNING_ON, AdapterStates.TURNING_ON)
    assertEquals(BluetoothAdapter.STATE_ON, AdapterStates.ON)
    assertEquals(BluetoothAdapter.STATE_TURNING_OFF, AdapterStates.TURNING_OFF)
    assertEquals(BluetoothProfile.STATE_DISCONNECTED, ConnectionStates.DISCONNECTED)
    assertEquals(BluetoothProfile.STATE_CONNECTING, ConnectionStates.CONNECTING)
    assertEquals(BluetoothProfile.STATE_CONNECTED, ConnectionStates.CONNECTED)
    assertEquals(BluetoothProfile.STATE_DISCONNECTING, ConnectionStates.DISCONNECTING)
    assertEquals(BluetoothDevice.BOND_NONE, BondStates.NONE)
    assertEquals(BluetoothDevice.BOND_BONDING, BondStates.BONDING)
    assertEquals(BluetoothDevice.BOND_BONDED, BondStates.BONDED)
  }

  @Test
  fun `characteristic constants match Android`() {
    assertEquals(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE, WriteTypes.NO_RESPONSE)
    assertEquals(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT, WriteTypes.DEFAULT)
    assertEquals(BluetoothGattCharacteristic.WRITE_TYPE_SIGNED, WriteTypes.SIGNED)
    assertEquals(BluetoothGattCharacteristic.PROPERTY_BROADCAST, CharacteristicProperties.BROADCAST)
    assertEquals(BluetoothGattCharacteristic.PROPERTY_READ, CharacteristicProperties.READ)
    assertEquals(BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE, CharacteristicProperties.WRITE_NO_RESPONSE)
    assertEquals(BluetoothGattCharacteristic.PROPERTY_WRITE, CharacteristicProperties.WRITE)
    assertEquals(BluetoothGattCharacteristic.PROPERTY_NOTIFY, CharacteristicProperties.NOTIFY)
    assertEquals(BluetoothGattCharacteristic.PROPERTY_INDICATE, CharacteristicProperties.INDICATE)
    assertEquals(BluetoothGattCharacteristic.PROPERTY_SIGNED_WRITE, CharacteristicProperties.SIGNED_WRITE)
    assertEquals(BluetoothGattCharacteristic.PROPERTY_EXTENDED_PROPS, CharacteristicProperties.EXTENDED_PROPS)
  }

  @Test
  fun `status codes and scan modes match Android`() {
    assertEquals(BluetoothGatt.GATT_SUCCESS, GATT_SUCCESS)
    assertEquals(BluetoothStatusCodes.SUCCESS, SubmitStatus.SUCCESS)
    assertEquals(BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY, SubmitStatus.ERROR_GATT_WRITE_REQUEST_BUSY)
    assertEquals(BluetoothStatusCodes.ERROR_UNKNOWN, SubmitStatus.ERROR_UNKNOWN)
    assertEquals(ScanSettings.SCAN_MODE_OPPORTUNISTIC, ScanModes.OPPORTUNISTIC)
    assertEquals(ScanSettings.SCAN_MODE_LOW_POWER, ScanModes.LOW_POWER)
    assertEquals(ScanSettings.SCAN_MODE_BALANCED, ScanModes.BALANCED)
    assertEquals(ScanSettings.SCAN_MODE_LOW_LATENCY, ScanModes.LOW_LATENCY)
    val defaults = ScanSettingsSpec()
    assertEquals(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, defaults.callbackType)
    assertEquals(ScanSettings.MATCH_MODE_AGGRESSIVE, defaults.matchMode)
    assertEquals(ScanSettings.PHY_LE_ALL_SUPPORTED, defaults.phy)
  }

  @Test
  fun `scan option strings map to Android constants`() {
    assertEquals(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, ScanOptionValues.callbackType("allMatches"))
    assertEquals(ScanSettings.CALLBACK_TYPE_FIRST_MATCH, ScanOptionValues.callbackType("firstMatch"))
    assertEquals(ScanSettings.CALLBACK_TYPE_MATCH_LOST, ScanOptionValues.callbackType("matchLost"))
    assertEquals(ScanSettings.MATCH_MODE_AGGRESSIVE, ScanOptionValues.matchMode("aggressive"))
    assertEquals(ScanSettings.MATCH_MODE_STICKY, ScanOptionValues.matchMode("sticky"))
    assertEquals(BluetoothDevice.PHY_LE_1M, ScanOptionValues.phy("le1m"))
    assertEquals(BluetoothDevice.PHY_LE_CODED, ScanOptionValues.phy("leCoded"))
    assertEquals(ScanSettings.PHY_LE_ALL_SUPPORTED, PlatformScan.PHY_ALL)
    assertEquals(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, PlatformScan.ALL_MATCHES)
  }
}
