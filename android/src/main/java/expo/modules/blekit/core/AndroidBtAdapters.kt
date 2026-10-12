package expo.modules.blekit.core

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.ParcelUuid

// Real Android implementations of the BtAbstractions interfaces. The engine checks runtime
// permissions before calling into these (P1-03), hence the MissingPermission suppressions.

/** `ScanCallback.SCAN_FAILED_INTERNAL_ERROR`, reported when no scanner is available. */
internal const val SCAN_FAILED_INTERNAL_ERROR = 3

@SuppressLint("MissingPermission")
class AndroidBluetoothAdapterPort(private val context: Context, private val handler: Handler) : BluetoothAdapterPort {
  private val adapter: BluetoothAdapter? =
    context.getSystemService(BluetoothManager::class.java)?.adapter

  private val scanner: AndroidLeScanner? = adapter?.let { AndroidLeScanner(it, context, handler) }

  override val isAvailable: Boolean
    get() = adapter != null && context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)

  override val state: Int
    get() = adapter?.state ?: AdapterStates.OFF

  override val leScanner: LeScannerPort?
    get() = scanner.takeIf { adapter?.bluetoothLeScanner != null }

  private var stateReceiver: BroadcastReceiver? = null

  override fun setStateListener(listener: ((Int) -> Unit)?) {
    stateReceiver?.let(context::unregisterReceiver)
    stateReceiver = null
    if (listener == null || adapter == null) {
      return
    }
    val receiver =
      object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          listener(intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR))
        }
      }
    // ACTION_STATE_CHANGED is a protected system broadcast, so no export flag is needed. It comes
    // from the Bluetooth process, not the system server, so RECEIVER_NOT_EXPORTED would drop it.
    context.registerReceiver(receiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED), null, handler)
    stateReceiver = receiver
  }

  private var bondReceiver: BroadcastReceiver? = null

  override fun setBondStateListener(listener: ((address: String, state: Int) -> Unit)?) {
    bondReceiver?.let(context::unregisterReceiver)
    bondReceiver = null
    if (listener == null || adapter == null) {
      return
    }
    val receiver =
      object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          val device = intent.bluetoothDevice() ?: return
          listener(device.address, intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BondStates.NONE))
        }
      }
    // Protected system broadcast from the Bluetooth process, like ACTION_STATE_CHANGED above.
    context.registerReceiver(receiver, IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED), null, handler)
    bondReceiver = receiver
  }

  override fun remoteDevice(address: String): RemoteDevicePort {
    val adapter = checkNotNull(adapter) { "No Bluetooth adapter" }
    return AndroidRemoteDevice(context, adapter.getRemoteDevice(address), handler)
  }

  override fun connectedGattDevices(): List<String> = context.getSystemService(BluetoothManager::class.java)
    ?.getConnectedDevices(BluetoothProfile.GATT)
    .orEmpty()
    .map { it.address }
}

@SuppressLint("MissingPermission")
class AndroidLeScanner(
  private val adapter: BluetoothAdapter,
  private val context: Context,
  private val handler: Handler,
) : LeScannerPort {
  private val platformCallbacks = mutableMapOf<LeScanCallback, ScanCallback>()

  override fun startScan(filters: List<ScanFilterSpec>, settings: ScanSettingsSpec, callback: LeScanCallback) {
    val scanner = adapter.bluetoothLeScanner
    if (scanner == null) {
      callback.onScanFailed(SCAN_FAILED_INTERNAL_ERROR)
      return
    }
    // Android calls ScanCallback on the main thread; the core runs on the BLE thread (plan §4.7),
    // so every callback hops to `handler`. Callbacks from a scan stopped meanwhile are dropped.
    val platformCallback =
      object : ScanCallback() {
        private fun onBleThread(block: () -> Unit) {
          handler.post { if (platformCallbacks[callback] === this) block() }
        }

        override fun onScanResult(callbackType: Int, result: ScanResult) {
          val record = result.toRecord(context, handler)
          onBleThread { callback.onScanResults(listOf(record)) }
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
          val records = results.map { it.toRecord(context, handler) }
          onBleThread { callback.onScanResults(records) }
        }

        override fun onScanFailed(errorCode: Int) {
          onBleThread { callback.onScanFailed(errorCode) }
        }
      }
    platformCallbacks[callback] = platformCallback
    scanner.startScan(filters.map { it.toPlatform() }, settings.toPlatform(), platformCallback)
  }

  override fun stopScan(callback: LeScanCallback) {
    val platformCallback = platformCallbacks.remove(callback) ?: return
    try {
      adapter.bluetoothLeScanner?.stopScan(platformCallback)
    } catch (_: IllegalStateException) {
      // The adapter is already off, which ends the scan anyway.
    }
  }
}

