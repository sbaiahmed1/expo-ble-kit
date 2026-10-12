import { Image } from 'react-native';

import { BleError, BleErrorCode } from '../errors';
import type { AccessoryPickerItem } from '../types';
import { normalizeUUID } from '../uuid';

/** `showAccessoryPicker`'s default: it waits for the person, then closes the picker. */
export const DEFAULT_PICKER_TIMEOUT_MS = 300_000;

/** What the native `showAccessoryPicker` takes per item: the image as a URI. */
export type NativeAccessoryPickerItem = {
  name: string;
  productImage: string;
  service: string | null;
  companyId: number | null;
  nameSubstring: string | null;
  manufacturerData: { data: Uint8Array; mask: Uint8Array } | null;
  serviceData: { data: Uint8Array; mask: Uint8Array } | null;
  immediateRange: boolean;
};

function invalid(index: number, problem: string): BleError {
  return new BleError(
    BleErrorCode.INVALID_ARGUMENT,
    `Invalid accessory picker item ${index}: ${problem}`
  );
}

function masked(index: number, option: string, value: unknown) {
  if (value === undefined) return null;
  const { data, mask } = (value ?? {}) as { data?: unknown; mask?: unknown };
  if (
    !(data instanceof Uint8Array) ||
    !(mask instanceof Uint8Array) ||
    data.length === 0 ||
    data.length !== mask.length
  ) {
    throw invalid(index, `${option} needs data and mask, Uint8Arrays of the same length`);
  }
  return { data, mask };
}

/**
 * Validates the items as AccessorySetupKit needs them (Apple's ASDiscoveryDescriptor rules): a
 * service or a company id per item, manufacturer data with a company id, service data with a
 * service. A `require()`d image becomes its URI.
 */
export function toNativePickerItems(items: unknown): NativeAccessoryPickerItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new BleError(
      BleErrorCode.INVALID_ARGUMENT,
      'The accessory picker needs at least one item'
    );
  }
  return items.map((raw, index) => {
    const item = (raw ?? {}) as Partial<AccessoryPickerItem>;
    if (typeof item.name !== 'string' || item.name.length === 0)
      throw invalid(index, 'name must be a non-empty string');
    // require() gives an asset id in an app; anything that isn't a URI goes through React Native.
    const image =
      typeof item.productImage === 'string'
        ? item.productImage
        : Image.resolveAssetSource(item.productImage as never)?.uri;
    if (typeof image !== 'string' || image.length === 0) {
      throw invalid(index, 'productImage must be an image from require() or a URI');
    }
    const service = item.service === undefined ? null : normalizeUUID(item.service);
    const companyId = item.companyId ?? null;
    if (
      companyId !== null &&
      (!Number.isInteger(companyId) || companyId < 0 || companyId > 0xffff)
    ) {
      throw invalid(index, 'companyId must be an integer from 0 to 0xFFFF');
    }
    if (service === null && companyId === null)
      throw invalid(index, 'it needs a service or a companyId');
    const nameSubstring = item.nameSubstring ?? null;
    if (
      nameSubstring !== null &&
      (typeof nameSubstring !== 'string' || nameSubstring.length === 0)
    ) {
      throw invalid(index, 'nameSubstring must be a non-empty string');
    }
    const manufacturerData = masked(index, 'manufacturerData', item.manufacturerData);
    if (manufacturerData && companyId === null)
      throw invalid(index, 'manufacturerData needs a companyId');
    const serviceData = masked(index, 'serviceData', item.serviceData);
    if (serviceData && service === null) throw invalid(index, 'serviceData needs a service');
    if (item.immediateRange !== undefined && typeof item.immediateRange !== 'boolean') {
      throw invalid(index, 'immediateRange must be a boolean');
    }
    return {
      name: item.name,
      productImage: image,
      service,
      companyId,
      nameSubstring,
      manufacturerData,
      serviceData,
      immediateRange: item.immediateRange ?? false,
    };
  });
}
