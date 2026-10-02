import { BleError } from '../errors';
import {
  DEFAULT_OPERATION_TIMEOUT_MS,
  checkValue,
  operationTimeout,
  toNativeAttributeRequest,
} from '../internal/attributeRequest';

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as BleError).code;
  }
  return undefined;
};

describe('toNativeAttributeRequest', () => {
  it('normalizes UUIDs and applies the defaults', () => {
    expect(toNativeAttributeRequest('180f', 0x2a19, undefined)).toEqual({
      service: '0000180f-0000-1000-8000-00805f9b34fb',
      characteristic: '00002a19-0000-1000-8000-00805f9b34fb',
      withResponse: true,
      timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
    });
    expect(
      toNativeAttributeRequest('180d', '2a37', '2902', { withResponse: false, timeoutMs: 500 })
    ).toEqual({
      service: '0000180d-0000-1000-8000-00805f9b34fb',
      characteristic: '00002a37-0000-1000-8000-00805f9b34fb',
      descriptor: '00002902-0000-1000-8000-00805f9b34fb',
      withResponse: false,
      timeoutMs: 500,
    });
  });

  it('rejects bad input with INVALID_ARGUMENT', () => {
    expect(codeOf(() => toNativeAttributeRequest('nope', '2a19', undefined))).toBe(
      'INVALID_ARGUMENT'
    );
    expect(
      codeOf(() =>
        toNativeAttributeRequest('180f', '2a19', undefined, { withResponse: 1 as never })
      )
    ).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => operationTimeout({ timeoutMs: 0 }))).toBe('INVALID_ARGUMENT');
    expect(operationTimeout(undefined, 30_000)).toBe(30_000);
  });

  it('checks values', () => {
    expect(checkValue(new Uint8Array(512))).toHaveLength(512);
    expect(codeOf(() => checkValue(new Uint8Array(513)))).toBe('INVALID_ATTRIBUTE_LENGTH');
    expect(codeOf(() => checkValue([1, 2]))).toBe('INVALID_ARGUMENT');
  });
});