@SuppressLint("MissingPermission")
class AndroidRemoteDevice(
  private val context: Context,
  private val device: BluetoothDevice,
  private val handler: Handler,
) : RemoteDevicePort {
  override val address: String = device.address

  override val name: String?
    get() = device.name

  override val bondState: Int
    get() = try {
      device.bondState
    } catch (_: SecurityException) {
      BondStates.NONE
    }

  override fun createBond(): Boolean = try {
    device.createBond()
  } catch (_: SecurityException) {
    false
  }

  override fun connectGatt(autoConnect: Boolean, callback: GattClientCallback): GattClientPort? {
    val client = AndroidGattClient(address, callback)
    // API 26+ overload: callbacks land on `handler`, the BLE thread (plan §4.4).
    val gatt =
      device.connectGatt(
        context,
        autoConnect,
        client.platformCallback,
        BluetoothDevice.TRANSPORT_LE,
        BluetoothDevice.PHY_LE_1M_MASK,
        handler,
      ) ?: return null
    client.attach(gatt)
    return client
  }
}

@SuppressLint("MissingPermission")
class AndroidGattClient(override val address: String, private val callback: GattClientCallback) : GattClientPort {
  private var gatt: BluetoothGatt? = null

  internal fun attach(gatt: BluetoothGatt) {
    this.gatt = gatt
  }

  override fun discoverServices(): Boolean = gatt?.discoverServices() ?: false

  override fun services(): List<GattServiceInfo> = gatt?.services?.map { it.toInfo() } ?: emptyList()

  override fun readCharacteristic(ref: GattCharacteristicRef): Boolean {
    val characteristic = find(ref) ?: return false
    return gatt?.readCharacteristic(characteristic) ?: false
  }

