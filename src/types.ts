import type { BleError } from './errors';
import type { UUID } from './uuid';

// Public types of plan §5 (central role). Changing them requires updating the plan, docs and tests
// together (Appendix B, rule 8). Members owned by later tasks (writeStream, batching, logging, the
// peripheral role, background, onboarding, Android-only peripheral calls) land with those tasks.

export type BleState =
  'unknown' | 'resetting' | 'unsupported' | 'unauthorized' | 'poweredOff' | 'poweredOn';

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';
/** See §4.8 for how native states map onto these. `connected` means ready for GATT ops. */
export type ConnectionState =
  'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'reconnecting';
export type Phy = 'le1m' | 'le2m' | 'leCoded';

/** Removes a JS listener. Synchronous, no I/O, never fails. */
export interface Subscription {
  remove(): void;
}

export interface OpOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BlePermissions {
  scan: PermissionStatus;
  connect: PermissionStatus;
  advertise: PermissionStatus;
  /** Android 10–11: ACCESS_BACKGROUND_LOCATION. Elsewhere mirrors `scan`. */
  backgroundScan: PermissionStatus;
  canAskAgain: boolean;
}

/** No flag set means `{ scan: true, connect: true }`. iOS ignores the flags: one prompt covers all. */
export interface BlePermissionRequest {
  scan?: boolean;
  connect?: boolean;
  advertise?: boolean;
  backgroundScan?: boolean;
}

export interface ScanOptions {
  /** Strongly recommended. Required for background scanning on iOS. */
  services?: UUID[];
  allowDuplicates?: boolean; // default false
  /** Batch window for onResults in ms. 0 = deliver immediately (default). */
  reportIntervalMs?: number;
  namePrefix?: string;
  manufacturerData?: { companyId: number; data?: Uint8Array; mask?: Uint8Array }[];
  android?: {
    scanMode?: 'opportunistic' | 'lowPower' | 'balanced' | 'lowLatency'; // default 'balanced'
    callbackType?: 'allMatches' | 'firstMatch' | 'matchLost';
    matchMode?: 'aggressive' | 'sticky';
    legacy?: boolean; // default true
    phy?: 'le1m' | 'leCoded' | 'all';
    reportDelayMs?: number; // hardware batching
  };
  ios?: { solicitedServices?: UUID[] };
}

export interface ScanResult {
  id: string;
  name: string | null;
  rssi: number;
  txPowerLevel: number | null;
  isConnectable: boolean | null;
  serviceUUIDs: UUID[];
  serviceData: Record<UUID, Uint8Array>;
  manufacturerData: Record<number, Uint8Array>; // key = Bluetooth SIG company id
  /** Raw advertising + scan response bytes. Android only; null on iOS. */
  rawAdvertisement: Uint8Array | null;
  timestamp: number;
}

export interface ScanSession {
  readonly active: boolean;
  stop(): void;
}

export interface ConnectOptions extends Omit<OpOptions, 'timeoutMs'> {
  /**
   * Default 15000. `null` = no timeout: the connect stays pending until the device appears
   * ("connect when in range": iOS pending connect, Android autoConnect). It is still cancelled by
   * disconnect() or `signal`. This is the only exception to Appendix B rule 4.
   */
  timeoutMs?: number | null;
  autoDiscover?: boolean; // default true
  reconnect?: ReconnectPolicy | false; // default false
  restoreSubscriptionsOnReconnect?: boolean; // default true when reconnect is set
  keepAliveInBackground?: boolean; // Android: foreground service (P3). iOS: needs the background mode
  android?: { autoConnect?: boolean; requestMtu?: number | false; phy?: Phy[] }; // requestMtu default 517 (see Q3)
  ios?: { enableAutoReconnect?: boolean; notifyOnDisconnection?: boolean };
}

export interface ReconnectPolicy {
  maxAttempts?: number; // default Infinity
  initialDelayMs?: number; // default 1000
  maxDelayMs?: number; // default 30000
  backoff?: 'exponential' | 'fixed';
}

