import type { BleState } from './types';

export type StateChangeEvent = { state: BleState };

export type ExpoBleKitModuleEvents = {
  stateChange: (event: StateChangeEvent) => void;
};