  @Suppress("DEPRECATION")
  override fun writeCharacteristic(ref: GattCharacteristicRef, value: ByteArray, writeType: Int): Int {
    val gatt = gatt ?: return SubmitStatus.ERROR_UNKNOWN
    val characteristic = find(ref) ?: return SubmitStatus.ERROR_UNKNOWN
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return gatt.writeCharacteristic(characteristic, value, writeType)
    }
    characteristic.writeType = writeType
    characteristic.value = value
    return if (gatt.writeCharacteristic(characteristic)) SubmitStatus.SUCCESS else legacyRefusal()
  }

  override fun readDescriptor(ref: GattDescriptorRef): Boolean {
    val descriptor = find(ref) ?: return false
    return gatt?.readDescriptor(descriptor) ?: false
  }

  @Suppress("DEPRECATION")
  override fun writeDescriptor(ref: GattDescriptorRef, value: ByteArray): Int {
    val gatt = gatt ?: return SubmitStatus.ERROR_UNKNOWN
    val descriptor = find(ref) ?: return SubmitStatus.ERROR_UNKNOWN
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return gatt.writeDescriptor(descriptor, value)
    }
    descriptor.value = value
    return if (gatt.writeDescriptor(descriptor)) SubmitStatus.SUCCESS else legacyRefusal()
  }

  /**
   * Before Android 13 a write returns false, without a reason. With the client open and the attribute
   * found (checked above, and its properties by the session), the remaining reason is a write still
   * waiting for its callback (`mDeviceBusy`), so the session retries it like Android 13's
   * ERROR_GATT_WRITE_REQUEST_BUSY, within the operation's timeout.
   */
  private fun legacyRefusal() = SubmitStatus.ERROR_GATT_WRITE_REQUEST_BUSY

  override fun setCharacteristicNotification(ref: GattCharacteristicRef, enable: Boolean): Boolean {
    val characteristic = find(ref) ?: return false
    return gatt?.setCharacteristicNotification(characteristic, enable) ?: false
  }

  override fun requestMtu(mtu: Int): Boolean = gatt?.requestMtu(mtu) ?: false

  override fun readRemoteRssi(): Boolean = gatt?.readRemoteRssi() ?: false

  override fun requestConnectionPriority(priority: Int): Boolean = gatt?.requestConnectionPriority(priority) ?: false

  override fun setPreferredPhy(txPhy: Int, rxPhy: Int, options: Int) {
    gatt?.setPreferredPhy(txPhy, rxPhy, options)
  }

  override fun readPhy() {
    gatt?.readPhy()
  }

  override fun disconnect() {
    gatt?.disconnect()
  }

  override fun close() {
    gatt?.close()
    gatt = null
  }

  /**
   * `BluetoothGatt.refresh()` is public in the platform but hidden from the SDK (plan §4.4): found by
   * reflection, so a platform without it (or one that blocks it) answers false instead of failing.
   */
  @SuppressLint("DiscouragedPrivateApi", "PrivateApi")
  override fun refreshCache(): Boolean {
    val gatt = gatt ?: return false
    return try {
      gatt.javaClass.getMethod("refresh").invoke(gatt) as? Boolean ?: false
    } catch (error: ReflectiveOperationException) {
      false
    } catch (error: RuntimeException) {
      false
    }
  }

  private fun find(ref: GattCharacteristicRef): BluetoothGattCharacteristic? = gatt
    ?.services
    ?.firstOrNull { it.uuid == ref.serviceUuid && it.instanceId == ref.serviceInstanceId }
    ?.characteristics
    ?.firstOrNull { it.uuid == ref.uuid && it.instanceId == ref.instanceId }

  private fun find(ref: GattDescriptorRef): BluetoothGattDescriptor? = find(ref.characteristic)?.getDescriptor(ref.uuid)

  internal val platformCallback =
    object : BluetoothGattCallback() {
      override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
        callback.onConnectionStateChange(status, newState)
      }

      override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
        callback.onServicesDiscovered(status)
      }

      override fun onCharacteristicRead(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray,
        status: Int,
      ) {
        callback.onCharacteristicRead(characteristic.ref(), value, status)
      }

      @Deprecated("Only called below API 33")
      @Suppress("DEPRECATION")
      override fun onCharacteristicRead(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        status: Int,
      ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
          callback.onCharacteristicRead(characteristic.ref(), characteristic.value ?: ByteArray(0), status)
        }
      }

      override fun onCharacteristicWrite(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        status: Int,
      ) {
        callback.onCharacteristicWrite(characteristic.ref(), status)
      }

      override fun onCharacteristicChanged(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray,
      ) {
        callback.onCharacteristicChanged(characteristic.ref(), value)
      }

      @Deprecated("Only called below API 33")
      @Suppress("DEPRECATION")
      override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
          callback.onCharacteristicChanged(characteristic.ref(), characteristic.value ?: ByteArray(0))
        }
      }

      override fun onDescriptorRead(
        gatt: BluetoothGatt,
        descriptor: BluetoothGattDescriptor,
        status: Int,
        value: ByteArray,
      ) {
        callback.onDescriptorRead(descriptor.ref(), value, status)
      }

      @Deprecated("Only called below API 33")
      @Suppress("DEPRECATION")
      override fun onDescriptorRead(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
          callback.onDescriptorRead(descriptor.ref(), descriptor.value ?: ByteArray(0), status)
        }
      }

      override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
        callback.onDescriptorWrite(descriptor.ref(), status)
      }

      override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
        callback.onMtuChanged(mtu, status)
      }

      override fun onReadRemoteRssi(gatt: BluetoothGatt, rssi: Int, status: Int) {
        callback.onReadRemoteRssi(rssi, status)
      }

      override fun onPhyUpdate(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) {
        callback.onPhyUpdate(txPhy, rxPhy, status)
      }

      override fun onPhyRead(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) {
        callback.onPhyRead(txPhy, rxPhy, status)
      }

      override fun onServiceChanged(gatt: BluetoothGatt) {
        callback.onServiceChanged()
      }
    }
}

