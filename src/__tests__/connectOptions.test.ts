import { BleError } from '../errors';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  reconnectDelay,
  toNativeConnectOptions,
  validateMtu,
} from '../internal/connectOptions';
import type { ConnectOptions } from '../types';

describe('toNativeConnectOptions', () => {
  it('applies the default timeout and keeps an explicit null', () => {
    expect(toNativeConnectOptions()).toEqual({
      timeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      autoDiscover: true,
      reconnect: null,
      restoreSubscriptionsOnReconnect: true,
      keepAliveInBackground: false,
      android: { requestMtu: 517, resetAfterTimeouts: 2 },
      ios: { notifyOnDisconnection: false, enableAutoReconnect: false },
    });
    expect(toNativeConnectOptions({ timeoutMs: null }).timeoutMs).toBeNull();
    expect(toNativeConnectOptions({ timeoutMs: 2500 }).timeoutMs).toBe(2500);
  });

  it('validates android.resetAfterTimeouts: an integer of 1 or more, or false for never', () => {
    expect(
      toNativeConnectOptions({ android: { resetAfterTimeouts: 3 } }).android.resetAfterTimeouts
    ).toBe(3);
    expect(
      toNativeConnectOptions({ android: { resetAfterTimeouts: false } }).android.resetAfterTimeouts
    ).toBeNull();
    for (const value of [0, 1.5, -1, '2', true]) {
      expect(() =>
        toNativeConnectOptions({ android: { resetAfterTimeouts: value as never } })
      ).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });

  it('keeps autoDiscover false', () => {
    expect(toNativeConnectOptions({ autoDiscover: false }).autoDiscover).toBe(false);
  });

  it('applies the reconnect policy defaults', () => {
    expect(toNativeConnectOptions({ reconnect: {} }).reconnect).toEqual({
      maxAttempts: null,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      backoff: 'exponential',
    });
    expect(toNativeConnectOptions({ reconnect: false }).reconnect).toBeNull();
    expect(
      toNativeConnectOptions({
        reconnect: { maxAttempts: 5, initialDelayMs: 40_000, backoff: 'fixed' },
      }).reconnect
    ).toEqual({ maxAttempts: 5, initialDelayMs: 40000, maxDelayMs: 40000, backoff: 'fixed' });
    expect(
      toNativeConnectOptions({ reconnect: {}, ios: { enableAutoReconnect: true } }).ios
        .enableAutoReconnect
    ).toBe(true);
  });

  it('waits like the native cores between reconnection attempts', () => {
    const policy = toNativeConnectOptions({
      reconnect: { initialDelayMs: 500, maxDelayMs: 3000 },
    }).reconnect!;
    expect([1, 2, 3, 4, 5].map((attempt) => reconnectDelay(policy, attempt))).toEqual([
      500, 1000, 2000, 3000, 3000,
    ]);
    const fixed = toNativeConnectOptions({
      reconnect: { backoff: 'fixed', initialDelayMs: 700 },
    }).reconnect!;
    expect([1, 2, 3].map((attempt) => reconnectDelay(fixed, attempt))).toEqual([700, 700, 700]);
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
    ['reconnect.maxAttempts 0', { reconnect: { maxAttempts: 0 } }],
    ['reconnect.maxAttempts 1.5', { reconnect: { maxAttempts: 1.5 } }],
    ['reconnect.initialDelayMs negative', { reconnect: { initialDelayMs: -1 } }],
    [
      'reconnect.maxDelayMs below initial',
      { reconnect: { initialDelayMs: 5000, maxDelayMs: 1000 } },
    ],
    ['reconnect.backoff', { reconnect: { backoff: 'linear' } }],
    ['reconnect true', { reconnect: true }],
    ['restoreSubscriptionsOnReconnect', { restoreSubscriptionsOnReconnect: 'yes' }],
    ['ios.enableAutoReconnect without reconnect', { ios: { enableAutoReconnect: true } }],
    ['autoDiscover', { autoDiscover: 'no' }],
    ['ios.notifyOnDisconnection', { ios: { notifyOnDisconnection: 1 } }],
    ['keepAliveInBackground', { keepAliveInBackground: 'yes' }],
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
