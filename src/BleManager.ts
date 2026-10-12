import { Platform } from 'react-native';

import { AdvertisementImpl } from './Advertiser';
import type { LogEvent, ScanErrorEvent, ScanResultsEvent } from './ExpoBleKit.types';
import { GattServerImpl } from './GattServer';
import { L2CAPServerImpl, validateSecure } from './L2CAPChannel';
import { PeripheralImpl } from './Peripheral';
import { BleError, BleErrorCode } from './errors';
import { DEFAULT_PICKER_TIMEOUT_MS, toNativePickerItems } from './internal/accessoryPicker';
import { toNativeAdvertising } from './internal/advertising';
import { checkTaskName, toNativeBackgroundTaskOptions } from './internal/backgroundTask';
import { toNativeServices } from './internal/gattServer';
import { checkLogLevel, deliver, setHandler, setLevel } from './internal/log';
import { getNativeModule } from './internal/native';
import {
  abortedError,
  checkSignal,
  guard,
  recentErrors,
  reportListenerError,
  toBleError,
} from './internal/operations';
import type { NativePeripheralPort } from './internal/port';
import { toNativeScanOptions } from './internal/scanOptions';
import type {
  BleManagerApi,
  BlePermissionRequest,
  BlePermissions,
  BleState,
  Diagnostics,
  ForegroundServiceNotification,
  LogEntry,
  Peripheral,
  ScanOptions,
  ScanResult,
  ScanSession,
  Subscription,
} from './types';
import { normalizeUUID, type UUID } from './uuid';

let nextScanSessionId = 1;

/** One JS object per native handle, so getPeripheral(id) returns the same object (plan §5.2). */
const peripherals = new WeakMap<NativePeripheralPort, PeripheralImpl>();

function peripheralFor(native: NativePeripheralPort): Peripheral {
  let peripheral = peripherals.get(native);
  if (!peripheral) {
    peripheral = new PeripheralImpl(native);
    peripherals.set(native, peripheral);
  }
  return peripheral;
}

function invalid(option: string, problem: string): BleError {
  return new BleError(BleErrorCode.INVALID_ARGUMENT, `Invalid ${option}: ${problem}`);
}

const NOTIFICATION_FIELDS = ['title', 'text', 'channelName', 'smallIcon'] as const;

/** Each field a non-empty string or left out; validated on every platform. */
function checkNotification(
  notification: ForegroundServiceNotification
): ForegroundServiceNotification {
  if (typeof notification !== 'object' || notification === null) {
    throw invalid('notification', 'expected an object');
  }
  const checked: ForegroundServiceNotification = {};
  for (const field of NOTIFICATION_FIELDS) {
    const value: unknown = notification[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw invalid(`notification.${field}`, 'expected a non-empty string');
    }
    checked[field] = value;
  }
  return checked;
}

const PERMISSION_FLAGS = ['scan', 'connect', 'advertise', 'backgroundScan'] as const;

function checkPermissionRequest(request: BlePermissionRequest | undefined): void {
  if (request === undefined) {
    return;
  }
  if (typeof request !== 'object' || request === null) {
    throw invalid('request', 'expected an object');
  }
  for (const flag of PERMISSION_FLAGS) {
    if (request[flag] !== undefined && typeof request[flag] !== 'boolean') {
      throw invalid(`request.${flag}`, 'expected a boolean');
    }
  }
}

/** The native `log` subscription while an app handler is set (plan §4.16). */
let logSubscription: Subscription | null = null;

/** A native log line as a `LogEntry`, without the fields native left empty. */
function toLogEntry({ level, message, timestamp, peripheralId, opId }: LogEvent): LogEntry {
  return {
    level,
    message,
    timestamp,
    ...(peripheralId != null && { peripheralId }),
    ...(opId != null && { opId }),
  };
}

/** Shown in getDiagnostics() when the permissions can't be read (the error is in recentErrors). */
const UNREADABLE_PERMISSIONS: BlePermissions = {
  scan: 'undetermined',
  connect: 'undetermined',
  advertise: 'undetermined',
  backgroundScan: 'undetermined',
  canAskAgain: false,
};

