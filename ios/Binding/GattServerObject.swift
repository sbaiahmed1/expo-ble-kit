import CoreBluetooth
import ExpoModulesCore

/// The JS handle of the GATT server (plan §4.5, P4-01), with events `readRequest`, `writeRequest`
/// and `subscriptionChange`. Holds no BLE state: `server` does, on the peripheral queue.
final class GattServerObject: SharedObject, GattServerListener, @unchecked Sendable {
  /// Nil once closed. Touched on the peripheral queue only.
  var server: GattServer?
  /// Where warnings go: the log and the module's `warning` event.
  var onWarning: ((CoreError) -> Void)?

  func gattServer(_ server: GattServer, readRequest id: Int, central: UUID, characteristic: CBUUID, offset: Int) {
    let event = ServerRequestEventRecord()
    event.requestId = id
    event.centralId = central.uuidString
    event.characteristic = characteristic.uuidString.lowercased()
    event.offset = offset
    emit(event: "readRequest", payload: event)
  }

  // swiftlint:disable:next function_parameter_count
  func gattServer(
    _ server: GattServer,
    writeRequest id: Int,
    central: UUID,
    characteristic: CBUUID,
    offset: Int,
    value: Data,
    withResponse: Bool
  ) {
    let event = ServerRequestEventRecord()
    event.requestId = id
    event.centralId = central.uuidString
    event.characteristic = characteristic.uuidString.lowercased()
    event.offset = offset
    event.value = value
    event.withResponse = withResponse
    emit(event: "writeRequest", payload: event)
  }

  func gattServer(_ server: GattServer, central: UUID, characteristic: CBUUID, subscribed: Bool) {
    let event = SubscriptionChangeEventRecord()
    event.centralId = central.uuidString
    event.characteristic = characteristic.uuidString.lowercased()
    event.subscribed = subscribed
    emit(event: "subscriptionChange", payload: event)
  }

  func gattServer(_ server: GattServer, warning: CoreError) {
    onWarning?(warning)
  }
}

/// Payload of `readRequest` (no value) and `writeRequest`.
struct ServerRequestEventRecord: Record {
  @Field var requestId: Int = 0
  @Field var centralId: String = ""
  @Field var characteristic: String = ""
  @Field var offset: Int = 0
  @Field var value: Data?
  @Field var withResponse: Bool = true
}

struct SubscriptionChangeEventRecord: Record {
  @Field var centralId: String = ""
  @Field var characteristic: String = ""
  @Field var subscribed: Bool = false
}

/// JS `ServiceDefinition`, validated and normalized by the TS layer (plan §5.5).
struct ServerServiceRecord: Record {
  @Field var uuid: String = ""
  @Field var primary: Bool = true
  @Field var characteristics: [ServerCharacteristicRecord] = []

  func spec() throws -> ServerServiceSpec {
    ServerServiceSpec(
      uuid: CBUUID(string: uuid),
      primary: primary,
      characteristics: try characteristics.map { try $0.spec() }
    )
  }
}

struct ServerDescriptorRecord: Record {
  @Field var uuid: String = ""
  @Field var value: Data = Data()
}

struct ServerCharacteristicRecord: Record {
  @Field var uuid: String = ""
  @Field var properties: [String] = []
  @Field var permissions: [String] = []
  @Field var value: Data?
  @Field var descriptors: [ServerDescriptorRecord] = []

  private static let propertyValues: [String: CBCharacteristicProperties] = [
    "read": .read,
    "write": .write,
    "writeWithoutResponse": .writeWithoutResponse,
    "notify": .notify,
    "indicate": .indicate
  ]
  private static let permissionValues: [String: CBAttributePermissions] = [
    "readable": .readable,
    "writeable": .writeable,
    "readEncryptionRequired": .readEncryptionRequired,
    "writeEncryptionRequired": .writeEncryptionRequired
  ]

  func spec() throws -> ServerCharacteristicSpec {
    var propertySet: CBCharacteristicProperties = []
    for name in properties {
      guard let property = Self.propertyValues[name] else {
        throw BleKitException(CoreError(.invalidArgument, "Unsupported characteristic property \(name)"))
      }
      propertySet.insert(property)
    }
    var permissionSet: CBAttributePermissions = []
    for name in permissions {
      guard let permission = Self.permissionValues[name] else {
        throw BleKitException(CoreError(.invalidArgument, "Unknown attribute permission \(name)"))
      }
      permissionSet.insert(permission)
    }
    return ServerCharacteristicSpec(
      uuid: CBUUID(string: uuid),
      properties: propertySet,
      permissions: permissionSet,
      value: value,
      descriptors: descriptors.map { ServerDescriptorSpec(uuid: CBUUID(string: $0.uuid), value: $0.value) }
    )
  }
}
