package expo.modules.blekit.core

import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothDevice
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.companion.AssociationInfo
import android.companion.AssociationRequest
import android.companion.BluetoothLeDeviceFilter
import android.companion.CompanionDeviceManager
import android.companion.ObservingDevicePresenceRequest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.Parcelable

/**
 * CompanionDeviceManager for the binding (P5-05, rules in [CompanionDevices]): the association picker and
 * presence observation. Main thread for [associate]; the rest on any thread.
 */
class AndroidCompanion(private val context: Context) {
  /** An association; [id] is known from Android 13 (API 33). [address] as Android reports it. */
  data class Association(val id: Int?, val address: String)

  private val manager: CompanionDeviceManager?
    get() = context.getSystemService(CompanionDeviceManager::class.java)

  private val hasFeature: Boolean
    get() = manager != null && context.packageManager.hasSystemFeature(PackageManager.FEATURE_COMPANION_DEVICE_SETUP)

  /** Throws NOT_SUPPORTED without the system feature, MISCONFIGURED without the manifest's. */
  fun checkAssociation() {
    if (!hasFeature) throw CoreError(CoreError.Code.NOT_SUPPORTED, "This device has no companion device manager")
    val features = packageInfo(PackageManager.GET_CONFIGURATIONS).reqFeatures.orEmpty()
    if (features.none { it.name == CompanionDevices.FEATURE }) {
      throw CompanionDevices.misconfigured(listOf("the feature ${CompanionDevices.FEATURE}"))
    }
  }

  /** Throws like [CompanionDevices.checkPresence]; [service] is the presence service class. */
  fun checkPresence(service: Class<*>) {
    checkAssociation()
    val declared = packageInfo(PackageManager.GET_PERMISSIONS).requestedPermissions.orEmpty().toSet()
    CompanionDevices.checkPresence(Build.VERSION.SDK_INT, hasFeature, declared, isDeclared(service))
  }

