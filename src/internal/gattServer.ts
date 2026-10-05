import { BleError, BleErrorCode } from '../errors';
import type { AttributePermission, CharacteristicProperty, ServiceDefinition } from '../types';
import { normalizeUUID, uuid16, type UUID } from '../uuid';

// The GATT server (plan §5.5, P4-01): definitions as the native side takes them, ATT error codes,
// and the long-read cache the fake shares with the native cores (test-contracts/gatt-server-reads.json).

/** A definition after validation: UUIDs normalized, defaults applied. */
export interface NativeServiceDefinition {
  uuid: UUID;
  primary: boolean;
  characteristics: {
    uuid: UUID;
    properties: CharacteristicProperty[];
    permissions: AttributePermission[];
    value?: Uint8Array;
    descriptors: { uuid: UUID; value: Uint8Array }[];
  }[];
}

export const MAX_VALUE_LENGTH = 512;
const PROPERTIES: CharacteristicProperty[] = [
  'read',
  'write',
  'writeWithoutResponse',
  'notify',
  'indicate',
];
const PERMISSIONS: AttributePermission[] = [
  'readable',
  'writeable',
  'readEncryptionRequired',
  'writeEncryptionRequired',
];
/** The descriptors iOS publishes (CBMutableDescriptor); the CCCD is added by the server. */
const USER_DESCRIPTION = uuid16(0x2901);
const PRESENTATION_FORMAT = uuid16(0x2904);
const CCCD = uuid16(0x2902);

function invalid(option: string, problem: string): BleError {
  return new BleError(BleErrorCode.INVALID_ARGUMENT, `Invalid GATT server ${option}: ${problem}`);
}

