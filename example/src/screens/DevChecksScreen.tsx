import { useEffect, useRef, useState } from 'react';
import { Button, Platform, Text, View } from 'react-native';

import {
  BleError,
  BleManager,
  useBlePermissions,
  useBleState,
  usePeripheral,
  useScan,
  type BlePermissions,
  type ScanResult,
  type ScanSession,
} from 'expo-ble-kit';

// Developer checks on the public API (P1-12): adapter state, permissions, scanning, and
// connections to a device that isn't there.

const TEST_SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const TEST_NAME = 'BleKit-Test';
const ECHO_WRITE = '0c6c1003-b347-4cfa-9827-1c5a13658519';
const STREAM = '0c6c1007-b347-4cfa-9827-1c5a13658519';
// A device that isn't there: a random static address on Android, an unknown id on iOS.
const ABSENT_ID =
  Platform.OS === 'android' ? 'C0:FF:EE:00:00:99' : '0C6C0000-0000-4000-8000-000000000099';

const hex = (bytes: Uint8Array | null | undefined) =>
  bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ') : 'null';

function describeResult(result: ScanResult) {
  return JSON.stringify(
    {
      ...result,
      serviceData: Object.fromEntries(
        Object.entries(result.serviceData).map(([k, v]) => [k, hex(v)])
      ),
      manufacturerData: Object.fromEntries(
        Object.entries(result.manufacturerData).map(([k, v]) => [k, hex(v)])
      ),
      rawAdvertisement: hex(result.rawAdvertisement),
      timestamp: `${result.timestamp} (now ${Date.now()})`,
    },
    null,
    1
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const time = () => new Date().toISOString().slice(14, 23);
const describeError = (error: unknown) => {
  const bleError = BleError.fromNative(error);
  return `${bleError.code}: ${bleError.message}`;
};

export function DevChecksScreen() {
  const state = useBleState();
  const [stateLog, setStateLog] = useState<string[]>([]);
  const [permissions, requestPermissions] = useBlePermissions();
  const [result, setResult] = useState('');
  const [sessions, setSessions] = useState<Record<number, { label: string; ids: string[] }>>({});
  const [testResult, setTestResult] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [connectLog, setConnectLog] = useState<string[]>([]);
  const [nearbyEnabled, setNearbyEnabled] = useState(false);
  const nearby = useScan({ enabled: nearbyEnabled, maxResults: 5 });
  const { peripheral, state: absentState, error: absentError } = usePeripheral(ABSENT_ID);
  const absent = peripheral!;
  const scans = useRef<Record<number, ScanSession>>({});
  const nextSession = useRef(1);

  const addConnectLog = (line: string) =>
    setConnectLog((lines) => [`${time()} ${line}`, ...lines].slice(0, 10));
  const addLog = (line: string) => setLog((lines) => [`${time()} ${line}`, ...lines].slice(0, 12));

  useEffect(() => {
    setStateLog((lines) =>
      [`${new Date().toISOString().slice(11, 23)} ${state}`, ...lines].slice(0, 8)
    );
  }, [state]);

  useEffect(() => {
    const listener = absent.addConnectionStateListener((next, error) => {
      addConnectLog(`state ${next}${error ? ` ${error.code}` : ''} (sync ${absent.state})`);
    });
    return () => listener.remove();
  }, [absent]);

  async function connectAbsent(timeoutMs: number | null, abortAfterMs?: number) {
    const started = Date.now();
    addConnectLog(
      `connect timeoutMs ${timeoutMs}${abortAfterMs ? `, abort after ${abortAfterMs} ms` : ''}`
    );
    const controller = new AbortController();
    if (abortAfterMs) setTimeout(() => controller.abort(), abortAfterMs);
    try {
      await absent.connect({ timeoutMs, signal: controller.signal });
      addConnectLog(`connected after ${Date.now() - started} ms`);
    } catch (error) {
      addConnectLog(`${BleError.fromNative(error).code} after ${Date.now() - started} ms`);
    }
  }

  // Not connected: each rejects with DISCONNECTED (subscribe too), through the public API.
  async function operationsOnAbsent() {
    const signal = new AbortController().signal;
    for (const [name, call] of [
      ['discover', () => absent.discover()],
      ['read', () => absent.read(TEST_SERVICE, ECHO_WRITE)],
      [
        'write',
        () => absent.write(TEST_SERVICE, ECHO_WRITE, new Uint8Array([1, 2, 3]), { signal }),
      ],
      ['subscribe', () => absent.subscribe(TEST_SERVICE, STREAM, () => {})],
      ['requestMtu', () => absent.requestMtu(517)],
      ['readRssi', () => absent.readRssi({ signal })],
      ['invalid UUID', () => absent.read('nope', ECHO_WRITE)],
      ['reconnect option', () => absent.connect({ reconnect: { maxAttempts: 1 } })],
    ] as const) {
      try {
        await call();
        addConnectLog(`${name}: ok`);
      } catch (error) {
        addConnectLog(`${name}: ${BleError.fromNative(error).code}`);
      }
    }
    addConnectLog(`mtu ${absent.mtu}, name ${absent.name}, services ${absent.services.length}`);
  }

  // Every cancelled attempt must close its GATT client: open clients stay at 0 (Android).
  async function cancelCycles() {
    addConnectLog('100 connect/cancel cycles');
    for (let cycle = 0; cycle < 100; cycle++) {
      const pending = absent.connect({ timeoutMs: null }).catch(() => {});
      await absent.disconnect();
      await pending;
    }
    showDiagnostics();
  }

  async function showDiagnostics() {
    const diagnostics = await BleManager.getDiagnostics();
    addConnectLog(
      `diagnostics: open GATT clients ${diagnostics.android?.openGattClients ?? 'n/a'}, ` +
        `sessions ${JSON.stringify(diagnostics.sessions)}, ` +
        `recent errors ${diagnostics.recentErrors.length} (last ${diagnostics.recentErrors.at(-1)?.code})`
    );
  }

  async function lookups() {
    try {
      const known = await BleManager.getKnownPeripherals([ABSENT_ID]);
      addConnectLog(`known: ${known.map((p) => p.id).join(', ') || 'none'}`);
      const connected = await BleManager.getSystemConnectedPeripherals([TEST_SERVICE, '180d']);
      addConnectLog(
        `system connected: ${connected.map((p) => `${p.id} ${p.name}`).join(', ') || 'none'}`
      );
    } catch (error) {
      addConnectLog(`lookup: ${describeError(error)}`);
    }
  }

  async function run(call: () => Promise<BlePermissions>) {
    setResult('…');
    try {
      setResult(JSON.stringify(await call()));
    } catch (error) {
      setResult(describeError(error));
    }
  }

  function startSession(label: string, options: Parameters<typeof BleManager.startScan>[0]) {
    const sessionId = nextSession.current++;
    setSessions((all) => ({ ...all, [sessionId]: { label, ids: [] } }));
    try {
      scans.current[sessionId] = BleManager.startScan(
        options,
        (results) => {
          const test = results.find((r) => r.name === TEST_NAME);
          if (test) setTestResult(describeResult(test));
          setSessions((all) => {
            const session = all[sessionId] ?? { label, ids: [] };
            const ids = [...session.ids];
            for (const r of results) {
              const entry = `${r.id} ${r.name ?? '—'} ${r.rssi}`;
              const index = ids.findIndex((existing) => existing.startsWith(`${r.id} `));
              if (index >= 0) ids[index] = entry;
              else ids.push(entry);
            }
            return { ...all, [sessionId]: { ...session, ids } };
          });
        },
        (error) => addLog(`session ${sessionId} ended: ${error.code}: ${error.message}`)
      );
      addLog(`session ${sessionId} (${label}) started`);
      return sessionId;
    } catch (error) {
      addLog(`session ${sessionId} failed: ${describeError(error)}`);
      return null;
    }
  }

  function stopAll() {
    Object.values(scans.current).forEach((session) => session.stop());
    addLog('stopped all sessions');
  }

  // P1-04 accept: 10 start/stop cycles within 20 s don't fail silently (warnings go to the log).
  async function throttleTest() {
    setSessions({});
    for (let cycle = 1; cycle <= 10; cycle++) {
      const id = startSession(`cycle ${cycle}`, {});
      await sleep(1000);
      if (id !== null) scans.current[id]?.stop();
      await sleep(1000);
    }
    addLog('10 cycles done; starting a final session');
    startSession('after throttle', {});
  }

  async function scanForTest() {
    addLog('scanFor TEST service, 10 s');
    try {
      const found = await BleManager.scanFor({ services: [TEST_SERVICE], timeoutMs: 10_000 });
      addLog(`scanFor: ${found ? `${found.id} ${found.name}` : 'nothing (null)'}`);
    } catch (error) {
      addLog(`scanFor: ${describeError(error)}`);
    }
  }

  return (
    <View>
      <Group name="Connecting">
        <Text testID="absent-state">{`absent: ${absentState}${absentError ? ` (${absentError.code})` : ''}`}</Text>
        <Button
          testID="connect-absent"
          title="Connect absent (5 s)"
          onPress={() => connectAbsent(5000)}
        />
        <Button
          testID="connect-absent-forever"
          title="Connect absent (no timeout)"
          onPress={() => connectAbsent(null)}
        />
        <Button
          testID="connect-absent-abort"
          title="Connect absent, abort after 2 s"
          onPress={() => connectAbsent(null, 2000)}
        />
        <Button
          testID="disconnect-absent"
          title="Disconnect absent"
          onPress={() => absent.disconnect()}
        />
        <Button testID="cancel-cycles" title="Connect/cancel ×100" onPress={cancelCycles} />
        <Button
          testID="read-write-absent"
          title="Operations on absent"
          onPress={operationsOnAbsent}
        />
        <Button testID="lookups" title="Known and system-connected" onPress={lookups} />
        <Button testID="diagnostics" title="Diagnostics" onPress={showDiagnostics} />
        <Text testID="connect-log" style={styles.result}>
          {connectLog.join('\n')}
        </Text>
      </Group>
      <Group name="Scanning">
        <Button testID="scan-all" title="Scan all" onPress={() => startSession('all', {})} />
        <Button
          testID="scan-test-service"
          title="Scan TEST service"
          onPress={() => startSession('TEST service', { services: [TEST_SERVICE] })}
        />
        <Button
          testID="scan-two"
          title="Two sessions: name BleKit + Apple data"
          onPress={() => {
            startSession('name BleKit', { namePrefix: 'BleKit' });
            startSession('Apple 0x004C', { manufacturerData: [{ companyId: 0x004c }] });
          }}
        />
        <Button testID="scan-for" title="scanFor TEST service (10 s)" onPress={scanForTest} />
        <Button testID="scan-stop-all" title="Stop all" onPress={stopAll} />
        <Button testID="scan-throttle" title="Throttle test (20 s)" onPress={throttleTest} />
        <Text testID="scan-log" style={styles.result}>
          {log.join('\n')}
        </Text>
        {Object.entries(sessions).map(([id, session]) => (
          <Text key={id} testID={`session-${id}`} style={styles.result}>
            {`#${id} ${session.label}: ${session.ids.length} devices\n`}
            {session.ids.slice(0, 5).join('\n')}
          </Text>
        ))}
        <Text testID="test-peripheral" style={styles.result}>
          {testResult}
        </Text>
      </Group>
      <Group name="useScan">
        <Button
          testID="nearby-toggle"
          title={nearbyEnabled ? 'Disable' : 'Enable'}
          onPress={() => setNearbyEnabled((enabled) => !enabled)}
        />
        <Text testID="nearby" style={styles.result}>
          {`scanning ${nearby.isScanning}, error ${nearby.error?.code ?? 'none'}, ${nearby.results.length} devices\n`}
          {nearby.results.map((r) => `${r.id} ${r.name ?? '—'} ${r.rssi}`).join('\n')}
        </Text>
      </Group>
      <Group name="Adapter state">
        <Text testID="state" style={styles.value}>
          {state}
        </Text>
        <Text testID="state-log">{stateLog.join('\n')}</Text>
      </Group>
      <Group name="Permissions">
        <Text testID="permissions-hook" style={styles.result}>
          {`useBlePermissions: ${JSON.stringify(permissions)}`}
        </Text>
        <Button
          testID="get-permissions"
          title="Get permissions"
          onPress={() => run(() => BleManager.getPermissionsAsync())}
        />
        <Button
          testID="request-permissions"
          title="Request permissions"
          onPress={() => run(() => requestPermissions())}
        />
        <Text testID="permissions-result" style={styles.result}>
          {result}
        </Text>
      </Group>
    </View>
  );
}

function Group(props: { name: string; children: React.ReactNode }) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupHeader}>{props.name}</Text>
      {props.children}
    </View>
  );
}

const styles = {
  groupHeader: { fontSize: 20, marginBottom: 20 },
  group: { marginBottom: 16, backgroundColor: '#fff', borderRadius: 10, padding: 20 },
  value: { fontSize: 24, marginBottom: 10 },
  result: { marginTop: 10, fontSize: 12 },
};
