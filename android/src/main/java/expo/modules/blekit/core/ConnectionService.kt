package expo.modules.blekit.core

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * The foreground service of type `connectedDevice` that keeps the app process running while a
 * `keepAliveInBackground` connection is open (plan §4.4, §4.14). It holds no Bluetooth state:
 * [AndroidKeepAlive] starts and stops it as the engine's keep-alive sessions come and go.
 *
 * Declared by the config plugin (`android.foregroundService`), never by the library manifest.
 * Android calls it on the main thread; it only shows the notification.
 */
class ConnectionService : Service() {
  private var generation = 0
  private var failed = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    generation = intent?.getIntExtra(EXTRA_GENERATION, 0) ?: 0
    try {
      val notification = build(this, AndroidKeepAlive.notification)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (error: Exception) {
      // Android 12+ refuses a start from the background (ForegroundServiceStartNotAllowedException),
      // Android 14+ one without a granted Bluetooth permission (SecurityException).
      failed = true
      AndroidKeepAlive.report(
        generation,
        CoreError(
          CoreError.Code.FOREGROUND_SERVICE_FAILED,
          "Android didn't let the foreground service start, so the connection isn't kept alive in the " +
            "background (${error.javaClass.simpleName}: ${error.message})",
        ),
      )
      stopSelf()
    }
    // After the process dies there is no connection to keep: don't restart.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    if (!failed) AndroidKeepAlive.report(generation, null)
    super.onDestroy()
  }

  companion object {
    const val NOTIFICATION_ID = 0x0b1e
    const val CHANNEL_ID = "expo-ble-kit.connections"
    const val EXTRA_GENERATION = "expo.modules.blekit.generation"
    const val DEFAULT_TEXT = "Keeping Bluetooth connections open"
    const val DEFAULT_CHANNEL_NAME = "Bluetooth connections"

    /** The notification for [config]: the app's name and icon unless set, opening the app on tap. */
    fun build(context: Context, config: KeepAliveNotification): Notification {
      val manager = context.getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(
        NotificationChannel(
          CHANNEL_ID,
          config.channelName ?: DEFAULT_CHANNEL_NAME,
          NotificationManager.IMPORTANCE_LOW,
        ),
      )
      val app = context.applicationInfo
      val icon = config.smallIcon
        ?.let { context.resources.getIdentifier(it, "drawable", context.packageName) }
        ?.takeIf { it != 0 }
        ?: app.icon
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      return Notification.Builder(context, CHANNEL_ID)
        .setContentTitle(config.title ?: context.packageManager.getApplicationLabel(app))
        .setContentText(config.text ?: DEFAULT_TEXT)
        .setSmallIcon(icon)
        .setOngoing(true)
        .setCategory(Notification.CATEGORY_SERVICE)
        .setContentIntent(launch)
        .apply {
          // Shown at once: the user should see why the app keeps running.
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
          }
        }
        .build()
    }
  }
}
