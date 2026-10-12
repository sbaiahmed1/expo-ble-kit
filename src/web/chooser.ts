import type { NativeScanOptions } from '../internal/scanOptions';
import type { ScanResult } from '../types';
import type { RequestDeviceOptions, WebBluetoothDevice, WebScanFilter } from './bluetooth';

/**
 * The browser's device chooser for a scan's filters (plan §6: on the web a scan is the chooser).
 * The filters mean what they mean in a scan: any of the services, and the name prefix, and any of
 * the manufacturer data. Web Bluetooth ORs its filters and ANDs within one, so each combination
 * is a filter. Without filters the chooser lists every device. Services the app reads must be in
 * the filters or in `web.optionalServices`.
 */
export function chooserOptions(options: NativeScanOptions): RequestDeviceOptions {
  const { services, namePrefix, manufacturerData } = options;
  const serviceSets: (string[] | undefined)[] = services.length
    ? services.map((service) => [service])
    : [undefined];
  const makers: (WebScanFilter['manufacturerData'] | undefined)[] = manufacturerData.length
    ? manufacturerData.map(({ companyId, data, mask }) => [
        {
          companyIdentifier: companyId,
          ...(data && { dataPrefix: data }),
          ...(mask && { mask }),
        },
      ])
    : [undefined];
  const filters: WebScanFilter[] = serviceSets.flatMap((set) =>
    makers.map((maker) => ({
      ...(set && { services: set }),
      ...(namePrefix !== undefined && { namePrefix }),
      ...(maker && { manufacturerData: maker }),
    }))
  );
  const optionalServices = options.web.optionalServices;
  if (filters.every((filter) => Object.keys(filter).length === 0)) {
    return { acceptAllDevices: true, ...(optionalServices.length && { optionalServices }) };
  }
  return { filters, ...(optionalServices.length && { optionalServices }) };
}

/** RSSI where the chooser doesn't report one: 127, the "not available" value of the HCI spec. */
export const UNKNOWN_RSSI = 127;

/** The picked device as the scan's one result. The chooser reports no advertisement. */
export function pickedResult(device: WebBluetoothDevice): ScanResult {
  return {
    id: device.id,
    name: device.name ?? null,
    rssi: UNKNOWN_RSSI,
    txPowerLevel: null,
    isConnectable: true,
    serviceUUIDs: [],
    serviceData: {},
    manufacturerData: {},
    rawAdvertisement: null,
    timestamp: Date.now(),
  };
}
