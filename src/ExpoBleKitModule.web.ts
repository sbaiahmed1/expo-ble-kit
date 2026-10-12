import type { NativeBleKitPort } from './internal/port';
import { timerScheduler } from './internal/scheduler';
import { WebBluetoothAdapter } from './web/WebBluetoothAdapter';
import { webBluetooth } from './web/bluetooth';

// Plan §4.6, P6-02: on the web the port is Web Bluetooth's central subset, in TypeScript.

let adapter: WebBluetoothAdapter | null = null;

export function loadNativeModule(): NativeBleKitPort {
  adapter ??= new WebBluetoothAdapter(webBluetooth(), timerScheduler);
  return adapter;
}