function value(option: string, bytes: unknown): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw invalid(option, 'expected a Uint8Array');
  if (bytes.length > MAX_VALUE_LENGTH) {
    throw invalid(option, `at most ${MAX_VALUE_LENGTH} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function list<T extends string>(option: string, values: unknown, allowed: T[]): T[] {
  if (!Array.isArray(values) || values.some((v) => !allowed.includes(v))) {
    throw invalid(option, `expected an array of ${allowed.join(', ')}`);
  }
  return [...new Set(values as T[])];
}

/** Validates `openGattServer` definitions (plan §5.5) the same way for both platforms. */
export function toNativeServices(services: ServiceDefinition[]): NativeServiceDefinition[] {
  if (!Array.isArray(services) || services.length === 0) {
    throw invalid('services', 'expected a non-empty array');
  }
  const seen = new Set<UUID>();
  return services.map((service, s) => {
    if (typeof service !== 'object' || service === null)
      throw invalid(`services[${s}]`, 'expected an object');
    if (service.primary !== undefined && typeof service.primary !== 'boolean') {
      throw invalid(`services[${s}].primary`, 'expected a boolean');
    }
    if (!Array.isArray(service.characteristics)) {
      throw invalid(`services[${s}].characteristics`, 'expected an array');
    }
    return {
      uuid: normalizeUUID(service.uuid),
      primary: service.primary ?? true,
      characteristics: service.characteristics.map((characteristic, c) => {
        const at = `services[${s}].characteristics[${c}]`;
        const uuid = normalizeUUID(characteristic.uuid);
        if (seen.has(uuid)) throw invalid(at, `characteristic ${uuid} appears twice in the server`);
        seen.add(uuid);
        const properties = list(`${at}.properties`, characteristic.properties, PROPERTIES);
        if (properties.length === 0) throw invalid(`${at}.properties`, 'expected at least one');
        const permissions = list(`${at}.permissions`, characteristic.permissions, PERMISSIONS);
        const readable = permissions.some((p) => p.startsWith('read'));
        const writeable = permissions.some((p) => p.startsWith('write'));
        if (properties.includes('read') && !readable) {
          throw invalid(`${at}.permissions`, 'read needs readable or readEncryptionRequired');
        }
        if (
          (properties.includes('write') || properties.includes('writeWithoutResponse')) &&
          !writeable
        ) {
          throw invalid(`${at}.permissions`, 'writes need writeable or writeEncryptionRequired');
        }
        const staticValue =
          characteristic.value === undefined
            ? undefined
            : value(`${at}.value`, characteristic.value);
        if (staticValue && (properties.some((p) => p !== 'read') || writeable)) {
          throw invalid(
            `${at}.value`,
            'a static value makes a characteristic read-only: properties ["read"]'
          );
        }
        const descriptors = (characteristic.descriptors ?? []).map((descriptor, d) => {
          const descriptorUuid = normalizeUUID(descriptor?.uuid);
          if (descriptorUuid === CCCD) {
            throw invalid(`${at}.descriptors[${d}]`, 'the CCCD (2902) is added automatically');
          }
          if (descriptorUuid !== USER_DESCRIPTION && descriptorUuid !== PRESENTATION_FORMAT) {
            throw invalid(
              `${at}.descriptors[${d}]`,
              'only 2901 and 2904 can be defined (iOS publishes no others)'
            );
          }
          return {
            uuid: descriptorUuid,
            value: value(`${at}.descriptors[${d}].value`, descriptor.value),
          };
        });
        return {
          uuid,
          properties,
          permissions,
          ...(staticValue && { value: staticValue }),
          descriptors,
        };
      }),
    };
  });
}

/** ATT error codes (Core spec Vol 3 Part F 3.4.1.1), as iOS `CBATTError` and Android statuses use them. */
export const AttError = {
  READ_NOT_PERMITTED: 0x02,
  WRITE_NOT_PERMITTED: 0x03,
  INSUFFICIENT_AUTHENTICATION: 0x05,
  REQUEST_NOT_SUPPORTED: 0x06,
  INVALID_OFFSET: 0x07,
  INSUFFICIENT_AUTHORIZATION: 0x08,
  INVALID_ATTRIBUTE_LENGTH: 0x0d,
  UNLIKELY_ERROR: 0x0e,
  INSUFFICIENT_ENCRYPTION: 0x0f,
  CCCD_IMPROPERLY_CONFIGURED: 0xfd,
} as const;

const ATT_BY_CODE: Partial<Record<BleErrorCode, number>> = {
  READ_NOT_PERMITTED: AttError.READ_NOT_PERMITTED,
  WRITE_NOT_PERMITTED: AttError.WRITE_NOT_PERMITTED,
  INSUFFICIENT_AUTHENTICATION: AttError.INSUFFICIENT_AUTHENTICATION,
  NOT_SUPPORTED: AttError.REQUEST_NOT_SUPPORTED,
  INVALID_OFFSET: AttError.INVALID_OFFSET,
  INSUFFICIENT_AUTHORIZATION: AttError.INSUFFICIENT_AUTHORIZATION,
  INVALID_ATTRIBUTE_LENGTH: AttError.INVALID_ATTRIBUTE_LENGTH,
  INSUFFICIENT_ENCRYPTION: AttError.INSUFFICIENT_ENCRYPTION,
};

/** The ATT error a handler's thrown error answers with: its BleError code, else an unlikely error. */
export function attErrorFor(error: unknown): number {
  const code = error instanceof BleError ? error.code : undefined;
  return (code && ATT_BY_CODE[code]) ?? AttError.UNLIKELY_ERROR;
}

/** The BleError code a central sees for an ATT error (the fake's virtual central). */
export function codeForAttError(att: number): BleErrorCode {
  const entry = Object.entries(ATT_BY_CODE).find(([, value]) => value === att);
  return (entry?.[0] as BleErrorCode | undefined) ?? BleErrorCode.GATT_ERROR;
}

/**
 * The long-read cache (plan §5.5): one value per central and characteristic, so a long read's
 * continuation reads come from the same handler result as its first read. Same rules as the native
 * cores: offset 0 always asks the handler; a later offset uses a value younger than 30 s.
 */
export class ServerReadCache {
  static readonly TTL_MS = 30_000;
  private readonly entries = new Map<string, { value: Uint8Array; at: number }>();

  constructor(private readonly now: () => number) {}

  lookup(central: string, characteristic: UUID, offset: number): Uint8Array | null {
    if (offset === 0) return null;
    const entry = this.entries.get(`${central}|${characteristic}`);
    return entry && this.now() - entry.at < ServerReadCache.TTL_MS ? entry.value : null;
  }

  store(central: string, characteristic: UUID, value: Uint8Array): void {
    this.entries.set(`${central}|${characteristic}`, { value, at: this.now() });
  }

  drop(central: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${central}|`)) this.entries.delete(key);
    }
  }

  /** The part of `value` from `offset`, or null past the end (INVALID_OFFSET). */
  static slice(value: Uint8Array, offset: number): Uint8Array | null {
    return offset > value.length ? null : value.slice(offset);
  }
}