// ---------------------------------------------------------------- Conversions

private fun BluetoothGattCharacteristic.ref(): GattCharacteristicRef =
  GattCharacteristicRef(service.uuid, service.instanceId, uuid, instanceId)

private fun BluetoothGattDescriptor.ref(): GattDescriptorRef = GattDescriptorRef(characteristic.ref(), uuid)

private fun BluetoothGattService.toInfo(): GattServiceInfo = GattServiceInfo(
  uuid = uuid,
  instanceId = instanceId,
  isPrimary = type == BluetoothGattService.SERVICE_TYPE_PRIMARY,
  characteristics =
  characteristics.map { characteristic ->
    GattCharacteristicInfo(
      ref = characteristic.ref(),
      properties = characteristic.properties,
      descriptors = characteristic.descriptors.map { it.uuid },
    )
  },
)

internal fun ScanResult.toRecord(context: Context, handler: Handler): ScanRecordData {
  val record = scanRecord
  val manufacturer = record?.manufacturerSpecificData
  return ScanRecordData(
    address = device.address,
    // From the advertisement only: BluetoothDevice.getName() needs BLUETOOTH_CONNECT.
    name = record?.deviceName,
    rssi = rssi,
    // The TX Power Level AD structure, else the extended-advertising header's value.
    txPowerLevel = record?.txPowerLevel?.takeIf { it != Int.MIN_VALUE }
      ?: txPower.takeIf { it != ScanResult.TX_POWER_NOT_PRESENT },
    isConnectable = isConnectable,
    serviceUuids = record?.serviceUuids?.map { it.uuid } ?: emptyList(),
    serviceData = record?.serviceData?.mapKeys { it.key.uuid } ?: emptyMap(),
    manufacturerData =
    buildMap {
      if (manufacturer != null) {
        for (i in 0 until manufacturer.size()) put(manufacturer.keyAt(i), manufacturer.valueAt(i))
      }
    },
    rawBytes = record?.bytes,
    timestampNanos = timestampNanos,
    device = AndroidRemoteDevice(context, device, handler),
  )
}

internal fun ScanFilterSpec.toPlatform(): ScanFilter = ScanFilter
  .Builder()
  .apply {
    serviceUuid?.let { setServiceUuid(ParcelUuid(it)) }
    deviceName?.let { setDeviceName(it) }
    deviceAddress?.let { setDeviceAddress(it) }
    if (manufacturerId != null) {
      setManufacturerData(manufacturerId, manufacturerData ?: ByteArray(0), manufacturerDataMask)
    }
  }.build()

internal fun ScanSettingsSpec.toPlatform(): ScanSettings = ScanSettings
  .Builder()
  .setScanMode(scanMode)
  .setCallbackType(callbackType)
  .setMatchMode(matchMode)
  .setLegacy(legacy)
  .setPhy(phy)
  .setReportDelay(reportDelayMs)
  .build()

/** `BluetoothDevice.EXTRA_DEVICE`, with the typed getter from API 33. */
private fun Intent.bluetoothDevice(): BluetoothDevice? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
  getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
} else {
  @Suppress("DEPRECATION")
  getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
}
