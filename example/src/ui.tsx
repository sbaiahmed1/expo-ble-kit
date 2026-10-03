import type { ReactNode } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { useBlePermissions, useBleState } from 'expo-ble-kit';

// Small building blocks shared by the example screens.

export const colors = {
  bg: '#eef2f4',
  surface: '#ffffff',
  ink: '#14202a',
  muted: '#5b6875',
  line: '#d3dce2',
  accent: '#0b6e78',
  accentSoft: '#d6ecee',
  signal: '#a85a00',
  signalSoft: '#f6e7d4',
  bad: '#b23a3a',
  badSoft: '#f6dddd',
};

export function ActionButton(props: {
  title: string;
  /** May start async work; its promise is not returned to the press handler. */
  onPress: () => unknown;
  testID?: string;
  kind?: 'primary' | 'plain' | 'danger';
  disabled?: boolean;
  compact?: boolean;
}) {
  const { kind = 'plain', compact } = props;
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.title}
      disabled={props.disabled}
      onPress={() => {
        props.onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        kind === 'primary' && styles.buttonPrimary,
        kind === 'danger' && styles.buttonDanger,
        (pressed || props.disabled) && { opacity: props.disabled ? 0.4 : 0.7 },
      ]}>
      <Text
        style={[
          styles.buttonText,
          compact && styles.buttonTextCompact,
          kind === 'primary' && { color: colors.surface },
          kind === 'danger' && { color: colors.bad },
        ]}>
        {props.title}
      </Text>
    </Pressable>
  );
}

export function Chip(props: { label: string; tone?: 'plain' | 'accent' | 'signal' | 'bad' }) {
  const tone = props.tone ?? 'plain';
  const background = {
    plain: colors.bg,
    accent: colors.accentSoft,
    signal: colors.signalSoft,
    bad: colors.badSoft,
  }[tone];
  const color = {
    plain: colors.muted,
    accent: colors.accent,
    signal: colors.signal,
    bad: colors.bad,
  }[tone];
  return (
    <View style={[styles.chip, { backgroundColor: background }]}>
      <Text style={[styles.chipText, { color }]}>{props.label}</Text>
    </View>
  );
}

export function Card(props: { children: ReactNode; style?: ViewStyle; testID?: string }) {
  return (
    <View testID={props.testID} style={[styles.card, props.style]}>
      {props.children}
    </View>
  );
}

/**
 * Shown above a screen while Bluetooth can't be used: off, unsupported, or not allowed yet. Offers
 * the permission request, or Settings once the system won't ask again.
 */
export function BluetoothGate() {
  const state = useBleState();
  const [permissions, request] = useBlePermissions();
  const allowed = permissions?.scan === 'granted' && permissions?.connect === 'granted';
  if (permissions && !allowed) {
    return (
      <Card style={styles.gate} testID="bluetooth-gate">
        <Text style={styles.gateTitle}>Bluetooth isn't allowed yet</Text>
        <Text style={styles.gateText}>The app needs it to find and connect to nearby devices.</Text>
        {permissions.canAskAgain ? (
          <ActionButton
            testID="allow-bluetooth"
            kind="primary"
            title="Allow Bluetooth"
            onPress={() => request().catch(() => {})}
          />
        ) : (
          <ActionButton title="Open Settings" onPress={() => Linking.openSettings()} />
        )}
      </Card>
    );
  }
  if (state === 'poweredOff' || state === 'unsupported') {
    return (
      <Card style={styles.gate} testID="bluetooth-gate">
        <Text style={styles.gateTitle}>
          {state === 'poweredOff' ? 'Bluetooth is off' : 'No Bluetooth LE on this device'}
        </Text>
        <Text style={styles.gateText}>
          {state === 'poweredOff'
            ? 'Turn it on in Settings or the control center.'
            : "This device can't run these screens."}
        </Text>
      </Card>
    );
  }
  return null;
}

export const text = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700', color: colors.ink },
  heading: { fontSize: 16, fontWeight: '600', color: colors.ink },
  body: { fontSize: 14, color: colors.ink },
  muted: { fontSize: 13, color: colors.muted },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 12,
    color: colors.ink,
  },
});

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  buttonCompact: { paddingHorizontal: 10, paddingVertical: 6 },
  buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  buttonDanger: { borderColor: colors.bad },
  buttonText: { fontSize: 14, fontWeight: '600', color: colors.ink },
  buttonTextCompact: { fontSize: 12 },
  chip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  chipText: { fontSize: 11, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 14,
    gap: 8,
  },
  gate: { borderColor: colors.signal, backgroundColor: colors.signalSoft },
  gateTitle: { fontSize: 15, fontWeight: '700', color: colors.ink },
  gateText: { fontSize: 13, color: colors.ink },
});
