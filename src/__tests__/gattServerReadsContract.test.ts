import { readFileSync } from 'fs';
import { resolve } from 'path';

import { toNativeServices } from '../internal/gattServer';
import { getNativeModule } from '../internal/native';
import { installFakeBle } from '../testing';
import type { FakeBleAdapter } from '../testing/FakeBleAdapter';

// The shared long-read contract (test-contracts/gatt-server-reads.json), run against the fake GATT
// server; the Kotlin and Swift servers run the same cases.

type Step = {
  read?: { central: string; characteristic: string; offset: number };
  handlerValue?: string;
  expect?: { handler: number | null; response: string };
  advance?: number;
  disconnect?: string;
};

const contract: { cases: { name: string; steps: Step[] }[] } = JSON.parse(
  readFileSync(resolve(__dirname, '../../test-contracts/gatt-server-reads.json'), 'utf8')
);
const C1 = '0c6c2001-b347-4cfa-9827-1c5a13658519';
const C2 = '0c6c2002-b347-4cfa-9827-1c5a13658519';
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const bytes = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));

describe('GATT server long-read contract', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each(contract.cases.map((c) => [c.name, c] as const))('%s', async (_, contractCase) => {
    installFakeBle();
    const adapter = getNativeModule() as FakeBleAdapter;
    const opening = adapter.openGattServer(
      toNativeServices([
        {
          uuid: '0c6c2000-b347-4cfa-9827-1c5a13658519',
          characteristics: [C1, C2].map((uuid) => ({
            uuid,
            properties: ['read' as const],
            permissions: ['readable' as const],
          })),
        },
      ])
    );
    await jest.advanceTimersByTimeAsync(1);
    const server = await opening;
    let asked: number | null = null;
    let handlerValue = new Uint8Array(0);
    server.addListener('readRequest', ({ requestId, offset }) => {
      asked = offset;
      server.respondToRead(requestId, handlerValue, null);
    });
    for (const [index, step] of contractCase.steps.entries()) {
      const label = `step ${index + 1}`;
      if (step.advance !== undefined) {
        await jest.advanceTimersByTimeAsync(step.advance);
      } else if (step.disconnect) {
        server.disconnectCentral(step.disconnect);
      } else if (step.read && step.expect) {
        asked = null;
        handlerValue = bytes(step.handlerValue ?? '');
        const characteristic = step.read.characteristic === 'c1' ? C1 : C2;
        const answer = await server.readAt(step.read.central, characteristic, step.read.offset);
        expect({ label, handler: asked }).toEqual({ label, handler: step.expect.handler });
        if (step.expect.response === 'INVALID_OFFSET') {
          expect({ label, status: answer.status }).toEqual({ label, status: 0x07 });
        } else {
          expect({ label, response: hex(answer.value ?? new Uint8Array(0)) }).toEqual({
            label,
            response: step.expect.response,
          });
        }
      }
    }
  });
});
