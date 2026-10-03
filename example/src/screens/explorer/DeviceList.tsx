import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useScan } from 'expo-ble-kit';

import { ActionButton, Card, Chip, colors, text } from '../../ui';

/** Everything nearby, with live signal strength. Tap a device to open it. */
export function DeviceList(props: { onSelect: (id: string) => void }) {
  const [scanning, setScanning] = useState(true);
  const [namedOnly, setNamedOnly] = useState(true);
  const { results, isScanning, error, clear } = useScan({
    allowDuplicates: true,
    maxResults: 50,
    enabled: scanning,
  });
  const visible = namedOnly ? results.filter((result) => result.name) : results;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View>
          <Text style={text.title}>Nearby devices</Text>
          <Text testID="scan-status" style={text.muted}>
            {error
              ? `${error.code}`
              : isScanning
                ? `Scanning · ${results.length} seen`
                : 'Not scanning'}
          </Text>
        </View>
        <View style={styles.actions}>
          <ActionButton
            compact
            title={scanning ? 'Stop' : 'Scan'}
            testID="scan-toggle"
            onPress={() => setScanning((on) => !on)}
          />
          <ActionButton
            compact
            title={namedOnly ? 'Named only' : 'All'}
            testID="named-toggle"
            onPress={() => setNamedOnly((on) => !on)}
          />
          <ActionButton compact title="Clear" onPress={clear} />
        </View>
      </View>
      {visible.length === 0 && (
        <Card>
          <Text style={text.body}>
            {isScanning ? 'Looking for devices…' : 'Start a scan to see devices.'}
          </Text>
          {namedOnly && results.length > 0 && (
            <Text style={text.muted}>{results.length} unnamed devices hidden.</Text>
          )}
        </Card>
      )}
      {visible.map((result) => (
        <Pressable
          key={result.id}
          testID={`device-${result.id}`}
          accessibilityRole="button"
          accessibilityLabel={result.name ?? result.id}
          onPress={() => props.onSelect(result.id)}
          style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
          <View style={{ flexShrink: 1, gap: 2 }}>
            <Text style={text.heading}>{result.name ?? 'Unnamed'}</Text>
            <Text style={text.muted}>{result.id}</Text>
            {result.serviceUUIDs.length > 0 && (
              <Text style={text.muted}>
                {result.serviceUUIDs.length} service{result.serviceUUIDs.length > 1 ? 's' : ''}{' '}
                advertised
              </Text>
            )}
          </View>
          <Chip label={`${result.rssi} dBm`} tone={result.rssi > -70 ? 'accent' : 'plain'} />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 10 },
  header: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  actions: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
});
