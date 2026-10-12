# TaskManager persists the consumer class name of each background task and creates it again by
# reflection (Class.forName, the (Context, TaskManagerUtilsInterface) constructor and the static
# VERSION field), in later processes too.
-keep class expo.modules.blekit.binding.BackgroundScanTaskConsumer {
  public <init>(android.content.Context, expo.modules.interfaces.taskManager.TaskManagerUtilsInterface);
  public static final int VERSION;
}
# The foreground service is named in the app's manifest.
-keep class expo.modules.blekit.core.ConnectionService
# The companion presence service is named in the app's manifest.
-keep class expo.modules.blekit.binding.CompanionPresenceService
