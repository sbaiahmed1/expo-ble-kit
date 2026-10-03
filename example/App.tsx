import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { useBleState } from 'expo-ble-kit';

import { startDemo } from './src/demo/testPeripheral';
import { DevChecksScreen } from './src/screens/DevChecksScreen';
import { ExplorerScreen } from './src/screens/ExplorerScreen';
import { HeartRateScreen } from './src/screens/HeartRateScreen';
import { ThroughputScreen } from './src/screens/ThroughputScreen';
import { colors } from './src/ui';

const TABS = [
  { key: 'explorer', title: 'Explorer', Screen: ExplorerScreen },
  { key: 'heart-rate', title: 'Heart Rate', Screen: HeartRateScreen },
  { key: 'throughput', title: 'Throughput', Screen: ThroughputScreen },
  { key: 'checks', title: 'Checks', Screen: DevChecksScreen },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function BluetoothState() {
  const state = useBleState();
  return (
    <Text testID="ble-state" style={styles.state}>
      Bluetooth: {state}
    </Text>
  );
}

/**
 * The example app: Explorer and Heart Rate (P1-15), and the developer checks. Demo mode swaps the
 * native module for a virtual test peripheral, so every screen works without hardware.
 */
export default function App() {
  const [tab, setTab] = useState<TabKey>('explorer');
  const [demo, setDemo] = useState(false);
  const stopDemo = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDemo.current?.(), []);

  const enableDemo = (on: boolean) => {
    if (!on || demo) return; // Leaving demo mode needs a restart: listeners are bound to the fake.
    stopDemo.current = startDemo().stop;
    setDemo(true);
  };
  const { Screen } = TABS.find((t) => t.key === tab)!;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>expo-ble-kit</Text>
            <View style={styles.demo}>
              <Text style={styles.demoLabel}>{demo ? 'Demo device' : 'Demo'}</Text>
              <Switch testID="demo-mode" value={demo} onValueChange={enableDemo} disabled={demo} />
            </View>
          </View>
          <BluetoothState key={demo ? 'demo' : 'native'} />
          <View style={styles.tabs} accessibilityRole="tablist">
            {TABS.map((t) => (
              <Pressable
                key={t.key}
                testID={`tab-${t.key}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: t.key === tab }}
                onPress={() => setTab(t.key)}
                style={[styles.tab, t.key === tab && styles.tabOn]}>
                <Text style={[styles.tabText, t.key === tab && styles.tabTextOn]}>{t.title}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* Remounted when demo mode starts, so every hook listens to the fake. */}
          <Screen key={demo ? 'demo' : 'native'} />
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 6,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 20, fontWeight: '700', color: colors.ink },
  demo: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  demoLabel: { fontSize: 13, color: colors.muted },
  state: { fontSize: 13, color: colors.muted },
  tabs: { flexDirection: 'row', gap: 4, marginTop: 4 },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabOn: { borderBottomColor: colors.accent },
  tabText: { fontSize: 14, fontWeight: '600', color: colors.muted },
  tabTextOn: { color: colors.accent },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
});
