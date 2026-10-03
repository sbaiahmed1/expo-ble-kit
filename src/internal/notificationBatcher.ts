import type { Scheduler } from './scheduler';

/** What a batcher hands over: the values, their arrival times, and how many were dropped. */
export interface CollectedBatch {
  values: Uint8Array[];
  timestamps: number[];
  dropped: number;
}

/**
 * The TypeScript twin of the native batchers (plan §4.10, P2-04), used by the fake adapter: one
 * subscriber's values, handed over at most once per `intervalMs`. The first value of an empty batch
 * starts the interval. A batch holds at most `maxItems` values; older ones are dropped and counted,
 * and `onFirstDrop` hears about the first drop.
 */
export class NotificationBatcher {
  private values: Uint8Array[] = [];
  private timestamps: number[] = [];
  private dropped = 0;
  private everDropped = false;
  private cancelTimer: (() => void) | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly maxItems: number,
    private readonly scheduler: Scheduler,
    private readonly onFirstDrop: () => void,
    private readonly deliver: (batch: CollectedBatch) => void
  ) {}

  add(value: Uint8Array, timestamp: number): void {
    if (this.values.length === this.maxItems) {
      this.values.shift();
      this.timestamps.shift();
      this.dropped++;
      if (!this.everDropped) {
        this.everDropped = true;
        this.onFirstDrop();
      }
    }
    this.values.push(value);
    this.timestamps.push(timestamp);
    this.cancelTimer ??= this.scheduler.scheduleAfter(this.intervalMs, () => {
      this.cancelTimer = null;
      this.flush();
    });
  }

  /** Hands over what was collected, if anything (also when the subscription ends with the link). */
  flush(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.values.length === 0 && this.dropped === 0) return;
    const batch = { values: this.values, timestamps: this.timestamps, dropped: this.dropped };
    this.values = [];
    this.timestamps = [];
    this.dropped = 0;
    this.deliver(batch);
  }

  /** Drops what was collected: the subscriber was removed, so delivery stops at once. */
  cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.values = [];
    this.timestamps = [];
    this.dropped = 0;
  }
}
