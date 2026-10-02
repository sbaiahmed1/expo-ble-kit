import { useEffect, useState } from 'react';
import { Button, SafeAreaView, ScrollView, Text, View } from 'react-native';

import ExpoBleKit, { BleError, type BlePermissions, type BleState } from 'expo-ble-kit';

// Adapter state and permissions (P1-03). Replaced by the Explorer example in P1-15.
export default function App() {
  const [state, setState] = useState<BleState>(() => ExpoBleKit.getState());
  const [stateLog, setStateLog] = useState<string[]>([]);
  const [result, setResult] = useState('');

  useEffect(() => {
    const subscription = ExpoBleKit.addListener('stateChange', (event) => {
      setState(event.state);
      setStateLog((log) =>
        [`${new Date().toISOString().slice(11, 23)} ${event.state}`, ...log].slice(0, 8)
      );
    });
    // The state may have changed before the listener was added.
    setState(ExpoBleKit.getState());
    return () => subscription.remove();
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

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.container}>
        <Text style={styles.header}>expo-ble-kit</Text>
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
  result: { marginTop: 10 },
};
