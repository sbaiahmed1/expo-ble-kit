import type { ExpoBleKitModuleEvents } from '../ExpoBleKit.types';
import { BleError, BleErrorCode } from '../errors';
import { WebPeripheral, type WebPeripheralHost } from './WebPeripheral';
import { Emitter } from '../internal/emitter';
import type {
  NativeBleKitPort,
  NativeDiagnostics,
  NativeGattServerPort,
  NativeL2CAPServerPort,
} from '../internal/port';
import type { NativeScanOptions } from '../internal/scanOptions';
import type { Scheduler } from '../internal/scheduler';
import type { BlePermissions, BleState, LogLevel } from '../types';
import type { WebBluetooth, WebBluetoothDevice } from './bluetooth';
import { chooserOptions, pickedResult } from './chooser';
import { fromWebError } from './errors';

const LEVELS: LogLevel[] = ['none', 'error', 'warn', 'info', 'debug', 'verbose'];

const fail = (code: BleErrorCode, message: string) => new BleError(code, message);

/**
 * The central subset of the port over Web Bluetooth (P6-02, plan §4.6). A scan opens the browser's
 * device chooser; the picked device is the scan's one result, and the page may then connect to it,
 * discover the services the scan named, read, write and subscribe. The peripheral role, L2CAP,
 * RSSI, MTU and background work aren't available in browsers and reject with NOT_SUPPORTED.
 *
 * State: `unsupported` without Web Bluetooth, else `poweredOn` while the browser reports Bluetooth
 * available (`getAvailability`), `poweredOff` when it doesn't, `unknown` until it answered.
 */
export class WebBluetoothAdapter implements NativeBleKitPort, WebPeripheralHost {
  private state: BleState;
  private readonly emitter = new Emitter<ExpoBleKitModuleEvents>();
  private readonly devices = new Map<string, WebBluetoothDevice>();
  private readonly peripherals = new Map<string, WebPeripheral>();
  /** Scan sessions whose chooser is open; stopping one leaves the chooser, but drops its pick. */
  private readonly sessions = new Set<number>();
  private logLevel: LogLevel = 'warn';
  private logForwarding = false;

  constructor(
    private readonly bluetooth: WebBluetooth | null,
    readonly scheduler: Scheduler
  ) {
    this.state = bluetooth ? 'unknown' : 'unsupported';
    if (!bluetooth) return;
    const update = (available: boolean) => this.setState(available ? 'poweredOn' : 'poweredOff');
    bluetooth.getAvailability().then(update, () => this.setState('unsupported'));
    bluetooth.addEventListener('availabilitychanged', (event) => {
      update((event as Event & { value?: boolean }).value === true);
    });
  }

  getState(): BleState {
    return this.state;
  }

  addListener<E extends keyof ExpoBleKitModuleEvents>(
    event: E,
    listener: ExpoBleKitModuleEvents[E]
  ) {
    return this.emitter.addListener(event, listener);
  }

  /** The chooser is the browser's consent for each device: scanning and connecting need nothing more. */
  async getPermissionsAsync(): Promise<BlePermissions> {
    const usable = this.bluetooth ? 'granted' : 'denied';
    return {
      scan: usable,
      connect: usable,
      advertise: 'denied',
      backgroundScan: 'denied',
      canAskAgain: false,
    };
  }

  requestPermissionsAsync(): Promise<BlePermissions> {
    return this.getPermissionsAsync();
  }

