import { BleError } from '../errors';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  toNativeConnectOptions,
  validateMtu,
} from '../internal/connectOptions';
import type { ConnectOptions } from '../types';

describe('toNativeConnectOptions', () => {
  it('applies the default timeout and keeps an explicit null', () => {
    expect(toNativeConnectOptions()).toEqual({
      timeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      autoDiscover: true,
      android: { requestMtu: 517 },
      ios: { notifyOnDisconnection: false },
    });
    expect(toNativeConnectOptions({ timeoutMs: null }).timeoutMs).toBeNull();
    expect(toNativeConnectOptions({ timeoutMs: 2500 }).timeoutMs).toBe(2500);
  });

  it('keeps autoDiscover false', () => {
    expect(toNativeConnectOptions({ autoDiscover: false }).autoDiscover).toBe(false);
  });

  it('asks for 517 by default, nothing with false, or the given MTU', () => {
    expect(
      toNativeConnectOptions({ android: { requestMtu: false } }).android.requestMtu
    ).toBeNull();
    expect(toNativeConnectOptions({ android: { requestMtu: 185 } }).android.requestMtu).toBe(185);
    expect(toNativeConnectOptions({ android: { requestMtu: 23 } }).android.requestMtu).toBe(23);
  });

  it('checks an MTU', () => {
    expect(validateMtu('mtu', 517)).toBe(517);
    for (const value of [22, 518, 100.5, '185', NaN, true]) {
      expect(() => validateMtu('mtu', value)).toThrow(BleError);
    }
  });

  it('passes the platform options', () => {
    expect(
      toNativeConnectOptions({
        android: { autoConnect: true },
        ios: { notifyOnDisconnection: true },
      })
    ).toMatchObject({ android: { autoConnect: true }, ios: { notifyOnDisconnection: true } });
  });

  it.each<[string, unknown]>([
    ['timeoutMs 0', { timeoutMs: 0 }],
    ['timeoutMs negative', { timeoutMs: -5 }],
    ['timeoutMs NaN', { timeoutMs: NaN }],
    ['timeoutMs string', { timeoutMs: '100' }],
    ['android.autoConnect', { android: { autoConnect: 'yes' } }],
    ['android.requestMtu too small', { android: { requestMtu: 22 } }],
    ['android.requestMtu too large', { android: { requestMtu: 518 } }],
    ['android.requestMtu true', { android: { requestMtu: true } }],
    ['autoDiscover', { autoDiscover: 'no' }],
    ['ios.notifyOnDisconnection', { ios: { notifyOnDisconnection: 1 } }],
  ])('rejects %s', (_, options) => {
    let error: unknown;
    try {
      toNativeConnectOptions(options as ConnectOptions);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(BleError);
    expect((error as BleError).code).toBe('INVALID_ARGUMENT');
  });
});
