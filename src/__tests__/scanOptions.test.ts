import { BleError } from '../errors';
import { toNativeScanOptions } from '../internal/scanOptions';
import type { ScanOptions } from '../types';

describe('toNativeScanOptions', () => {
  it('applies defaults', () => {
    expect(toNativeScanOptions()).toEqual({
      services: [],
      allowDuplicates: false,
      reportIntervalMs: 0,
      manufacturerData: [],
      android: {
        scanMode: undefined,
        callbackType: undefined,
        matchMode: undefined,
        legacy: true,
        phy: undefined,
        reportDelayMs: 0,
      },
      ios: { solicitedServices: [] },
      web: { optionalServices: [] },
    });
  });

  it('normalizes UUIDs and keeps every option', () => {
    const data = new Uint8Array([0x42, 0x4b]);
    const mask = new Uint8Array([0xff, 0x0f]);
    const options = toNativeScanOptions({
      services: [
        '180D',
        '0000180d-0000-1000-8000-00805F9B34FB',
        '0c6c1000-b347-4cfa-9827-1c5a13658519',
      ],
      allowDuplicates: true,
      reportIntervalMs: 250.4,
      namePrefix: 'BleKit',
      manufacturerData: [{ companyId: 0xffff, data, mask }, { companyId: 0x004c }],
      android: { scanMode: 'lowLatency', legacy: false, phy: 'all', reportDelayMs: 1000 },
      ios: { solicitedServices: ['180f'] },
    });
    expect(options.services).toEqual([
      '0000180d-0000-1000-8000-00805f9b34fb',
      '0c6c1000-b347-4cfa-9827-1c5a13658519',
    ]);
    expect(options.reportIntervalMs).toBe(250);
    expect(options.namePrefix).toBe('BleKit');
    expect(options.manufacturerData).toEqual([
      { companyId: 0xffff, data, mask },
      { companyId: 0x004c },
    ]);
    expect(options.android).toMatchObject({
      scanMode: 'lowLatency',
      legacy: false,
      reportDelayMs: 1000,
    });
    expect(options.ios.solicitedServices).toEqual(['0000180f-0000-1000-8000-00805f9b34fb']);
  });

  it.each<[string, unknown]>([
    ['services', { services: ['xyz'] }],
    ['services', { services: '180d' }],
    ['reportIntervalMs', { reportIntervalMs: -1 }],
    ['reportIntervalMs', { reportIntervalMs: Infinity }],
    ['allowDuplicates', { allowDuplicates: 'yes' }],
    ['namePrefix', { namePrefix: 3 }],
    ['companyId', { manufacturerData: [{ companyId: 0x10000 }] }],
    ['data', { manufacturerData: [{ companyId: 1, data: [1, 2] }] }],
    ['mask', { manufacturerData: [{ companyId: 1, mask: new Uint8Array([1]) }] }],
    [
      'mask',
      {
        manufacturerData: [
          { companyId: 1, data: new Uint8Array([1]), mask: new Uint8Array([1, 2]) },
        ],
      },
    ],
    ['android.scanMode', { android: { scanMode: 'fast' } }],
    ['android.phy', { android: { phy: 'le2m' } }],
    ['android.reportDelayMs', { android: { reportDelayMs: -5 } }],
  ])('rejects a bad %s', (_, options) => {
    expect(() => toNativeScanOptions(options as ScanOptions)).toThrow(BleError);
    try {
      toNativeScanOptions(options as ScanOptions);
    } catch (error) {
      expect((error as BleError).code).toBe('INVALID_ARGUMENT');
    }
  });
});