  /**
   * Opens the chooser at once, so the browser still counts the tap that started the scan (it
   * refuses the chooser without one). Closing the chooser ends the session with OPERATION_CANCELLED.
   */
  startScan(sessionId: number, options: NativeScanOptions): Promise<void> {
    const precondition = this.adapterError();
    if (precondition) return Promise.reject(precondition);
    const bluetooth = this.bluetooth!;
    this.sessions.add(sessionId);
    bluetooth.requestDevice(chooserOptions(options)).then(
      (device) => {
        this.devices.set(device.id, device);
        if (!this.sessions.has(sessionId)) return;
        this.emitter.emit('scanResults', { sessionId, results: [pickedResult(device)] });
      },
      (error) => {
        if (!this.sessions.delete(sessionId)) return;
        const ended =
          (error as { name?: unknown } | null)?.name === 'NotFoundError'
            ? fail(BleErrorCode.OPERATION_CANCELLED, 'The device chooser was closed without a pick')
            : fromWebError(error, { fallback: BleErrorCode.SCAN_FAILED });
        this.emitter.emit('scanError', { sessionId, code: ended.code, message: ended.message });
      }
    );
    return Promise.resolve();
  }

  async stopScan(sessionId: number): Promise<void> {
    this.sessions.delete(sessionId);
  }

  getPeripheral(id: string): WebPeripheral {
    let peripheral = this.peripherals.get(id);
    if (!peripheral) {
      peripheral = new WebPeripheral(id, this);
      this.peripherals.set(id, peripheral);
    }
    return peripheral;
  }

  /** Devices picked in this page, and those the browser allowed earlier where it lists them. */
  async getKnownPeripherals(ids: string[]): Promise<string[]> {
    if (this.bluetooth?.getDevices) {
      const allowed = await this.bluetooth.getDevices().catch(() => []);
      allowed.forEach((device) => this.devices.set(device.id, device));
    }
    return ids.filter((id) => this.devices.has(id));
  }

  async getSystemConnectedPeripherals(): Promise<string[]> {
    throw fail(BleErrorCode.NOT_SUPPORTED, "Browsers don't list the system's connections");
  }

  async getDiagnosticsAsync(): Promise<NativeDiagnostics> {
    return {
      state: this.state,
      sessions: [...this.peripherals.values()].map((peripheral) => ({
        id: peripheral.id,
        state: peripheral.state,
        queueDepth: peripheral.queueDepth,
        subscriptions: peripheral.subscriptionCount,
      })),
    };
  }

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  setLogForwarding(enabled: boolean): void {
    this.logForwarding = enabled;
  }

  async openGattServer(): Promise<NativeGattServerPort> {
    throw fail(BleErrorCode.NOT_SUPPORTED, "Browsers can't run a GATT server");
  }

  async startAdvertising(): Promise<number> {
    throw fail(BleErrorCode.NOT_SUPPORTED, "Browsers can't advertise");
  }

  async stopAdvertising(): Promise<void> {}

  async publishL2CAPChannel(): Promise<NativeL2CAPServerPort> {
    throw fail(BleErrorCode.NOT_SUPPORTED, "Browsers can't publish L2CAP channels");
  }

  // WebPeripheralHost

  device(id: string): WebBluetoothDevice | undefined {
    return this.devices.get(id);
  }

  adapterError(): BleError | null {
    switch (this.state) {
      case 'unsupported':
        return fail(
          BleErrorCode.BLUETOOTH_UNSUPPORTED,
          'This browser has no Web Bluetooth (Chrome and Edge on desktop and Android have it, over HTTPS or localhost)'
        );
      case 'poweredOff':
        return fail(
          BleErrorCode.BLUETOOTH_POWERED_OFF,
          'The browser reports Bluetooth unavailable'
        );
      default:
        return null;
    }
  }

  log(level: LogLevel, message: string, peripheralId?: string, opId?: number): void {
    if (!this.logForwarding || level === 'none') return;
    if (LEVELS.indexOf(level) > LEVELS.indexOf(this.logLevel)) return;
    this.emitter.emit('log', { level, message, timestamp: Date.now(), peripheralId, opId });
  }

  warn(code: BleErrorCode, message: string): void {
    this.log('warn', `${code}: ${message}`);
    this.emitter.emit('warning', { code, message });
  }

  private setState(state: BleState): void {
    if (state === this.state) return;
    this.state = state;
    this.emitter.emit('stateChange', { state });
  }
}
