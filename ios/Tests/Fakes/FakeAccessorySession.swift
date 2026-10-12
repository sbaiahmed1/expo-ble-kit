import Foundation
@testable import BleKitCore

/// `AccessorySessionLike` for tests: records calls; the test sends the session's events.
final class FakeAccessorySession: AccessorySessionLike {
  private(set) var activations = 0
  private(set) var shown: [[AccessoryPickerItemSpec]] = []
  private(set) var invalidated = false
  private var handler: ((AccessorySessionEvent) -> Void)?
  private var completion: ((AccessoryPickerFailure?) -> Void)?

  func activate(on queue: DispatchQueue, eventHandler: @escaping (AccessorySessionEvent) -> Void) {
    activations += 1
    handler = eventHandler
  }

  func showPicker(for items: [AccessoryPickerItemSpec], completion: @escaping (AccessoryPickerFailure?) -> Void) {
    shown.append(items)
    self.completion = completion
  }

  func invalidate() {
    invalidated = true
  }

  func send(_ event: AccessorySessionEvent) {
    handler?(event)
  }

  func complete(_ failure: AccessoryPickerFailure? = nil) {
    completion?(failure)
  }
}
