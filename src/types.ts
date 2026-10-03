import type { BleError } from './errors';
import type { UUID } from './uuid';

// Public types of plan §5 (central role). Changing them requires updating the plan, docs and tests
// together (Appendix B, rule 8). Members owned by later tasks (logging, the peripheral role,
// background, onboarding, Android-only peripheral calls) land with those tasks.

/**
 * The state of the Bluetooth adapter, as the app sees it.
 *
 * - `unknown`: not known yet. On iOS, until the app is allowed to use Bluetooth and the system
 *   reports a state.
 * - `resetting`: turning on or off, or the stack is restarting.
 * - `unsupported`: the device has no Bluetooth LE.
 * - `unauthorized`: the app isn't allowed to use Bluetooth (iOS), or `BLUETOOTH_CONNECT` isn't
 *   granted (Android 12+).
 * - `poweredOff`: Bluetooth is off.
 * - `poweredOn`: ready to scan and connect.
 */
export type BleState =
  'unknown' | 'resetting' | 'unsupported' | 'unauthorized' | 'poweredOff' | 'poweredOn';

/**
 * Whether a permission is granted. `undetermined` means the user hasn't been asked yet.
 */
export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

/**
 * The state of a connection. `connected` means ready for GATT operations: the link is up and the
 * setup after connecting (service discovery, the Android MTU request, restored subscriptions) is
 * done. `reconnecting` follows an unexpected link loss when `connect()` had a `reconnect` policy:
 * it covers the waits and the attempts, until `connected` again or `disconnected` when it gives up.
 */
export type ConnectionState =
  'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'reconnecting';

/** A Bluetooth LE physical layer: 1M, 2M or Coded (long range). */
export type Phy = 'le1m' | 'le2m' | 'leCoded';

/** Returned by every `add…Listener` function. */
export interface Subscription {
  /** Removes the listener. Synchronous, no I/O, never fails. */
  remove(): void;
}

/** Options every GATT operation takes. */
export interface OpOptions {
  /**
   * How long the operation may take, in milliseconds. It then rejects with `OPERATION_TIMEOUT`.
   * @defaultValue 10000 (30000 for `discover`)
   */
  timeoutMs?: number;
  /**
   * Cancels the operation: a queued one never reaches the radio, a running one rejects at once
   * with `OPERATION_CANCELLED` (the radio finishes it, and the result is dropped).
   */
  signal?: AbortSignal;
}

/** The app's Bluetooth permissions. */
export interface BlePermissions {
  /** Scanning. On Android 12+ `BLUETOOTH_SCAN` (and location when it isn't `neverForLocation`). */
  scan: PermissionStatus;
  /** Connecting and GATT. On Android 12+ `BLUETOOTH_CONNECT`. */
  connect: PermissionStatus;
  /** Advertising (the peripheral role, a later version). `denied` until declared. */
  advertise: PermissionStatus;
  /** Android 10–11: ACCESS_BACKGROUND_LOCATION. Elsewhere mirrors `scan`. */
  backgroundScan: PermissionStatus;
  /** False once the system won't show a prompt again: the user has to change it in Settings. */
  canAskAgain: boolean;
}

/** No flag set means `{ scan: true, connect: true }`. iOS ignores the flags: one prompt covers all. */
export interface BlePermissionRequest {
  /** Ask for the scan permissions. */
  scan?: boolean;
  /** Ask for the connect permission. */
  connect?: boolean;
  /** Ask for the advertise permission (needs the config plugin's advertise option). */
  advertise?: boolean;
  /** Android 10–11: also ask for background location, after the others are granted. */
  backgroundScan?: boolean;
}

