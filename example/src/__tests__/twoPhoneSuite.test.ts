import { startDemo } from '../demo/testPeripheral';
import { TestProfile } from '../lib/gattNames';
import { describeSuite, runTwoPhoneSuite, type SuiteCheck } from '../lib/twoPhoneSuite';

// P4-05: phone A's suite against the demo's virtual test peripheral. A virtual peripheral can't
// refuse a write, so the invalid CONTROL commands get injected errors, as phone B answers them.

async function finish<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.finally(() => (done = true)).catch(() => {});
  while (!done) await jest.advanceTimersByTimeAsync(100);
  return promise;
}

describe('two-phone suite', () => {
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    jest.useFakeTimers();
    demo = startDemo(1);
  });

  afterEach(() => {
    demo.stop();
    jest.useRealTimers();
  });

  it('passes against a test peripheral', async () => {
    const seen: string[] = [];
    const report = await finish(
      runTwoPhoneSuite({
        streamSeconds: 3,
        onCheck: (check: SuiteCheck) => {
          seen.push(check.name);
          if (check.name === 'INDICATE') {
            demo.ble.injectError({ op: 'write', characteristic: TestProfile.CONTROL }, 'NOT_SUPPORTED');
            demo.ble.injectError({ op: 'write', characteristic: TestProfile.CONTROL }, 'INVALID_ATTRIBUTE_LENGTH');
          }
        },
      })
    );
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(seen).toEqual([
      'find',
      'connect',
      'STATIC_READ',
      'LONG_READ',
      'ECHO',
      'SINK',
      'STREAM',
      'INDICATE',
      'CONTROL errors',
      'Heart Rate',
      'L2CAP echo',
    ]);
    expect(report.checks.at(-1)?.detail).toMatch(/^1024 KB each way over PSM 0x81: sent in/);
    expect(describeSuite(report)).toBe('Two-phone suite OK: 11/11 checks');
  });

  it('fails a check without stopping the others, and names it', async () => {
    const report = await finish(runTwoPhoneSuite({ streamSeconds: 1 }));
    // Without injected errors the demo accepts the invalid commands.
    expect(report.checks.find((check) => check.name === 'CONTROL errors')).toMatchObject({
      ok: false,
      detail: 'unknown opcode: accepted, bad parameters: accepted',
    });
    expect(report.checks.at(-1)?.name).toBe('L2CAP echo');
    expect(describeSuite(report)).toBe('Two-phone suite FAILED: 10/11 checks (CONTROL errors)');
  });

  it('reports a missing peripheral', async () => {
    demo.device.advertise(false);
    const report = await finish(runTwoPhoneSuite());
    expect(describeSuite(report)).toBe('Two-phone suite FAILED: 0/1 checks (find)');
  });
});