export interface Diagnostics {
  state: BleState;
  permissions: BlePermissions;
  sessions: { id: string; state: ConnectionState; queueDepth: number; subscriptions: number }[];
  recentErrors: BleError[]; // ring buffer, last 100
  /** Android: GATT clients opened and not yet closed. Stable across connect cycles when nothing leaks. */
  android?: { openGattClients: number };
}

export type CharacteristicProperty =
  | 'broadcast'
  | 'read'
  | 'writeWithoutResponse'
  | 'write'
  | 'notify'
  | 'indicate'
  | 'authenticatedSignedWrites'
  | 'extendedProperties';

export interface Service {
  uuid: UUID;
  isPrimary: boolean;
  characteristics: Characteristic[];
}
export interface Characteristic {
  uuid: UUID;
  serviceUUID: UUID;
  properties: CharacteristicProperty[];
  descriptors: Descriptor[];
}
export interface Descriptor {
  uuid: UUID;
  characteristicUUID: UUID;
}

export interface WriteOptions extends OpOptions {
  withResponse?: boolean; // default true
}

export interface SubscribeOptions extends OpOptions {
  mode?: 'auto' | 'notify' | 'indicate'; // default 'auto'
}

/**
 * A GATT subscription. Several subscriptions to the same characteristic share one CCCD:
 * - the first enables it, removing the last disables it;
 * - batched and unbatched subscribers can share a characteristic (batching is per subscriber);
 * - a later subscriber that asks for an explicit `mode` different from the active one rejects
 *   with INVALID_ARGUMENT.
 */
export interface CharacteristicSubscription extends Subscription {
  readonly active: boolean;
  /** Stops delivery immediately. If this was the last subscriber, disables the CCCD and rejects with a coded error if that write fails. */
  unsubscribe(options?: OpOptions): Promise<void>;
  /** Fire-and-forget unsubscribe(). CCCD failures go to the `warning` event and the log. */
  remove(): void;
}

export interface Peripheral {
  readonly id: string;
  /** The latest advertised name, or the name the device reports once connected; null if unseen. */
  readonly name: string | null;
  readonly state: ConnectionState;
  /** ATT MTU. On iOS derived from maximumWriteValueLength(.withoutResponse) + 3. */
  readonly mtu: number;
  /** Discovery cache; empty before discovery. */
  readonly services: Service[];

  connect(options?: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  discover(services?: UUID[], options?: OpOptions): Promise<Service[]>;

  read(service: UUID, characteristic: UUID, options?: OpOptions): Promise<Uint8Array>;
  write(
    service: UUID,
    characteristic: UUID,
    value: Uint8Array,
    options?: WriteOptions
  ): Promise<void>;
  readDescriptor(
    service: UUID,
    characteristic: UUID,
    descriptor: UUID,
    options?: OpOptions
  ): Promise<Uint8Array>;
  writeDescriptor(
    service: UUID,
    characteristic: UUID,
    descriptor: UUID,
    value: Uint8Array,
    options?: OpOptions
  ): Promise<void>;

  subscribe(
    service: UUID,
    characteristic: UUID,
    onValue: (value: Uint8Array, timestamp: number) => void,
    options?: SubscribeOptions
  ): Promise<CharacteristicSubscription>;

  readRssi(options?: OpOptions): Promise<number>;
  /** Android: negotiates. iOS: resolves the current MTU (not negotiable). */
  requestMtu(mtu: number, options?: OpOptions): Promise<number>;

  addConnectionStateListener(
    listener: (state: ConnectionState, error?: BleError) => void
  ): Subscription;
}

export interface BleManagerApi {
  readonly state: BleState;
  addStateListener(listener: (state: BleState) => void): Subscription;

  getPermissionsAsync(): Promise<BlePermissions>;
  requestPermissionsAsync(request?: BlePermissionRequest): Promise<BlePermissions>;

  /** Sessions may overlap; the core multiplexes them (§5.3). */
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
  /** iOS: retrievePeripherals(withIdentifiers:), drops unknown ids. Android: getRemoteDevice(address), never drops ids (§4.12). */
  getKnownPeripherals(ids: string[]): Promise<Peripheral[]>;
  /** Peripherals connected at the OS level, possibly by another app. */
  getSystemConnectedPeripherals(services: UUID[]): Promise<Peripheral[]>;

  getDiagnostics(): Promise<Diagnostics>;
}