/** What to scan for. Every given criterion must match; within a list, any entry may. */
export interface ScanOptions {
  /** Strongly recommended. Required for background scanning on iOS. */
  services?: UUID[];
  /**
   * Report a device every time it advertises, instead of once per scan.
   * @defaultValue false
   */
  allowDuplicates?: boolean;
  /** Batch window for onResults in ms. 0 = deliver immediately (default). */
  reportIntervalMs?: number;
  /** Only devices whose name starts with this. */
  namePrefix?: string;
  /** Only devices with manufacturer data from one of these companies. */
  manufacturerData?: {
    /** The Bluetooth SIG company identifier, for example 0x004C for Apple. */
    companyId: number;
    /** The data must start with these bytes (where `mask` has bits set). */
    data?: Uint8Array;
    /** Which bits of `data` to compare. Same length as `data`. */
    mask?: Uint8Array;
  }[];
  /** Android-only settings. */
  android?: {
    /**
     * Trades battery for speed.
     * @defaultValue 'balanced'
     */
    scanMode?: 'opportunistic' | 'lowPower' | 'balanced' | 'lowLatency';
    /** Which advertisements the system reports. */
    callbackType?: 'allMatches' | 'firstMatch' | 'matchLost';
    /** How many advertisements a match needs. */
    matchMode?: 'aggressive' | 'sticky';
    /**
     * Only legacy advertisements; false also reports extended advertising (Android 8+).
     * @defaultValue true
     */
    legacy?: boolean;
    /** The physical layer to scan on (with `legacy: false`). */
    phy?: 'le1m' | 'leCoded' | 'all';
    /** Hardware batching: the controller holds results for this long. */
    reportDelayMs?: number;
  };
  /** iOS-only settings. */
  ios?: {
    /** Also report devices that solicit these services. */
    solicitedServices?: UUID[];
  };
}

/** One advertisement, as a scan reports it. */
export interface ScanResult {
  /** The peripheral id: a MAC address on Android, a per-app UUID on iOS. Not portable. */
  id: string;
  /** The advertised name, or the name the system knows; null when there is none. */
  name: string | null;
  /** Signal strength in dBm. */
  rssi: number;
  /** The advertised transmit power in dBm, when the device sends it. */
  txPowerLevel: number | null;
  /** Whether the device accepts connections; null when the platform can't tell. */
  isConnectable: boolean | null;
  /** The advertised service UUIDs. */
  serviceUUIDs: UUID[];
  /** Service data, by service UUID. */
  serviceData: Record<UUID, Uint8Array>;
  /** Manufacturer data, by Bluetooth SIG company id. */
  manufacturerData: Record<number, Uint8Array>;
  /** Raw advertising + scan response bytes. Android only; null on iOS. */
  rawAdvertisement: Uint8Array | null;
  /** When it was received, in milliseconds since the Unix epoch (comparable with `Date.now()`). */
  timestamp: number;
}

/** A running scan, from `BleManager.startScan`. */
export interface ScanSession {
  /** False once stopped, or once it ended with an error. */
  readonly active: boolean;
  /** Stops this session; other sessions keep scanning. Calling it again does nothing. */
  stop(): void;
}

