/** Runs work later, and tells the time. Abstracted so queue timing can be tested in virtual time. */
export interface Scheduler {
  /** Monotonic milliseconds. */
  now(): number;
  /** Soon, but never inside the caller (the native queues post to their thread the same way). */
  schedule(work: () => void): void;
  /** Returns a cancel function. */
  scheduleAfter(ms: number, work: () => void): () => void;
}

/** `Scheduler` on JS timers; Jest fake timers drive it in tests. */
export const timerScheduler: Scheduler = {
  now: () => Date.now(),
  schedule: (work) => {
    setTimeout(work, 0);
  },
  scheduleAfter: (ms, work) => {
    const timer = setTimeout(work, ms);
    return () => clearTimeout(timer);
  },
};
