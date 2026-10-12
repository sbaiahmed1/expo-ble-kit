package expo.modules.blekit.core

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.provider.Settings

/** Reads the app's declared and granted permissions from the system. */
class AndroidPermissionSystem(private val context: Context) : PermissionSystem {
  override val sdkInt: Int = Build.VERSION.SDK_INT

  // The installed manifest can't change while the process runs.
  private val declared: DeclaredPermissions by lazy(::readDeclaredPermissions)

  override fun declaredPermissions(): DeclaredPermissions = declared

  override fun isGranted(permission: String): Boolean =
    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  /** Whether location services are on: Android 11 (API 30) and older need them to scan (plan §4.13). */
  fun isLocationEnabled(): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
    context.getSystemService(LocationManager::class.java)?.isLocationEnabled ?: false
  } else {
    @Suppress("DEPRECATION")
    Settings.Secure.getInt(
      context.contentResolver,
      Settings.Secure.LOCATION_MODE,
      Settings.Secure.LOCATION_MODE_OFF,
    ) !=
      Settings.Secure.LOCATION_MODE_OFF
  }

  private fun readDeclaredPermissions(): DeclaredPermissions {
    val packageManager = context.packageManager
    val info =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        packageManager.getPackageInfo(
          context.packageName,
          PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong()),
        )
      } else {
        @Suppress("DEPRECATION")
        packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
      }
    val names = info.requestedPermissions?.toList().orEmpty()
    val scanIndex = names.indexOf(AndroidPermissions.BLUETOOTH_SCAN)
    val scanFlags = info.requestedPermissionsFlags?.getOrNull(scanIndex) ?: 0
    val neverForLocation =
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
        (scanFlags and PackageInfo.REQUESTED_PERMISSION_NEVER_FOR_LOCATION) != 0
    return DeclaredPermissions(names.toSet(), neverForLocation)
  }
}