/** Options of `Peripheral.connect`. */
export interface ConnectOptions extends Omit<OpOptions, 'timeoutMs'> {
  /**
   * Default 15000. `null` = no timeout: the connect stays pending until the device appears
   * ("connect when in range": iOS pending connect, Android autoConnect). It is still cancelled by
   * disconnect() or `signal`.
   */
  timeoutMs?: number | null;
  /**
   * Discover every service before the connection counts as connected.
   * @defaultValue true
   */
  autoDiscover?: boolean;
  /**
   * Reconnect after the link to a connected device is lost unexpectedly (out of range, peripheral
   * restarted). A failed first connect still rejects. `disconnect()` stops reconnecting.
   * @defaultValue false
   */
  reconnect?: ReconnectPolicy | false;
  /**
   * With `reconnect`: keep the subscriptions and turn their notifications on again before
   * `connected`. One that can't be restored ends (`active` turns false). False ends them all when
   * the link is lost.
   * @defaultValue true
   */
  restoreSubscriptionsOnReconnect?: boolean;
  /**
   * Keep the connection while the app is in the background.
   *
   * Android: runs a foreground service of type `connectedDevice` from this connect until the
   * connection ends (reconnecting keeps it), with a notification set by
   * `BleManager.android.setForegroundServiceNotification`. Needs the config plugin option
   * `android.foregroundService`, otherwise rejects with `MISCONFIGURED`. Android only lets the
   * service start while the app is in the foreground: a refused start sends a
   * `FOREGROUND_SERVICE_FAILED` warning, and the connection goes on without it.
   *
   * iOS: not supported yet (rejects with `NOT_SUPPORTED`); it comes with background modes (P3-01).
   */
  keepAliveInBackground?: boolean;
  /** Android-only options; ignored on iOS. */
  android?: {
    /** Android's background connect. Defaults to true exactly when `timeoutMs` is null. */
    autoConnect?: boolean;
    /**
     * The ATT MTU to ask for after connecting (23–517), or `false` for none.
     * @defaultValue 517
     */
    requestMtu?: number | false;
    /**
     * After this many operations in a row time out, the connection is reset (disconnected and
     * closed, or reconnected with a `reconnect` policy): Android's stack sometimes stops answering.
     * `false` never resets.
     * @defaultValue 2
     */
    resetAfterTimeouts?: number | false;
    /** Preferred physical layers. Not supported yet: a non-empty list rejects. */
    phy?: Phy[];
  };
  /** iOS-only options; ignored on Android. */
  ios?: {
    /**
     * iOS 17+: the system reconnects by itself, also while the app is suspended. Needs `reconnect`,
     * whose waits and attempts then only apply if iOS stops reconnecting. Ignored before iOS 17.
     */
    enableAutoReconnect?: boolean;
    /** Show a system alert when the peripheral disconnects while the app is suspended. */
    notifyOnDisconnection?: boolean;
  };
}

/**
 * How to reconnect after a link loss. Each attempt waits first: `initialDelayMs`, then twice as long
 * after each failure up to `maxDelayMs` (`exponential`), or `initialDelayMs` every time (`fixed`).
 * Each attempt has the connect's `timeoutMs`. On Android the first attempt connects directly and
 * later ones use `autoConnect`.
 */
export interface ReconnectPolicy {
  /**
   * Attempts before giving up; the connection then ends with the last attempt's error.
   * @defaultValue Infinity
   */
  maxAttempts?: number;
  /** @defaultValue 1000 */
  initialDelayMs?: number;
  /** @defaultValue 30000 (or initialDelayMs when that is larger) */
  maxDelayMs?: number;
  /**
   * How the wait grows between attempts.
   * @defaultValue 'exponential'
   */
  backoff?: 'exponential' | 'fixed';
}

/**
 * How much the library logs (plan §4.16), most severe first: `none` logs nothing, `debug` adds one
 * line per GATT operation (op id, kind, status, duration), `verbose` adds values and notifications.
 */
export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug' | 'verbose';

/** One log line, as `BleManager.setLogHandler` receives it. */
export interface LogEntry {
  /** How severe the line is. */
  level: LogLevel;
  /** The text, without the peripheral and op id (they are separate fields). */
  message: string;
  /** Epoch milliseconds. */
  timestamp: number;
  /** The peripheral the line is about. */
  peripheralId?: string;
  /** The GATT operation the line is about (ids count up per connection's queue). */
  opId?: number;
}

/** A snapshot for bug reports, from `BleManager.getDiagnostics()`. */
export interface Diagnostics {
  /** The adapter state. */
  state: BleState;
  /** The permissions (all `undetermined` when they can't be read). */
  permissions: BlePermissions;
  /** One entry per peripheral the app has used. */
  sessions: {
    /** The peripheral id. */
    id: string;
    /** Its connection state. */
    state: ConnectionState;
    /** Operations queued or running on it. */
    queueDepth: number;
    /** Active subscriptions. */
    subscriptions: number;
  }[];
  /** The last 100 errors the API returned, oldest first. */
  recentErrors: BleError[];
  /** Android-only data. */
  android?: {
    /** GATT clients opened and not yet closed. Stable across connect cycles when nothing leaks. */
    openGattClients: number;
    /** Whether the foreground service of `keepAliveInBackground` is running. */
    foregroundService: boolean;
  };
}

