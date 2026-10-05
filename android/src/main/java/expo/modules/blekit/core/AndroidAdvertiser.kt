package expo.modules.blekit.core

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertisingSet
import android.bluetooth.le.AdvertisingSetCallback
import android.bluetooth.le.AdvertisingSetParameters
import android.content.Context
import android.os.Handler
import android.os.ParcelUuid

/**
 * [AdvertiserPort] on `BluetoothLeAdvertiser.startAdvertisingSet` (API 26). The callbacks arrive
 * on [handler], the server thread. The caller checked the advertise permission.
 */
@SuppressLint("MissingPermission")
class AndroidAdvertiser(private val context: Context, private val handler: Handler) : AdvertiserPort {
  private var callback: AdvertisingSetCallback? = null

  private val adapter
    get() = context.getSystemService(BluetoothManager::class.java)?.adapter

  override fun capabilities(): AdvertiserCapabilities? {
    val adapter = adapter ?: return null
    if (adapter.bluetoothLeAdvertiser == null || !adapter.isMultipleAdvertisementSupported) return null
    val name = try {
      adapter.name // needs BLUETOOTH_CONNECT on Android 12+
    } catch (_: SecurityException) {
      null
    }
    return AdvertiserCapabilities(
      adapter.isLeExtendedAdvertisingSupported,
      adapter.leMaximumAdvertisingDataLength,
      name,
    )
  }

  override fun start(layout: AdvertisingLayout, spec: AdvertisingSpec, events: AdvertiserEvents) {
    val advertiser = adapter?.bluetoothLeAdvertiser ?: throw IllegalStateException("no LE advertiser")
    val parameters = AdvertisingSetParameters.Builder()
      .setLegacyMode(layout.legacy)
      .setConnectable(layout.connectable)
      .setScannable(layout.scanResponse != null)
      .setInterval(spec.mode.interval)
      .setTxPowerLevel(spec.txPower.dbm)
      .build()
    val callback = object : AdvertisingSetCallback() {
      override fun onAdvertisingSetStarted(advertisingSet: AdvertisingSet?, txPower: Int, status: Int) {
        events.onStarted(status)
      }

      override fun onAdvertisingEnabled(advertisingSet: AdvertisingSet?, enable: Boolean, status: Int) {
        if (!enable) events.onDisabled()
      }
    }
    this.callback = callback
    // Duration in 10 ms units; 0 advertises until stopped.
    val duration = spec.timeoutMs?.let { maxOf(1, it / 10) } ?: 0
    advertiser.startAdvertisingSet(
      parameters,
      layout.advertising.toData(),
      layout.scanResponse?.toData(),
      null,
      null,
      duration,
      0,
      callback,
      handler,
    )
  }

  override fun stop() {
    val callback = callback ?: return
    this.callback = null
    adapter?.bluetoothLeAdvertiser?.stopAdvertisingSet(callback)
  }

  private fun AdvertisingPayload.toData(): AdvertiseData = AdvertiseData.Builder().apply {
    serviceUuids.forEach { addServiceUuid(ParcelUuid(it)) }
    manufacturerData?.let { addManufacturerData(it.companyId, it.data) }
    serviceData.forEach { addServiceData(ParcelUuid(it.uuid), it.data) }
    setIncludeTxPowerLevel(includeTxPower)
    setIncludeDeviceName(includeName)
  }.build()
}
