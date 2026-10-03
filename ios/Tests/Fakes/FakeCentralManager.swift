import CoreBluetooth
import Foundation
@testable import BleKitCore

/// Scriptable `CentralManaging`. Calls are recorded in `calls`; tests drive callbacks with the
/// `simulate…` helpers.
final class FakeCentralManager: CentralManaging {
  enum Call: Equatable {
    case scan([CBUUID]?)
    case stopScan
    case connect(UUID)
    case cancelConnection(UUID)
  }

  var state: CBManagerState = .unknown
  private(set) var isScanning = false
  weak var delegate: CentralManagingDelegate?
  private(set) var calls: [Call] = []
  private(set) var lastScanOptions: [String: Any]?
  private(set) var lastConnectOptions: [String: Any]?
  /// Peripherals the "system" knows (for retrieve calls).
  var knownPeripherals: [UUID: FakePeripheral] = [:]

  func scanForPeripherals(withServices serviceUUIDs: [CBUUID]?, options: [String: Any]?) {
    calls.append(.scan(serviceUUIDs))
    lastScanOptions = options
    isScanning = true
  }

  func stopScan() {
    calls.append(.stopScan)
    isScanning = false
  }

  func connect(_ peripheral: PeripheralLike, options: [String: Any]?) {
    calls.append(.connect(peripheral.identifier))
    lastConnectOptions = options
    if let fake = peripheral as? FakePeripheral {
      fake.state = .connecting
    }
  }

  func cancelPeripheralConnection(_ peripheral: PeripheralLike) {
    calls.append(.cancelConnection(peripheral.identifier))
  }

  func retrievePeripherals(withIdentifiers identifiers: [UUID]) -> [PeripheralLike] {
    identifiers.compactMap { knownPeripherals[$0] }
  }

  func retrieveConnectedPeripherals(withServices serviceUUIDs: [CBUUID]) -> [PeripheralLike] {
    knownPeripherals.values.filter { peripheral in
      peripheral.state == .connected && peripheral.services.contains { serviceUUIDs.contains($0.uuid) }
    }
  }

  // MARK: Test drivers

  func simulateState(_ newState: CBManagerState) {
    state = newState
    if newState != .poweredOn {
      isScanning = false
    }
    delegate?.centralDidUpdateState(self)
  }

  func simulateDiscovery(of peripheral: FakePeripheral, advertisementData: [String: Any] = [:], rssi: Int = -60) {
    knownPeripherals[peripheral.identifier] = peripheral
    delegate?.central(self, didDiscover: peripheral, advertisementData: advertisementData, rssi: rssi)
  }

  func simulateConnection(of peripheral: FakePeripheral) {
    peripheral.state = .connected
    delegate?.central(self, didConnect: peripheral)
  }

  func simulateConnectionFailure(of peripheral: FakePeripheral, error: Error?) {
    peripheral.state = .disconnected
    delegate?.central(self, didFailToConnect: peripheral, error: error)
  }

  func simulateDisconnection(of peripheral: FakePeripheral, isReconnecting: Bool = false, error: Error? = nil) {
    peripheral.state = isReconnecting ? .connecting : .disconnected
    delegate?.central(self, didDisconnect: peripheral, isReconnecting: isReconnecting, error: error)
  }
}
