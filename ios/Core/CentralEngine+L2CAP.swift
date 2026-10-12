import CoreBluetooth
import Foundation

// L2CAP channels to connected peripherals (plan §5.5 L2CAP rules, P5-03).

extension CentralEngine {
  /// The LE PSM range (Core spec Vol 3 Part A 4.22).
  static let l2capPsms = 1...255

  /// Opens an L2CAP channel to `psm` on a ready connection; DISCONNECTED otherwise.
  func openL2CAPChannel(
    _ peripheralId: String,
    psm: Int,
    timeout: TimeInterval?,
    operationId: Int?,
    completion: @escaping (Result<L2CAPChannel, CoreError>) -> Void
  ) {
    guard Self.l2capPsms.contains(psm) else {
      return completion(.failure(CoreError(.invalidArgument, "Invalid PSM \(psm)")))
    }
    session(peripheralId, else: completion)?
      .openL2CAPChannel(psm: CBL2CAPPSM(psm), timeout: timeout, operationId: operationId, completion: completion)
  }
}
