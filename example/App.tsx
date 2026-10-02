import { useEffect, useRef, useState } from 'react';
import { Button, SafeAreaView, ScrollView, Text, View } from 'react-native';

import ExpoBleKit, {
  BleError,
  normalizeUUID,
  type BlePermissions,
  type BleState,
  type ScanResult,
} from 'expo-ble-kit';

// Adapter state, permissions (P1-03) and scanning (P1-04) on the raw native module. Replaced by the
// Explorer example in P1-15.

const TEST_SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const TEST_NAME = 'BleKit-Test';

type Filters = { services?: string[]; namePrefix?: string; companyId?: number };

function nativeOptions(filters: Filters) {
  return {
    services: (filters.services ?? []).map((uuid) => normalizeUUID(uuid)),
    allowDuplicates: false,
    reportIntervalMs: 0,
    ...(filters.namePrefix !== undefined && { namePrefix: filters.namePrefix }),
    manufacturerData: filters.companyId !== undefined ? [{ companyId: filters.companyId }] : [],
    android: { legacy: true, reportDelayMs: 0 },
    ios: { solicitedServices: [] },
  };
}

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

export default function App() {
  const [state, setState] = useState<BleState>(() => ExpoBleKit.getState());
  const [stateLog, setStateLog] = useState<string[]>([]);
  const [result, setResult] = useState('');
  const [sessions, setSessions] = useState<Record<number, { label: string; ids: string[] }>>({});
  const [testResult, setTestResult] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const nextSession = useRef(1);
  const labels = useRef<Record<number, string>>({});

  const addLog = (line: string) =>
    setLog((lines) => [`${new Date().toISOString().slice(14, 23)} ${line}`, ...lines].slice(0, 12));

  useEffect(() => {
    const subscriptions = [
      ExpoBleKit.addListener('stateChange', (event) => {
        setState(event.state);
        setStateLog((lines) =>
          [`${new Date().toISOString().slice(11, 23)} ${event.state}`, ...lines].slice(0, 8)
        );
      }),
      ExpoBleKit.addListener('scanResults', ({ sessionId, results }) => {
        const test = results.find((r) => r.name === TEST_NAME);
        if (test) {
          setTestResult(describeResult(test));
        }
        setSessions((all) => {
          const session = all[sessionId] ?? { label: labels.current[sessionId] ?? '?', ids: [] };
          const ids = [...session.ids];
          for (const r of results) {
            const line = `${r.name ?? '—'} ${r.rssi}`;
            const index = ids.findIndex((existing) => existing.startsWith(`${r.id} `));
            const entry = `${r.id} ${line}`;
            if (index >= 0) ids[index] = entry;
            else ids.push(entry);
          }
          return { ...all, [sessionId]: { ...session, ids } };
        });
      }),
      ExpoBleKit.addListener('scanError', (event) => {
        const error = BleError.fromNative(event);
        addLog(`session ${event.sessionId} ended: ${error.code}: ${error.message}`);
      }),
      ExpoBleKit.addListener('warning', (event) => {
        const error = BleError.fromNative(event);
        addLog(`warning ${error.code}: ${error.message}`);
      }),
    ];
    setState(ExpoBleKit.getState());
    return () => subscriptions.forEach((s) => s.remove());
  }, []);

  async function run(call: () => Promise<BlePermissions>) {
    setResult('…');
    try {
      setResult(JSON.stringify(await call()));
    } catch (error) {
      const bleError = BleError.fromNative(error);
      setResult(`${bleError.code}: ${bleError.message}`);
    }
  }

  async function startSession(label: string, filters: Filters): Promise<number | null> {
    const sessionId = nextSession.current++;
    labels.current[sessionId] = label;
    setSessions((all) => ({ ...all, [sessionId]: { label, ids: [] } }));
    try {
      await ExpoBleKit.startScan(sessionId, nativeOptions(filters));
      addLog(`session ${sessionId} (${label}) started`);
      return sessionId;
    } catch (error) {
      const bleError = BleError.fromNative(error);
      addLog(`session ${sessionId} failed: ${bleError.code}: ${bleError.message}`);
      return null;
    }
  }

  async function stopAll() {
    await Promise.all(Object.keys(sessions).map((id) => ExpoBleKit.stopScan(Number(id))));
    addLog('stopped all sessions');
  }

  // P1-04 accept: 10 start/stop cycles within 20 s give SCAN_THROTTLED warnings, not silence.
  async function throttleTest() {
    setSessions({});
    for (let cycle = 1; cycle <= 10; cycle++) {
      const id = await startSession(`cycle ${cycle}`, {});
      await sleep(1000);
      if (id !== null) await ExpoBleKit.stopScan(id);
      await sleep(1000);
    }
    addLog('10 cycles done; starting a final session');
    await startSession('after throttle', {});
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.container}>
        <Text style={styles.header}>expo-ble-kit · {state}</Text>
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
            onPress={async () => {
              await startSession('name BleKit', { namePrefix: 'BleKit' });
              await startSession('Apple 0x004C', { companyId: 0x004c });
            }}
          />
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
        <Group name="Adapter state">
          <Text testID="state" style={styles.value}>
            {state}
          </Text>
          <Text testID="state-log">{stateLog.join('\n')}</Text>
        </Group>
        <Group name="Permissions">
          <Button
            testID="get-permissions"
            title="Get permissions"
            onPress={() => run(() => ExpoBleKit.getPermissionsAsync())}
          />
          <Button
            testID="request-permissions"
            title="Request permissions"
            onPress={() => run(() => ExpoBleKit.requestPermissionsAsync())}
          />
          <Text testID="permissions-result" style={styles.result}>
            {result}
          </Text>
        </Group>
      </ScrollView>
    </SafeAreaView>
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
  header: { fontSize: 30, margin: 20 },
  groupHeader: { fontSize: 20, marginBottom: 20 },
  group: { margin: 20, backgroundColor: '#fff', borderRadius: 10, padding: 20 },
  container: { flex: 1, backgroundColor: '#eee' },
  value: { fontSize: 24, marginBottom: 10 },
  result: { marginTop: 10, fontSize: 12 },
};
