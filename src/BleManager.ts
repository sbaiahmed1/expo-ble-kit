import type { ScanErrorEvent, ScanResultsEvent } from './ExpoBleKit.types';
import { PeripheralImpl } from './Peripheral';
import { BleError, BleErrorCode } from './errors';
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
      };
    });
  },
};