/**
 * What a background task receives as `data` (`TaskManager.defineTask`). Delivered so far:
 * `scanResults` on Android. The others arrive with later versions.
 */
export type BleBackgroundEvent =
  | {
      /** iOS relaunched the app for Bluetooth and restored these connections. */
      type: 'restored';
      /** The restored peripherals. */
      peripheralIds: string[];
    }
  | {
      /** A background scan found matching devices. */
      type: 'scanResults';
      /** The advertisements, as a foreground scan reports them. */
      results: ScanResult[];
    }
  | {
      /** A connection changed state while the app was in the background. */
      type: 'connectionStateChange';
      /** The peripheral. */
      peripheralId: string;
      /** Its new state. */
      state: ConnectionState;
    }
  | {
      /** A notification or indication arrived while the app was in the background. */
      type: 'notification';
      /** The peripheral. */
      peripheralId: string;
      /** The service of the characteristic. */
      service: UUID;
      /** The characteristic. */
      characteristic: UUID;
      /** The value. */
      value: Uint8Array;
      /** When it arrived, in epoch milliseconds. */
      timestamp: number;
    }
  | {
      /** A companion device came into range or left it. */
      type: 'devicePresence';
      /** The peripheral. */
      peripheralId: string;
      /** Whether it is in range. */
      present: boolean;
    };

/** What `BleManager.registerBackgroundTask` delivers to the task. */
export interface BackgroundTaskOptions {
  /** The events the task receives. Supported so far: `scanResults` (Android). */
  events: BleBackgroundEvent['type'][];
  /**
   * The filters of the background scan, with `scanResults`. `services` or `manufacturerData` is
   * required: Android filters a background scan in the Bluetooth controller, which can't match a
   * name prefix (`namePrefix` is checked when the results arrive).
   */
  scan?: Pick<ScanOptions, 'services' | 'manufacturerData' | 'namePrefix'>;
}

/** What the notification of Android's keep-alive foreground service shows. */
export interface ForegroundServiceNotification {
  /**
   * The title.
   * @defaultValue the app's name
   */
  title?: string;
  /**
   * The text.
   * @defaultValue 'Keeping Bluetooth connections open'
   */
  text?: string;
  /**
   * The notification channel's name in the system settings.
   * @defaultValue 'Bluetooth connections'
   */
  channelName?: string;
  /**
   * A drawable resource of the app, by name (a white silhouette, as Android notifications need).
   * @defaultValue the app icon
   */
  smallIcon?: string;
}

/** What a characteristic allows. */
export type CharacteristicProperty =
  | 'broadcast'
  | 'read'
  | 'writeWithoutResponse'
  | 'write'
  | 'notify'
  | 'indicate'
  | 'authenticatedSignedWrites'
  | 'extendedProperties';

/** A discovered GATT service. */
export interface Service {
  /** Lowercase 128-bit UUID. */
  uuid: UUID;
  /** False for a secondary service. */
  isPrimary: boolean;
  /** Its characteristics, with their descriptors. */
  characteristics: Characteristic[];
}

/** A discovered characteristic. */
export interface Characteristic {
  /** Lowercase 128-bit UUID. */
  uuid: UUID;
  /** The UUID of its service. */
  serviceUUID: UUID;
  /** What it allows. */
  properties: CharacteristicProperty[];
  /** Its descriptors. */
  descriptors: Descriptor[];
}

/** A discovered descriptor. */
export interface Descriptor {
  /** Lowercase 128-bit UUID. */
  uuid: UUID;
  /** The UUID of its characteristic. */
  characteristicUUID: UUID;
}

