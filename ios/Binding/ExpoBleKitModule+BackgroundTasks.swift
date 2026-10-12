import ExpoModulesCore

// Background tasks on iOS (P3-02, plan §4.14): TaskManager runs the app's JS task with the events
// it asked for, through `BackgroundTaskConsumer`.

extension ExpoBleKitModule {
  func registerBackgroundTask(_ taskName: String, _ options: [String: Any], _ promise: Promise) {
    do {
      let taskManager = try backgroundTaskManager()
      try EXUtilities.catchException {
        taskManager.registerTask(withName: taskName, consumer: BackgroundTaskConsumer.self, options: options)
      }
      promise.resolve(nil)
    } catch let error as BleKitException {
      promise.reject(error)
    } catch {
      promise.reject(BleKitException(CoreError(.internal, "Registering the background task failed: \(error)")))
    }
  }

  func unregisterBackgroundTask(_ taskName: String, _ promise: Promise) {
    guard let taskManager = taskManager(), taskManager.hasRegisteredTask(withName: taskName),
          taskManager.task(withName: taskName, hasConsumerOf: BackgroundTaskConsumer.self)
    else {
      return promise.resolve(nil)
    }
    do {
      try EXUtilities.catchException {
        taskManager.unregisterTask(withName: taskName, consumerClass: BackgroundTaskConsumer.self)
      }
      promise.resolve(nil)
    } catch {
      promise.reject(BleKitException(CoreError(.internal, "Unregistering the background task failed: \(error)")))
    }
  }

  /// TaskManager, when the app can receive background events: restoration declared, and
  /// expo-task-manager installed.
  private func backgroundTaskManager() throws -> EXTaskManagerInterface {
    guard BleKitRuntime.shared.restorationEnabled else {
      throw BleKitException(CoreError(
        .misconfigured,
        "Background events need state restoration: set ios.restoreIdentifier and ios.backgroundModes "
          + "['central'] in the expo-ble-kit config plugin options (\(CoreError.setupGuide))"
      ))
    }
    guard let taskManager = taskManager() else {
      throw BleKitException(CoreError(
        .misconfigured,
        "Background tasks need expo-task-manager: npx expo install expo-task-manager, then rebuild the app"
      ))
    }
    return taskManager
  }

  private func taskManager() -> EXTaskManagerInterface? {
    appContext?.moduleRegistry.get(moduleWithName: "ExpoTaskManager") as? EXTaskManagerInterface
  }
}