function startScan(
  options: ScanOptions,
  onResults: (results: ScanResult[]) => void,
  onError?: (error: BleError) => void
): ScanSession {
  if (typeof onResults !== 'function') {
    throw invalid('onResults', 'expected a function');
  }
  if (onError !== undefined && typeof onError !== 'function') {
    throw invalid('onError', 'expected a function');
  }
  const nativeOptions = toNativeScanOptions(options);
  const module = getNativeModule();
  const sessionId = nextScanSessionId++;
  let active = true;
  const listeners: Subscription[] = [];
  const end = (error: BleError | null) => {
    if (!active) {
      return;
    }
    active = false;
    listeners.forEach((listener) => listener.remove());
    if (error && onError) {
      onError(error);
    }
  };
  // Listening starts before the session, so no result is missed.
  listeners.push(
    module.addListener('scanResults', (event: ScanResultsEvent) => {
      if (active && event.sessionId === sessionId) {
        try {
          onResults(event.results);
        } catch (error) {
          reportListenerError(error);
        }
      }
    }),
    module.addListener('scanError', (event: ScanErrorEvent) => {
      if (event.sessionId === sessionId) {
        end(toBleError(event));
      }
    })
  );
  module.startScan(sessionId, nativeOptions).catch((error) => end(toBleError(error)));
  return {
    get active() {
      return active;
    },
    stop() {
      if (active) {
        end(null);
        // Native calls run in order, so this stop never overtakes its start.
        module.stopScan(sessionId).catch(() => {});
      }
    },
  };
}

type ScanForOptions = Parameters<BleManagerApi['scanFor']>[0];

function scanFor(options: ScanForOptions): Promise<ScanResult | null> {
  return guard(
    () =>
      new Promise<ScanResult | null>((resolve, reject) => {
        const { timeoutMs, match, signal: signalOption, ...scanOptions } = options ?? {};
        if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          throw invalid('timeoutMs', 'expected a number of milliseconds above 0');
        }
        if (match !== undefined && typeof match !== 'function') {
          throw invalid('match', 'expected a function');
        }
        const signal = checkSignal(signalOption);
        if (signal?.aborted) {
          throw abortedError();
        }
        let finished = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => finish(() => reject(abortedError()));
        const finish = (settle: () => void) => {
          if (finished) {
            return;
          }
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          session.stop();
          settle();
        };
        const session = startScan(
          scanOptions,
          (results) => {
            try {
              const found = results.find((result) => !match || match(result));
              if (found) {
                finish(() => resolve(found));
              }
            } catch (error) {
              finish(() => reject(error));
            }
          },
          (error) => finish(() => reject(error))
        );
        timer = setTimeout(() => finish(() => resolve(null)), timeoutMs);
        signal?.addEventListener('abort', onAbort);
      })
  );
}

function getPeripheral(id: string): Peripheral {
  if (typeof id !== 'string' || id.length === 0) {
    throw invalid('id', 'expected a peripheral id');
  }
  return peripheralFor(getNativeModule().getPeripheral(id));
}

