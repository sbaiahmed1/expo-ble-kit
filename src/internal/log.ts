import { BleError } from '../errors';
import type { LogEntry, LogLevel } from '../types';
import { reportListenerError } from './operations';

// The JS side of the log (plan §4.16): the level JS asked for, the app's handler, and entries the
// TS layer writes itself. Native entries arrive filtered by the same level.

const LEVELS: readonly LogLevel[] = ['none', 'error', 'warn', 'info', 'debug', 'verbose'];

/** The default level (plan §4.16): errors and warnings. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'warn';

let level: LogLevel = DEFAULT_LOG_LEVEL;
let handler: ((entry: LogEntry) => void) | null = null;

export function checkLogLevel(value: unknown): LogLevel {
  if (!LEVELS.includes(value as LogLevel)) {
    throw new BleError(
      'INVALID_ARGUMENT',
      `Invalid log level: expected one of ${LEVELS.join(', ')}`
    );
  }
  return value as LogLevel;
}

export function setLevel(next: LogLevel): void {
  level = next;
}

export function setHandler(next: ((entry: LogEntry) => void) | null): void {
  handler = next;
}

export function isOn(entryLevel: LogLevel): boolean {
  return entryLevel !== 'none' && LEVELS.indexOf(entryLevel) <= LEVELS.indexOf(level);
}

/** Gives `entry` to the app's handler; a throwing handler is reported, not propagated. */
export function deliver(entry: LogEntry): void {
  try {
    handler?.(entry);
  } catch (error) {
    reportListenerError(error);
  }
}

/** An entry from the TS layer itself, such as a failed fire-and-forget `remove()`. */
export function log(entryLevel: LogLevel, message: string, peripheralId?: string): void {
  if (!handler || !isOn(entryLevel)) return;
  deliver({
    level: entryLevel,
    message,
    timestamp: Date.now(),
    ...(peripheralId && { peripheralId }),
  });
}
