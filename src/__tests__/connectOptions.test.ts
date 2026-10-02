import { BleError } from '../errors';
import { DEFAULT_CONNECT_TIMEOUT_MS, toNativeConnectOptions } from '../internal/connectOptions';
import type { ConnectOptions } from '../types';

describe('toNativeConnectOptions', () => {
  it('applies the default timeout and keeps an explicit null', () => {
    expect(toNativeConnectOptions()).toEqual({
      timeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      autoDiscover: true,
      android: {},
      ios: { notifyOnDisconnection: false },
    });
    expect(toNativeConnectOptions({ timeoutMs: null }).timeoutMs).toBeNull();
    expect(toNativeConnectOptions({ timeoutMs: 2500 }).timeoutMs).toBe(2500);
  });

  it('keeps autoDiscover false', () => {
    expect(toNativeConnectOptions({ autoDiscover: false }).autoDiscover).toBe(false);
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