/** Options of `Peripheral.write`. */
export interface WriteOptions extends OpOptions {
  /**
   * Wait for the peripheral to acknowledge (up to 512 bytes). Without response, the value must
   * fit one packet (MTU − 3 bytes), and the write resolves once the phone's Bluetooth stack has
   * taken the packet: it waits while the stack's buffer is full, so packets are never dropped on the
   * phone, and writes issued without awaiting each other go out in order. Nothing confirms that the
   * peripheral received them.
   * @defaultValue true
   */
  withResponse?: boolean;
}

/**
 * Options of `Peripheral.writeStream`. `timeoutMs` applies to each chunk, and `signal` stops the
 * stream within the chunk in flight.
 */
export interface StreamOptions extends OpOptions {
  /**
   * Wait for the peripheral to acknowledge every chunk: slower, for peripherals that require it
   * (some firmware-update protocols). Without response, chunks follow the flow control of `write`.
   * @defaultValue false
   */
  withResponse?: boolean;
  /**
   * Bytes per chunk, each sent as one write. At most one packet (MTU − 3) without response, and
   * 512 with response (longer than one packet then uses the stack's long write).
   * @defaultValue one packet: MTU − 3 (`maximumWriteValueLength(.withoutResponse)` on iOS)
   */
  chunkSize?: number;
  /**
   * Called with the bytes written so far, about every 1 % of `data`, and with
   * `(total, total)` before the stream resolves.
   */
  onProgress?: (sent: number, total: number) => void;
}

/**
 * Options of `Peripheral.subscribeBatched`. Values are collected natively and delivered at most
 * once per `intervalMs`, which keeps fast notifications from flooding the JS thread.
 */
export interface BatchOptions extends SubscribeOptions {
  /** The longest a value waits before delivery, in milliseconds. 16 gives at most ~63 batches/s. */
  intervalMs: number;
  /**
   * The most values one batch holds. When more arrive within `intervalMs`, the oldest are dropped
   * and counted in `dropped`, and a `BUFFER_OVERFLOW` warning is sent (once per subscription).
   * @defaultValue 4096
   */
  maxItems?: number;
}

/** Values a batched subscription received during one interval, oldest first. */
export interface NotificationBatch {
  /** The values, each its own `Uint8Array`. */
  values: Uint8Array[];
  /** When each value arrived on the phone, in epoch milliseconds (captured natively). */
  timestamps: number[];
  /** Values dropped since the previous batch because more than `maxItems` arrived. */
  dropped: number;
}

/** Options of `Peripheral.subscribe`. */
export interface SubscribeOptions extends OpOptions {
  /**
   * `auto` takes notifications when the characteristic offers both. iOS can't choose indications
   * on a characteristic that also notifies.
   * @defaultValue 'auto'
   */
  mode?: 'auto' | 'notify' | 'indicate';
}

/**
 * A GATT subscription. Several subscriptions to the same characteristic share one CCCD (the
 * descriptor that turns notifications on):
 * - the first enables it, removing the last disables it;
 * - a later subscriber that asks for an explicit `mode` different from the active one rejects
 *   with INVALID_ARGUMENT.
 */
export interface CharacteristicSubscription extends Subscription {
  /** False once unsubscribed, once the connection ended, or once a reconnection couldn't restore it. */
  readonly active: boolean;
  /** Stops delivery immediately. If this was the last subscriber, disables the CCCD and rejects with a coded error if that write fails. */
  unsubscribe(options?: OpOptions): Promise<void>;
  /**
   * Fire-and-forget unsubscribe(). A failed CCCD write goes to the log (warn) and is kept in
   * `getDiagnostics().recentErrors`.
   */
  remove(): void;
}

/** A remote device, from `BleManager.getPeripheral(id)`. One object per id. */
export interface Peripheral {
  /** The id: a MAC address on Android, a per-app UUID on iOS. Not portable between platforms. */
  readonly id: string;
  /** The latest advertised name, or the name the device reports once connected; null if unseen. */
  readonly name: string | null;
  /** The connection state, read synchronously. */
  readonly state: ConnectionState;
  /** ATT MTU. On iOS derived from maximumWriteValueLength(.withoutResponse) + 3. */
  readonly mtu: number;
  /** Discovery cache; empty before discovery. */
  readonly services: Service[];