  /**
   * Shows the system picker from [activity] for devices matching [spec]: its result comes to
   * [association] through Android's callback or the activity result of [requestCode], which the
   * binding passes to [onActivityResult].
   */
  fun associate(activity: Activity, spec: CompanionFilterSpec, requestCode: Int, association: CompanionAssociation) {
    val manager =
      manager ?: throw CoreError(CoreError.Code.NOT_SUPPORTED, "This device has no companion device manager")
    val request = AssociationRequest.Builder().apply {
      filters(spec).forEach(::addDeviceFilter)
      setSingleDevice(spec.singleDevice)
    }.build()
    val callback = object : CompanionDeviceManager.Callback() {
      // Before Android 13; from 13 Android calls onAssociationPending instead.
      @Deprecated("Android 13 replaced it with onAssociationPending")
      override fun onDeviceFound(sender: IntentSender) = launch(sender)

      override fun onAssociationPending(sender: IntentSender) = launch(sender)

      override fun onAssociationCreated(info: AssociationInfo) = association.finish(info.deviceMacAddress?.toString())

      override fun onFailure(error: CharSequence?) = fail(null, error)

      override fun onFailure(code: Int, error: CharSequence?) = fail(code, error)

      private fun fail(code: Int?, error: CharSequence?) {
        BleLogger.logcat(LogLevel.INFO, "companion association ended: ${code ?: "-"} $error")
        CompanionDevices.failure(code, error?.toString())?.let(association::fail) ?: association.finish(null)
      }

      private fun launch(sender: IntentSender) {
        if (association.launched || association.finished) return
        association.launched = true
        try {
          activity.startIntentSenderForResult(sender, requestCode, null, 0, 0, 0)
        } catch (error: IntentSender.SendIntentException) {
          association.fail(
            CoreError(CoreError.Code.INTERNAL, "The companion device picker didn't open: ${error.message}"),
          )
        }
      }
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        manager.associate(request, context.mainExecutor, callback)
      } else {
        @Suppress("DEPRECATION")
        manager.associate(request, callback, Handler(Looper.getMainLooper()))
      }
    } catch (error: IllegalStateException) {
      // The manifest's uses-feature, checked again by the system service.
      throw CoreError(CoreError.Code.MISCONFIGURED, "${error.message} (${CoreError.SETUP_GUIDE})")
    }
  }

  /**
   * The picker's activity result: OK with the device (`EXTRA_ASSOCIATION` from Android 13, before
   * it `EXTRA_DEVICE`, a `ScanResult` for LE filters), or closed. From Android 13 an OK without an
   * association waits for `onAssociationCreated`.
   */
  fun onActivityResult(resultCode: Int, data: Intent?, association: CompanionAssociation) {
    if (resultCode != Activity.RESULT_OK) return association.finish(null)
    val address = data?.let(::resultAddress)
    if (address != null || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) association.finish(address)
  }

  private fun resultAddress(data: Intent): String? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      data.getParcelableExtra(CompanionDeviceManager.EXTRA_ASSOCIATION, AssociationInfo::class.java)
        ?.deviceMacAddress?.let { return it.toString() }
    }
    @Suppress("DEPRECATION")
    return when (val device = data.getParcelableExtra<Parcelable>(CompanionDeviceManager.EXTRA_DEVICE)) {
      is ScanResult -> device.device.address
      is BluetoothDevice -> device.address
      else -> null
    }
  }

  /** The app's associations. */
  fun associations(): List<Association> {
    val manager = manager ?: return emptyList()
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      manager.myAssociations.mapNotNull { info -> info.deviceMacAddress?.let { Association(info.id, it.toString()) } }
    } else {
      @Suppress("DEPRECATION")
      manager.associations.map { Association(null, it) }
    }
  }

  /** Starts or stops presence observation of [association] (Android 12+); false when Android refused. */
  @SuppressLint("MissingPermission") // checkPresence ran when the task registered
  fun observe(association: Association, observe: Boolean): Boolean {
    if (Build.VERSION.SDK_INT < CompanionDevices.PRESENCE_API) return false
    val manager = manager ?: return false
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA && association.id != null) {
        val request = ObservingDevicePresenceRequest.Builder().setAssociationId(association.id).build()
        if (observe) manager.startObservingDevicePresence(request) else manager.stopObservingDevicePresence(request)
      } else {
        @Suppress("DEPRECATION")
        if (observe) {
          manager.startObservingDevicePresence(association.address)
        } else {
          manager.stopObservingDevicePresence(association.address)
        }
      }
      true
    } catch (error: Exception) {
      // DeviceNotAssociatedException once it was removed in the system settings; SecurityException.
      BleLogger.logcat(LogLevel.WARN, "companion presence of ${association.address}: ${error.message}")
      false
    }
  }

  private fun filters(spec: CompanionFilterSpec): List<BluetoothLeDeviceFilter> {
    val scanFilters = spec.services.map { ScanFilter.Builder().setServiceUuid(ParcelUuid(it)).build() }
      .ifEmpty { listOf(null) }
    return scanFilters.map { scanFilter ->
      BluetoothLeDeviceFilter.Builder().apply {
        scanFilter?.let(::setScanFilter)
        spec.namePattern?.let(::setNamePattern)
      }.build()
    }
  }

  private fun isDeclared(service: Class<*>): Boolean = try {
    val component = ComponentName(context, service)
    val info =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.packageManager.getServiceInfo(component, PackageManager.ComponentInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        context.packageManager.getServiceInfo(component, 0)
      }
    info.permission == BIND_PERMISSION
  } catch (_: PackageManager.NameNotFoundException) {
    false
  }

  private fun packageInfo(flags: Int): PackageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(flags.toLong()))
  } else {
    @Suppress("DEPRECATION")
    context.packageManager.getPackageInfo(context.packageName, flags)
  }

  companion object {
    const val BIND_PERMISSION = "android.permission.BIND_COMPANION_DEVICE_SERVICE"
  }
}
