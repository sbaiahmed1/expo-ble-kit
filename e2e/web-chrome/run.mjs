#!/usr/bin/env node
// P6-02: the Explorer's basic flow in desktop Chrome over Web Bluetooth, this Mac's Chrome being
// the central. Chrome's device chooser is driven through DevTools (the DeviceAccess domain, as
// Puppeteer does), and taps are DevTools input events, which count as the person's: Chrome opens
// the chooser only after one.
//
// Usage: node e2e/web-chrome/run.mjs [url] [device name prefix]
//   url     the example's web build; default http://localhost:8092
//           (cd example && BROWSER=none yarn expo start --web --port 8092)
//   prefix  the test peripheral's name; default BleKit
// RECORD=<dir> saves the page as screencast frames and an ffmpeg concat list (the promo video's
// footage: ffmpeg -f concat -i <dir>/frames.ffconcat ...); PACE=<ms> pauses after each step so a
// viewer can follow; WINDOW=<width,height> sizes the window (default 1100,900).
// The test peripheral must be another device: the example on a phone serving the test profile
// (Peripheral tab, or the expo.modules.blekit.example://server/serve link), or the Bumble one.
// Chrome runs with a throwaway profile; macOS may ask once to let Chrome use Bluetooth.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:8092';
const prefix = process.argv[3] ?? 'BleKit';
const port = Number(process.env.CDP_PORT ?? 9333);
const chrome = process.env.CHROME_APP ?? '/Applications/Google Chrome.app';

