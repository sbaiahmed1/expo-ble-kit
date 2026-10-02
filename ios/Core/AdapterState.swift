import CoreBluetooth
import Foundation

/// JS `BleState` (plan §5.1). iOS maps `CBManagerState` one to one (plan §4.8).
enum BleState: String {
  case unknown
  case resetting
  case unsupported
  case unauthorized
  case poweredOff
  case poweredOn

  init(_ state: CBManagerState) {
    switch state {
    case .resetting:
      self = .resetting
    case .unsupported:
      self = .unsupported
    case .unauthorized:
      self = .unauthorized
    case .poweredOff:
      self = .poweredOff
    case .poweredOn:
      self = .poweredOn
    default:
      self = .unknown
    }
  }
}

/// JS `PermissionStatus` (plan §5.1).
enum PermissionStatus: String {
  case granted
  case denied
  case undetermined
}

/// JS `BlePermissions` (plan §5.1). On iOS one authorization covers every capability (plan §4.13).
struct BlePermissions: Equatable {
  let scan: PermissionStatus
  let connect: PermissionStatus
  let advertise: PermissionStatus
  let backgroundScan: PermissionStatus
  let canAskAgain: Bool

  init(authorization: CBManagerAuthorization) {
    let status: PermissionStatus
    switch authorization {
    case .allowedAlways:
      status = .granted
    case .denied, .restricted:
      status = .denied
    default:
      status = .undetermined
    }
    scan = status
    connect = status
    advertise = status
    backgroundScan = status
    // iOS shows the prompt once; after a denial only Settings can change it.
    canAskAgain = status != .denied
  }

  var dictionary: [String: Any] {
    [
      "scan": scan.rawValue,
      "connect": connect.rawValue,
      "advertise": advertise.rawValue,
      "backgroundScan": backgroundScan.rawValue,
      "canAskAgain": canAskAgain
    ]
  }
}
