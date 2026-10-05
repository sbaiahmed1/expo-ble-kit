package expo.modules.blekit.core

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.os.Handler
import java.util.UUID

/**
 * Opens Android's GATT server for [GattServer] (P4-01). Android calls the server callback on Binder
 * threads (`openGattServer` takes no Handler), so every callback hops to [handler], the server
 * thread, before the core sees it (plan §4.7, the lesson of the P2-09 scan crash).
 */
class AndroidGattServerOpener(private val context: Context, private val handler: Handler) {
  fun open(events: GattServerEvents): GattServerPort? {
    val manager = context.getSystemService(BluetoothManager::class.java) ?: return null
    val devices = HashMap<String, BluetoothDevice>()
    val callback = object : BluetoothGattServerCallback() {
      private fun post(device: BluetoothDevice, block: (String) -> Unit) {
        handler.post {
          devices[device.address] = device
          block(device.address)
        }
      }

      override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) =
        post(device) { events.onConnectionStateChange(it, newState == BluetoothProfile.STATE_CONNECTED) }

      override fun onServiceAdded(status: Int, service: BluetoothGattService) {
        handler.post { events.onServiceAdded(status, service.uuid) }
      }

      override fun onCharacteristicReadRequest(
        device: BluetoothDevice,
        requestId: Int,
        offset: Int,
        characteristic: BluetoothGattCharacteristic,
      ) = post(device) { events.onCharacteristicReadRequest(it, requestId, offset, characteristic.uuid) }

      override fun onCharacteristicWriteRequest(
        device: BluetoothDevice,
        requestId: Int,
        characteristic: BluetoothGattCharacteristic,
        preparedWrite: Boolean,
        responseNeeded: Boolean,
        offset: Int,
        value: ByteArray?,
      ) = post(device) {
        events.onCharacteristicWriteRequest(
          it,
          requestId,
          characteristic.uuid,
          preparedWrite,
          responseNeeded,
          offset,
          value ?: ByteArray(0),
        )
      }

      override fun onDescriptorReadRequest(
        device: BluetoothDevice,
        requestId: Int,
        offset: Int,
        descriptor: BluetoothGattDescriptor,
      ) = post(device) {
        events.onDescriptorReadRequest(it, requestId, offset, descriptor.characteristic.uuid, descriptor.uuid)
      }

      override fun onDescriptorWriteRequest(
        device: BluetoothDevice,
        requestId: Int,
        descriptor: BluetoothGattDescriptor,
        preparedWrite: Boolean,
        responseNeeded: Boolean,
        offset: Int,
        value: ByteArray?,
      ) = post(device) {
        events.onDescriptorWriteRequest(
          it,
          requestId,
          descriptor.characteristic.uuid,
          descriptor.uuid,
          preparedWrite,
          responseNeeded,
          offset,
          value ?: ByteArray(0),
        )
      }

      override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) =
        post(device) { events.onExecuteWrite(it, requestId, execute) }

      override fun onNotificationSent(device: BluetoothDevice, status: Int) =
        post(device) { events.onNotificationSent(it, status) }

      override fun onMtuChanged(device: BluetoothDevice, mtu: Int) = post(device) { events.onMtuChanged(it, mtu) }
    }
    val server: BluetoothGattServer = manager.openGattServer(context, callback) ?: return null
    // The published characteristics, which notifications need (their service and instance id).
    val published = HashMap<UUID, BluetoothGattCharacteristic>()
    return object : GattServerPort {
      override fun addService(service: ServerServiceSpec): Boolean {
        val platform = service.toPlatform()
        platform.characteristics.forEach { published[it.uuid] = it }
        return server.addService(platform)
      }

      override fun notify(central: String, characteristic: UUID, value: ByteArray, confirm: Boolean): Int {
        val device = devices[central] ?: return SubmitStatus.ERROR_UNKNOWN
        val target = published[characteristic] ?: return SubmitStatus.ERROR_UNKNOWN
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          server.notifyCharacteristicChanged(device, target, confirm, value)
        } else {
          @Suppress("DEPRECATION")
          target.value = value
          @Suppress("DEPRECATION")
          val sent = server.notifyCharacteristicChanged(device, target, confirm)
          if (sent) SubmitStatus.SUCCESS else SubmitStatus.ERROR_GATT_WRITE_REQUEST_BUSY
        }
      }

      override fun sendResponse(central: String, requestId: Int, status: Int, offset: Int, value: ByteArray?): Boolean {
        val device = devices[central] ?: return false
        return server.sendResponse(device, requestId, status, offset, value)
      }

      override fun close() {
        server.close()
      }
    }
  }
}

/**
 * Android's service for [this]. Static values stay in the core, which answers every read: Android
 * calls the app for reads either way. Notifiable characteristics get a CCCD, which iOS adds by itself.
 */
private fun ServerServiceSpec.toPlatform(): BluetoothGattService {
  val type = if (primary) BluetoothGattService.SERVICE_TYPE_PRIMARY else BluetoothGattService.SERVICE_TYPE_SECONDARY
  return BluetoothGattService(uuid, type).also { service ->
    for (spec in characteristics) {
      val characteristic = BluetoothGattCharacteristic(spec.uuid, spec.properties, spec.permissions)
      for (descriptor in spec.descriptors) {
        characteristic.addDescriptor(BluetoothGattDescriptor(descriptor.uuid, BluetoothGattDescriptor.PERMISSION_READ))
      }
      if (spec.notifiable) {
        val cccdPermissions = BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
        characteristic.addDescriptor(BluetoothGattDescriptor(GattServer.CCCD, cccdPermissions))
      }
      service.addCharacteristic(characteristic)
    }
  }
}
