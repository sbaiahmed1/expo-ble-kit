import { guard } from './internal/operations';
import type { NativeBleKitPort } from './internal/port';
import type { Advertisement } from './types';

/** A running advertisement (plan §5.5, P4-03). Native knows it by id, so a stale object can't stop a newer one. */
export class AdvertisementImpl implements Advertisement {
  private stopped = false;

  constructor(
    private readonly native: Pick<NativeBleKitPort, 'stopAdvertising'>,
    private readonly id: number
  ) {}

  stop(): Promise<void> {
    return guard(async () => {
      if (this.stopped) return;
      this.stopped = true;
      await this.native.stopAdvertising(this.id);
    });
  }
}
