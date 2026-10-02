import { readFileSync } from 'fs';
import { resolve } from 'path';

import { BleError, BleErrorCode } from '../errors';

const root = resolve(__dirname, '../..');

describe('BleError', () => {
  it('is an Error with a code and plan defaults', () => {
    const error = new BleError('OPERATION_TIMEOUT', 'read timed out', { peripheralId: 'p1' });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(BleError);
    expect(error.name).toBe('BleError');
    expect(error.code).toBe('OPERATION_TIMEOUT');
    expect(error.message).toBe('read timed out');
    expect(error.retryable).toBe(true);
    expect(error.peripheralId).toBe('p1');
    expect(['ios', 'android', 'web']).toContain(error.platform);
  });

  it('defaults retryable by code and lets the native side override it', () => {
    const retryable = Object.values(BleErrorCode).filter(
      (code) => new BleError(code, '').retryable
    );
    expect(retryable.sort()).toEqual(
      [
        'BLUETOOTH_RESETTING',
        'CONGESTED',
        'CONNECTION_FAILED',
        'CONNECTION_TIMEOUT',
        'OPERATION_TIMEOUT',
        'SCAN_THROTTLED',
      ].sort()
    );
    expect(new BleError('DISCONNECTED', 'lost', { retryable: true }).retryable).toBe(true);
    expect(new BleError('CONNECTION_FAILED', 'limit', { retryable: false }).retryable).toBe(false);
  });

  describe('fromNative', () => {
    it('reads the code and the [blekit] details the binding embeds', () => {
      const native = Object.assign(
        new Error(
          'Reading failed: insufficient encryption [blekit]{"nativeDomain":"CBATTErrorDomain","nativeCode":15,"retryable":false}'
        ),
        { code: 'INSUFFICIENT_ENCRYPTION' }
      );
      const error = BleError.fromNative(native, { characteristicUUID: 'c1' });
      expect(error.code).toBe('INSUFFICIENT_ENCRYPTION');
      expect(error.message).toBe('Reading failed: insufficient encryption');
      expect(error.nativeDomain).toBe('CBATTErrorDomain');
      expect(error.nativeCode).toBe(15);
      expect(error.retryable).toBe(false);
      expect(error.characteristicUUID).toBe('c1');
      expect(error.cause).toBe(native);
    });

    it('turns unknown codes, non-errors and malformed details into INTERNAL safely', () => {
      expect(
        BleError.fromNative(Object.assign(new Error('boom'), { code: 'ERR_UNKNOWN' })).code
      ).toBe('INTERNAL');
      expect(BleError.fromNative('plain string').message).toBe('plain string');
      expect(BleError.fromNative(undefined).code).toBe('INTERNAL');
      const malformed = BleError.fromNative(
        Object.assign(new Error('x [blekit]{oops}'), { code: 'GATT_ERROR' })
      );
      expect(malformed.code).toBe('GATT_ERROR');
    });

    it('passes BleErrors through unchanged', () => {
      const original = new BleError('DISCONNECTED', 'gone');
      expect(BleError.fromNative(original)).toBe(original);
    });
  });

  it('uses exactly the same codes as both native cores', () => {
    const swift = readFileSync(resolve(root, 'ios/Core/CoreError.swift'), 'utf8');
    const kotlin = readFileSync(
      resolve(root, 'android/src/main/java/expo/modules/blekit/core/CoreError.kt'),
      'utf8'
    );
    const swiftCodes = [...swift.matchAll(/case `?\w+`? = "([A-Z_0-9]+)"/g)].map((m) => m[1]);
    const kotlinCodes = [...kotlin.matchAll(/^\s+[A-Z_0-9]+\("([A-Z_0-9]+)"\),$/gm)].map(
      (m) => m[1]
    );
    const tsCodes = Object.values(BleErrorCode);

    expect(tsCodes).toHaveLength(32);
    expect([...swiftCodes].sort()).toEqual([...tsCodes].sort());
    expect([...kotlinCodes].sort()).toEqual([...tsCodes].sort());
  });
});
