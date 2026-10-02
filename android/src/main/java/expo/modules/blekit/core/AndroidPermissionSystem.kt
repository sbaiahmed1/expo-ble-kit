package expo.modules.blekit.core

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build

/** Reads the app's declared and granted permissions from the system. */
class AndroidPermissionSystem(private val context: Context) : PermissionSystem {
  override val sdkInt: Int = Build.VERSION.SDK_INT

  // The installed manifest can't change while the process runs.
  private val declared: DeclaredPermissions by lazy(::readDeclaredPermissions)

  override fun declaredPermissions(): DeclaredPermissions = declared

  override fun isGranted(permission: String): Boolean =
    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

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