const TEST = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const STATIC_READ = '0c6c1001-b347-4cfa-9827-1c5a13658519';
const LONG_READ = '0c6c1002-b347-4cfa-9827-1c5a13658519';
const ECHO_WRITE = '0c6c1003-b347-4cfa-9827-1c5a13658519';
const ECHO_READ = '0c6c1004-b347-4cfa-9827-1c5a13658519';
const HEART_RATE_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = mkdtempSync(join(tmpdir(), 'blekit-chrome-'));
// Through `open`, so Chrome is its own responsible process: started by this script, macOS would
// check Bluetooth access against the terminal's app and stop Chrome for lacking a usage string.
spawn(
  'open',
  [
    '-na',
    chrome,
    '--args',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${process.env.WINDOW ?? '1100,900'}`,
    url,
  ],
  { stdio: 'ignore' }
);

async function cleanUp() {
  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const browser = await Session.open(version.webSocketDebuggerUrl);
    await browser.send('Browser.close').catch(() => {});
  } catch {
    // Chrome is gone already.
  }
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1000);
}

/** A DevTools session on one page. */
class Session {
  #socket;
  #next = 1;
  #pending = new Map();
  #handlers = new Map();

  static async open(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    return new Session(socket);
  }

  constructor(socket) {
    this.#socket = socket;
    socket.onclose = (event) => {
      const error = new Error(`DevTools closed the connection (${event.code} ${event.reason})`);
      this.#pending.forEach((waiter) => waiter.reject(error));
      this.#pending.clear();
    };
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const waiter = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(`${message.error.message}`));
        else waiter?.resolve(message.result);
      } else {
        this.#handlers.get(message.method)?.(message.params);
      }
    };
  }

  send(method, params = {}) {
    const id = this.#next++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  on(method, handler) {
    this.#handlers.set(method, handler);
  }

  close() {
    this.#socket.close();
  }
}

async function pageSession() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === 'page' && target.url.startsWith(url));
      if (page) return Session.open(page.webSocketDebuggerUrl);
    } catch {
      // Chrome is still starting.
    }
    await sleep(200);
  }
  throw new Error(`Chrome didn't open ${url}`);
}

async function main() {
  const trace = (line) => process.env.TRACE && console.log(`  [trace] ${line}`);
  const page = await pageSession();
  trace('page session open');
  await page.send('Runtime.enable');
  await page.send('DeviceAccess.enable');
  trace('DeviceAccess enabled');
  let prompt = null;
  page.on('DeviceAccess.deviceRequestPrompted', (params) => (prompt = params));
  page.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type === 'error' || type === 'warn') {
      console.log(`  page ${type}: ${args.map((arg) => arg.value ?? arg.description).join(' ')}`);
    }
  });

  const evaluate = async (expression) =>
    (await page.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const find = (testId) => `document.querySelector('[data-testid="${testId}"]')`;
  async function waitFor(condition, what, timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = await condition();
      if (value) return value;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await sleep(200);
    }
  }
  const textOf = (testId) => evaluate(`${find(testId)}?.innerText ?? null`);
  async function tap(testId) {
    const point = await waitFor(
      () =>
        evaluate(`(() => {
          const element = ${find(testId)};
          if (!element) return null;
          element.scrollIntoView({ block: 'center' });
          const r = element.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`),
      testId
    );
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', {
        type,
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      });
    }
  }
  const pace = Number(process.env.PACE ?? 0);
  const step = async (line) => {
    console.log(`- ${line}`);
    if (pace) await sleep(pace);
  };
  const frames = [];
  if (process.env.RECORD) {
    mkdirSync(process.env.RECORD, { recursive: true });
    page.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      const file = `frame-${String(frames.length).padStart(5, '0')}.jpg`;
      writeFileSync(join(process.env.RECORD, file), Buffer.from(data, 'base64'));
      frames.push({ file, time: metadata.timestamp });
      page.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await page.send('Page.enable');
    await page.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1600, maxHeight: 1200 });
    await sleep(1500);
  }
  const finishRecording = async () => {
    if (!process.env.RECORD || frames.length === 0) return;
    await sleep(1500);
    await page.send('Page.stopScreencast').catch(() => {});
    // Frames arrive when the page changes, not always in order: sorted by time, each lasts until
    // the next one, and a frame with the time of the one before replaces it.
    const ordered = [...frames]
      .sort((a, b) => a.time - b.time)
      .filter((frame, index, all) => index === all.length - 1 || all[index + 1].time > frame.time);
    const lines = ['ffconcat version 1.0'];
    ordered.forEach((frame, index) => {
      const next = ordered[index + 1]?.time ?? frame.time + 1;
      lines.push(`file ${frame.file}`, `duration ${(next - frame.time).toFixed(3)}`);
    });
    lines.push(`file ${ordered[ordered.length - 1].file}`);
    writeFileSync(join(process.env.RECORD, 'frames.ffconcat'), lines.join('\n') + '\n');
    writeFileSync(join(process.env.RECORD, 'frames.json'), JSON.stringify(frames));
    console.log(`- recorded ${frames.length} frames into ${process.env.RECORD}`);
  };

  // 1–3. Scan (the chooser opens), pick a device named like the test peripheral, open it from
  // the list and connect, with discovery. Chrome may show a phone under its system name, and
  // several devices may share it: each is tried until one has the TEST service.
  const tried = new Set();
  let services = null;
  for (let round = 1; !services; round++) {
    prompt = null;
    await tap('scan-toggle');
    trace('tapped scan');
    const picked = await waitFor(
      () => {
        const device = prompt?.devices.find((d) => d.name?.startsWith(prefix) && !tried.has(d.id));
        return device && { promptId: prompt.id, device };
      },
      `a device named ${prefix}… in Chrome's chooser`,
      30_000
    ).catch(async (error) => {
      const listed = prompt
        ? prompt.devices.map((d) => d.name || d.id).join(', ') || 'nothing'
        : null;
      const status = await textOf('scan-status');
      throw new Error(
        `${error.message} (${listed === null ? 'no chooser opened' : `it listed ${listed}`}; ` +
          `the page says: ${status})`
      );
    });
    tried.add(picked.device.id);
    await step(`chooser listed ${prompt.devices.length} devices; picking ${picked.device.name}`);
    await page.send('DeviceAccess.selectPrompt', {
      id: picked.promptId,
      deviceId: picked.device.id,
    });

    const rowId = await waitFor(
      () =>
        evaluate(
          `[...document.querySelectorAll('[data-testid^="device-"]')].map((e) => e.dataset.testid)` +
            `.find((id) => id !== 'device-state' && id !== 'device-error') ?? null`
        ),
      'the picked device in the list'
    );
    await tap(rowId);
    await tap('connect');
    const state = await waitFor(async () => {
      const error = await textOf('device-error');
      if (error) return `failed: ${error}`;
      const text = await textOf('device-state');
      return text?.startsWith('Connected') && text;
    }, 'the connection');
    await step(`${rowId}: ${state}`);
    const found = state.startsWith('Connected')
      ? await waitFor(
          () =>
            evaluate(
              `[...document.querySelectorAll('[data-testid^="service-"]')]` +
                `.map((e) => e.dataset.testid.slice(8))`
            ).then((list) => list.length && list),
          'discovered services',
          10_000
        ).catch(() => [])
      : [];
    if (found.includes(TEST)) {
      services = found;
    } else {
      await step(`no TEST service there (${found.join(', ') || 'none'}); trying the next one`);
      if (state.startsWith('Connected')) await tap('disconnect');
      await tap('explorer-back');
      if (round >= 6) throw new Error('none of the devices had the TEST service');
    }
  }
  await step(`services: ${services.join(', ')}`);

  // 4. Reads: one packet, then 512 bytes (a long read).
  const valueAfter = async (button, uuid) => {
    await tap(button);
    return waitFor(async () => {
      const error = await textOf(`error-${uuid}`);
      if (error) throw new Error(`${button}: ${error}`);
      return textOf(`value-${uuid}-hex`);
    }, `the value of ${uuid}`);
  };
  const staticValue = await valueAfter(`read-${STATIC_READ}`, STATIC_READ);
  await step(`STATIC_READ: ${staticValue}`);
  const longValue = await valueAfter(`read-${LONG_READ}`, LONG_READ);
  await step(
    `LONG_READ: ${longValue.split(/\s+/).length} bytes shown, starting ${longValue.slice(0, 23)}`
  );

  // 5. Write, and read it back.
  await tap(`write-input-${ECHO_WRITE}`);
  await page.send('Input.insertText', { text: 'hello web' });
  await tap(`write-${ECHO_WRITE}`);
  await sleep(500);
  const echoed = await valueAfter(`read-${ECHO_READ}`, ECHO_READ);
  await step(`ECHO_READ after writing "hello web": ${echoed}`);

  // 6. Notifications.
  await tap(`subscribe-${HEART_RATE_MEASUREMENT}`);
  const subscribed = await waitFor(async () => {
    const title = await textOf(`subscribe-${HEART_RATE_MEASUREMENT}`);
    const count = Number(/\((\d+)\)/.exec(title ?? '')?.[1] ?? 0);
    return count >= 3 && title;
  }, 'three heart rate notifications');
  await step(`heart rate: ${subscribed}, last ${await textOf(`value-${HEART_RATE_MEASUREMENT}-hex`)}`);

  // 7. Disconnect.
  await tap('disconnect');
  const after = await waitFor(async () => {
    const text = await textOf('device-state');
    return text === 'disconnected' && text;
  }, 'the disconnection');
  await step(`state: ${after}`);
  await finishRecording();
  page.close();
}

main().then(
  () => {
    console.log('Web Bluetooth flow passed');
    cleanUp();
  },
  (error) => {
    console.error(`Web Bluetooth flow failed: ${error.message}`);
    cleanUp();
    process.exitCode = 1;
  }
);
