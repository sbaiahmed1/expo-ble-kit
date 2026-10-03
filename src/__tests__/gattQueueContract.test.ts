import { readFileSync } from 'fs';
import { resolve } from 'path';

import { BleError, BleErrorCode } from '../errors';
import { GattQueue, type GattOperation } from '../internal/gattQueue';
import type { Scheduler } from '../internal/scheduler';

// The shared GATT queue contract (test-contracts/gatt-queue.json): the Swift and Kotlin queues run
// the same cases (GattQueueContractTests.swift, GattQueueContractTest.kt).

interface Step {
  enqueue?: string;
  timeoutMs?: number;
  first?: boolean;
  thenFirst?: string;
  complete?: string;
  error?: BleErrorCode;
  cancel?: string;
  failAll?: BleErrorCode;
  advance?: number;
  expect?: { started?: string[]; results?: Record<string, string | null>; depth?: number };
}

const contract: { cases: { name: string; steps: Step[] }[] } = JSON.parse(
  readFileSync(resolve(__dirname, '../../test-contracts/gatt-queue.json'), 'utf8')
);

/** Virtual time: work runs only when the test advances it, in time order, then submission order. */
class ManualScheduler implements Scheduler {
  private time = 0;
  private nextId = 0;
  private tasks: { id: number; at: number; work: () => void; cancelled: boolean }[] = [];

  now = () => this.time;

  schedule = (work: () => void) => {
    this.add(this.time, work);
  };

  scheduleAfter = (ms: number, work: () => void) => {
    const task = this.add(this.time + Math.max(0, ms), work);
    return () => {
      task.cancelled = true;
    };
  };

  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const due = this.tasks
        .filter((task) => !task.cancelled && task.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.tasks.splice(this.tasks.indexOf(due), 1);
      this.time = due.at;
      due.work();
    }
    this.tasks = this.tasks.filter((task) => !task.cancelled);
    this.time = target;
  }

  private add(at: number, work: () => void) {
    const task = { id: this.nextId++, at, work, cancelled: false };
    this.tasks.push(task);
    return task;
  }
}

describe('GATT queue contract (shared with the native cores)', () => {
  it.each(contract.cases.map((c) => [c.name, c.steps] as const))('%s', (_, steps) => {
    const scheduler = new ManualScheduler();
    const queue = new GattQueue(scheduler);
    const operations = new Map<string, GattOperation>();
    const started: string[] = [];
    const results = new Map<string, string>();

    const enqueue = (name: string, timeoutMs?: number, first?: boolean, thenFirst?: string) => {
      operations.set(
        name,
        queue.enqueue(
          'read',
          { target: name, timeoutMs, first },
          () => started.push(name),
          (result) => {
            results.set(name, result.ok ? 'ok' : result.error.code);
            if (result.ok && thenFirst !== undefined) enqueue(thenFirst, undefined, true);
          }
        )
      );
    };

    for (const step of steps) {
      if (step.enqueue !== undefined) {
        enqueue(step.enqueue, step.timeoutMs, step.first, step.thenFirst);
      } else if (step.complete !== undefined) {
        const name = step.complete;
        const result = step.error
          ? { ok: false as const, error: new BleError(step.error, 'from the radio') }
          : { ok: true as const, value: undefined };
        queue.complete(result, (operation) => operation.target === name);
      } else if (step.cancel !== undefined) {
        queue.cancel(operations.get(step.cancel)!);
      } else if (step.failAll !== undefined) {
        queue.failAll(new BleError(step.failAll, 'failed'));
      } else if (step.advance !== undefined) {
        scheduler.advance(step.advance);
      }
      scheduler.advance(0);

      if (step.expect) {
        const { started: startedNow, results: expected, depth } = step.expect;
        if (startedNow) expect(started).toEqual(startedNow);
        for (const [name, value] of Object.entries(expected ?? {})) {
          expect([name, results.get(name) ?? null]).toEqual([name, value]);
        }
        if (depth !== undefined) expect(queue.depth).toBe(depth);
      }
    }
  });
});