  /**
   * Connects. Resolves once the connection is ready (after discovery, with `autoDiscover`);
   * listeners hear `connected` first. Never shows a permission prompt.
   */
  connect(options?: ConnectOptions): Promise<void>;
  /** Disconnects, or cancels a pending connect (which then rejects with `OPERATION_CANCELLED`). */
  disconnect(): Promise<void>;
  /** Discovers `services` (all when omitted), with their characteristics and descriptors. */
  discover(services?: UUID[], options?: OpOptions): Promise<Service[]>;

  /** Reads a characteristic. Long values are read in full. */
  read(service: UUID, characteristic: UUID, options?: OpOptions): Promise<Uint8Array>;
  /** Writes a characteristic: up to 512 bytes with response, one packet without. */
  write(
    service: UUID,
    characteristic: UUID,
    value: Uint8Array,
    options?: WriteOptions
  ): Promise<void>;
  /**
   * Writes `data` of any length in chunks, one write per chunk, natively and without a JS round
   * trip per chunk. Operations issued meanwhile wait until the stream ends. Rejects with the first
   * failed chunk (the message says how far it got); bytes already written stay written.
   */
  writeStream(
    service: UUID,
    characteristic: UUID,
    data: Uint8Array,
    options?: StreamOptions
  ): Promise<void>;
  /** Reads a descriptor. */
  readDescriptor(
    service: UUID,
    characteristic: UUID,
    descriptor: UUID,
    options?: OpOptions
  ): Promise<Uint8Array>;
  /** Writes a descriptor. The CCCD (0x2902) belongs to `subscribe()`: writing it rejects. */
  writeDescriptor(
    service: UUID,
    characteristic: UUID,
    descriptor: UUID,
    value: Uint8Array,
    options?: OpOptions
  ): Promise<void>;

  /**
   * Calls `onValue` with every notification or indication of a characteristic, with its arrival
   * time in epoch milliseconds. Resolves once the peripheral has notifications on.
   */
  subscribe(
    service: UUID,
    characteristic: UUID,
    onValue: (value: Uint8Array, timestamp: number) => void,
    options?: SubscribeOptions
  ): Promise<CharacteristicSubscription>;
  /**
   * Like `subscribe`, with values collected natively and delivered as batches at most once per
   * `options.intervalMs`: one JS event per batch instead of one per value. Batched and unbatched
   * subscribers can share a characteristic. A disconnect delivers the values already collected.
   */
  subscribeBatched(
    service: UUID,
    characteristic: UUID,
    onBatch: (batch: NotificationBatch) => void,
    options: BatchOptions
  ): Promise<CharacteristicSubscription>;

  /** Reads the signal strength of the connection, in dBm. */
  readRssi(options?: OpOptions): Promise<number>;
  /** Android: negotiates. iOS: resolves the current MTU (not negotiable). */
  requestMtu(mtu: number, options?: OpOptions): Promise<number>;

  /** Calls `listener` on every change; `error` says why a connection ended or failed. */
  addConnectionStateListener(
    listener: (state: ConnectionState, error?: BleError) => void
  ): Subscription;
  /**
   * Called when the peripheral's services changed while connected (Android 12+, iOS): the library
   * discovered them again, so `services` is current; subscriptions on characteristics that are
   * still there were kept, the others ended. Android 11 and older don't report service changes.
   */
  addServicesChangedListener(listener: () => void): Subscription;
  /** Android-only calls. Elsewhere they reject with `NOT_SUPPORTED`. */
  readonly android: {
    /**
     * Clears Android's GATT cache for this device, then discovers the services again (and calls
     * the services-changed listeners). Uses a hidden Android API: resolves `false` when the
     * platform doesn't offer it, and may stop working on new Android versions.
     */
    refreshGattCache(): Promise<boolean>;
  };
}

