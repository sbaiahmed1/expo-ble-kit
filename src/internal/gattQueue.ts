import { BleError, BleErrorCode } from '../errors';
import type { Scheduler } from './scheduler';

export type GattOperationKind =
  | 'discoverServices'
  | 'read'
  | 'write'
  | 'writeWithoutResponse'
  | 'readDescriptor'
  | 'writeDescriptor'
  | 'setNotify'
  | 'readRssi'
  | 'requestMtu'
  | 'bond';

export type GattResult<T = unknown> = { ok: true; value: T } | { ok: false; error: BleError };

/** One operation waiting in, or running through, a `GattQueue`. */
export interface GattOperation {
  readonly id: number;
  readonly kind: GattOperationKind;
  /** Identifies what the operation acts on, so a result can be matched to it. */
  readonly target: string | undefined;
  readonly timeoutMs: number;
  /** The caller was already answered (cancelled); the operation may still occupy the radio. */
  readonly settled: boolean;
}

interface Entry extends GattOperation {
  settled: boolean;
  /** When it started (scheduler time), for its duration in the log. */
  startedAt?: number;
  start: () => void;
  completion: (result: GattResult) => void;
  cancelTimer?: () => void;
}

/**
 * The TypeScript twin of the native `GattQueue` (plan §4.9), used by the fake adapter. The same
 * contract cases (`test-contracts/gatt-queue.json`) run against all three, so the fake orders and
 * fails operations exactly like the native cores:
 *
 * - one operation in flight; the next starts only after it completes, times out, or the queue fails;
 * - every operation has a timeout, and every caller is answered exactly once;
 * - cancelling a queued operation removes it; cancelling the running one answers at once, but the
 *   queue stays busy until the radio answers or the timeout fires;
 * - a result arriving after its operation timed out is ignored.
 */
export class GattQueue {
  static readonly DEFAULT_TIMEOUT_MS = 10_000;

  private readonly pending: Entry[] = [];
  private running: Entry | null = null;
  private nextId = 1;
  private pumpScheduled = false;
  /** Every caller answered, with how long the operation ran (null if it never started): the log. */
  onSettled:
    ((operation: GattOperation, result: GattResult, elapsedMs: number | null) => void) | null =
    null;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly defaultTimeoutMs = GattQueue.DEFAULT_TIMEOUT_MS
  ) {}

  get current(): GattOperation | null {
    return this.running;
  }

  /** Queued plus in-flight operations. */
  get depth(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  /**
   * Queues an operation. `first` queues it ahead of the queued ones: a completion that queues the
   * next part of its work this way keeps its place (writeStream chunks, P2-03).
   */
  enqueue<T>(
    kind: GattOperationKind,
    options: { target?: string; timeoutMs?: number; first?: boolean },
    start: () => void,
    completion: (result: GattResult<T>) => void
  ): GattOperation {
    const entry: Entry = {
      id: this.nextId++,
      kind,
      target: options.target,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      settled: false,
      start,
      completion: completion as (result: GattResult) => void,
    };
    if (options.first) {
      this.pending.unshift(entry);
    } else {
      this.pending.push(entry);
    }
    this.schedulePump();
    return entry;
  }

  /** Completes the in-flight operation if it matches. Returns false for late or foreign results. */
  complete(result: GattResult, matches: (operation: GattOperation) => boolean): boolean {
    const entry = this.running;
    if (!entry || !matches(entry)) {
      return false;
    }
    this.finishCurrent();
    this.settle(entry, result);
    return true;
  }

  /** Answers the caller with OPERATION_CANCELLED (plan §4.9). */
  cancel(operation: GattOperation): void {
    const entry = operation as Entry;
    const index = this.pending.indexOf(entry);
    if (index >= 0) {
      this.pending.splice(index, 1);
    }
    this.settle(
      entry,
      failure(BleErrorCode.OPERATION_CANCELLED, `Operation ${entry.kind} was cancelled`)
    );
  }

  /** Fails the running and all queued operations, for example on disconnection (rule 5). */
  failAll(error: BleError): void {
    const entries = [...(this.running ? [this.running] : []), ...this.pending];
    this.running?.cancelTimer?.();
    this.running = null;
    this.pending.length = 0;
    entries.forEach((entry) => this.settle(entry, { ok: false, error }));
  }

  private schedulePump(): void {
    if (this.pumpScheduled) {
      return;
    }
    this.pumpScheduled = true;
    // Always asynchronous: an operation can complete inside `start`, and the next one must not
    // start re-entrantly from inside that callback.
    this.scheduler.schedule(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) {
      return;
    }
    const entry = this.pending.shift();
    if (!entry) {
      return;
    }
    this.running = entry;
    entry.startedAt = this.scheduler.now();
    entry.cancelTimer = this.scheduler.scheduleAfter(entry.timeoutMs, () => this.timeOut(entry));
    entry.start();
  }

  private settle(entry: Entry, result: GattResult): void {
    if (entry.settled) return;
    settle(entry, result);
    const elapsed = entry.startedAt === undefined ? null : this.scheduler.now() - entry.startedAt;
    this.onSettled?.(entry, result, elapsed);
  }

  private finishCurrent(): void {
    this.running?.cancelTimer?.();
    this.running = null;
    this.schedulePump();
  }

  private timeOut(entry: Entry): void {
    if (this.running !== entry) {
      return;
    }
    this.finishCurrent();
    this.settle(
      entry,
      failure(
        BleErrorCode.OPERATION_TIMEOUT,
        `Operation ${entry.kind} timed out after ${entry.timeoutMs} ms`
      )
    );
  }
}

function settle(entry: Entry, result: GattResult): void {
  if (entry.settled) {
    return;
  }
  entry.settled = true;
  entry.completion(result);
}

function failure(code: BleErrorCode, message: string): GattResult {
  return { ok: false, error: new BleError(code, message) };
}
