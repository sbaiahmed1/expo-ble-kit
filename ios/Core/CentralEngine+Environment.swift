import CoreBluetooth
import Foundation

extension CentralEngine {
  /// What the engine reads from the system. Injected so tests can script it.
  struct Environment {
    /// `CBManager.authorization`. Reading it never shows the prompt.
    var authorization: () -> CBManagerAuthorization
    /// The app's Info.plist.
    var infoDictionary: () -> [String: Any]?
    var makeCentral: CentralManagerFactory

    static let live = Environment(
      authorization: { CBManager.authorization },
      infoDictionary: { Bundle.main.infoDictionary },
      makeCentral: CBCentralManagerAdapter.factory
    )
  }
}