/** The type of {@link BleManager}. */
export interface BleManagerApi {
  /** The adapter state, read synchronously. */
  readonly state: BleState;
  /** Calls `listener` on every adapter state change. */
  addStateListener(listener: (state: BleState) => void): Subscription;

  /** Reads the permissions. Never shows a prompt. */
  getPermissionsAsync(): Promise<BlePermissions>;
  /** Asks for permissions. On iOS, the first call shows the Bluetooth prompt. */
  requestPermissionsAsync(request?: BlePermissionRequest): Promise<BlePermissions>;

  /** Sessions may overlap; each gets only its own matches, and stopping one leaves the others. */
  startScan(
    options: ScanOptions,
    onResults: (results: ScanResult[]) => void,
    onError?: (error: BleError) => void
  ): ScanSession;
  /** Scans until the first match or the timeout. Resolves null on timeout. */
  scanFor(
    options: ScanOptions & {
      timeoutMs: number;
      match?: (r: ScanResult) => boolean;
      signal?: AbortSignal;
    }
  ): Promise<ScanResult | null>;

  /**
   * No I/O. Returns the cached native-backed object for this id (same object for the same id).
   * Never touches CoreBluetooth and never creates a manager (no permission prompt). The native
   * peripheral is resolved on the first async call, which rejects with PERIPHERAL_NOT_FOUND
   * when iOS can't retrieve the id.
   */
  getPeripheral(id: string): Peripheral;
  /** iOS: retrievePeripherals(withIdentifiers:), drops unknown ids. Android: getRemoteDevice(address), never drops ids. */
  getKnownPeripherals(ids: string[]): Promise<Peripheral[]>;
  /** Peripherals connected at the OS level, possibly by another app. Android doesn't filter by `services`. */
  getSystemConnectedPeripherals(services: UUID[]): Promise<Peripheral[]>;

  /**
   * Sets how much the library logs, natively (`os.Logger` subsystem `expo.blekit` on iOS, Logcat
   * tag `BleKit` on Android) and to the log handler.
   * @defaultValue 'warn'
   */
  setLogLevel(level: LogLevel): void;
  /** Receives every log line at or above the level, or `null` to stop. */
  setLogHandler(handler: ((entry: LogEntry) => void) | null): void;
  /** A snapshot for bug reports: state, permissions, connections and recent errors. */
  getDiagnostics(): Promise<Diagnostics>;

  /**
   * Delivers events to the `expo-task-manager` task `taskName`, also while the app isn't running:
   * define it with `TaskManager.defineTask(taskName, ({ data, error }) => …)` at module scope; `data`
   * is a {@link BleBackgroundEvent}. Registering a registered task again changes its options.
   *
   * Android: `scanResults` runs a background scan that wakes the app when a matching device
   * advertises, even after the system killed it (not after a force stop). It needs the
   * `backgroundScan` permission, which on Android 10–11 includes background location
   * (`PERMISSION_DENIED` names what's missing), and `expo-task-manager` (`MISCONFIGURED` without
   * it). The scan restarts by itself after an app update; after a reboot it restarts when the app
   * next runs, or at boot if the app declares `RECEIVE_BOOT_COMPLETED`.
   *
   * iOS: not supported yet (rejects with `NOT_SUPPORTED`).
   */
  registerBackgroundTask(taskName: string, options: BackgroundTaskOptions): Promise<void>;
  /** Stops delivering to `taskName` and its background scan. Unknown names do nothing. */
  unregisterBackgroundTask(taskName: string): Promise<void>;

  /** Android-only calls; on iOS they do nothing. */
  readonly android: {
    /**
     * What the notification of the `keepAliveInBackground` foreground service shows. Updates it
     * when the service runs; later services use it too. Fields left out get their defaults.
     */
    setForegroundServiceNotification(notification: ForegroundServiceNotification): void;
  };
}