/** The manager (plan §5.2): the module-level entry point of the central role. */
export const BleManager: BleManagerApi = {
  get state(): BleState {
    return getNativeModule().getState();
  },

  addStateListener(listener) {
    if (typeof listener !== 'function') {
      throw invalid('listener', 'expected a function');
    }
    return getNativeModule().addListener('stateChange', ({ state }) => listener(state));
  },

  getPermissionsAsync() {
    return guard(() => getNativeModule().getPermissionsAsync());
  },

  requestPermissionsAsync(request) {
    return guard(() => {
      checkPermissionRequest(request);
      return getNativeModule().requestPermissionsAsync(request);
    });
  },

  startScan(options, onResults, onError) {
    try {
      return startScan(options, onResults, onError);
    } catch (error) {
      throw toBleError(error);
    }
  },

  scanFor,

  getPeripheral(id) {
    try {
      return getPeripheral(id);
    } catch (error) {
      throw toBleError(error);
    }
  },

  getKnownPeripherals(ids) {
    return guard(async () => {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        throw invalid('ids', 'expected an array of peripheral ids');
      }
      const known = await getNativeModule().getKnownPeripherals(ids);
      return known.map(getPeripheral);
    });
  },

  getSystemConnectedPeripherals(services: UUID[]) {
    return guard(async () => {
      if (!Array.isArray(services)) {
        throw invalid('services', 'expected an array of UUIDs');
      }
      const uuids = [...new Set(services.map((uuid) => normalizeUUID(uuid)))];
      const connected = await getNativeModule().getSystemConnectedPeripherals(uuids);
      return connected.map(getPeripheral);
    });
  },

  setLogLevel(level) {
    const checked = checkLogLevel(level);
    getNativeModule().setLogLevel(checked);
    setLevel(checked);
  },

  setLogHandler(handler) {
    if (handler !== null && typeof handler !== 'function') {
      throw invalid('handler', 'expected a function or null');
    }
    const module = getNativeModule();
    setHandler(handler);
    if (handler && !logSubscription) {
      logSubscription = module.addListener('log', (event: LogEvent) => deliver(toLogEntry(event)));
    } else if (!handler && logSubscription) {
      logSubscription.remove();
      logSubscription = null;
    }
    module.setLogForwarding(handler !== null);
  },

  getDiagnostics() {
    return guard(async (): Promise<Diagnostics> => {
      const module = getNativeModule();
      const [native, permissions] = await Promise.all([
        module.getDiagnosticsAsync(),
        module.getPermissionsAsync().catch((error) => {
          toBleError(error);
          return UNREADABLE_PERMISSIONS;
        }),
      ]);
      return {
        state: native.state,
        permissions,
        sessions: native.sessions,
        recentErrors: recentErrors(),
        ...(native.android && { android: native.android }),
        ...(native.ios && { ios: native.ios }),
      };
    });
  },

  openGattServer(services) {
    return guard(async () => {
      const definitions = toNativeServices(services);
      return new GattServerImpl(await getNativeModule().openGattServer(definitions));
    });
  },

  startAdvertising(data, options) {
    return guard(async () => {
      const native = toNativeAdvertising(data, options);
      const module = getNativeModule();
      const id = await module.startAdvertising(native.data, native.options);
      return new AdvertisementImpl(module, id);
    });
  },

  publishL2CAPChannel(options) {
    return guard(async () => {
      if (options !== undefined && (typeof options !== 'object' || options === null)) {
        throw new BleError(BleErrorCode.INVALID_ARGUMENT, 'Invalid options: expected an object');
      }
      const secure = validateSecure('secure', options?.secure);
      return new L2CAPServerImpl(await getNativeModule().publishL2CAPChannel(secure));
    });
  },

  registerBackgroundTask(taskName, options) {
    return guard(async () => {
      const name = checkTaskName(taskName);
      const native = toNativeBackgroundTaskOptions(options);
      const module = getNativeModule();
      if (!module.registerBackgroundTask) {
        throw new BleError(
          BleErrorCode.NOT_SUPPORTED,
          "This platform doesn't run background tasks"
        );
      }
      await module.registerBackgroundTask(name, native);
    });
  },

  unregisterBackgroundTask(taskName) {
    return guard(async () => {
      const name = checkTaskName(taskName);
      if (Platform.OS !== 'android' && Platform.OS !== 'ios') return;
      await getNativeModule().unregisterBackgroundTask?.(name);
    });
  },

  ios: {
    showAccessoryPicker(items, options) {
      return guard(async () => {
        const module = getNativeModule();
        if (Platform.OS !== 'ios' || !module.showAccessoryPicker) {
          throw new BleError(BleErrorCode.NOT_SUPPORTED, 'The accessory picker is iOS-only');
        }
        const native = toNativePickerItems(items);
        const timeoutMs = options?.timeoutMs ?? DEFAULT_PICKER_TIMEOUT_MS;
        if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          throw new BleError(
            BleErrorCode.INVALID_ARGUMENT,
            'Invalid timeoutMs: expected milliseconds above 0'
          );
        }
        const id = await module.showAccessoryPicker(native, timeoutMs);
        return id === null ? null : BleManager.getPeripheral(id);
      });
    },
  },
  android: {
    setForegroundServiceNotification(notification) {
      const checked = checkNotification(notification);
      if (Platform.OS === 'android') getNativeModule().setForegroundServiceNotification?.(checked);
    },
  },
};
