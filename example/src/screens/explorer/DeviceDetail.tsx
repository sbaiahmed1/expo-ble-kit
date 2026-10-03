import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { BleError, usePeripheral } from 'expo-ble-kit';

import { gattName, shortUUID } from '../../lib/gattNames';
import { ActionButton, Card, Chip, colors, text } from '../../ui';
import { CharacteristicRow } from './CharacteristicRow';

/** One device: connect, see its details, and use every characteristic it has. */
export function DeviceDetail(props: { id: string; onBack: () => void }) {
  const { peripheral, state, error } = usePeripheral(props.id);
  const [rssi, setRssi] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  if (!peripheral) {
    return <Text style={text.body}>{error?.message ?? 'Unknown device'}</Text>;
  }
  const connected = state === 'connected';
  const busy = state === 'connecting' || state === 'disconnecting';

  const attempt = async (work: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await work();
    } catch (e) {
      const bleError = BleError.fromNative(e);
      if (bleError.code !== 'OPERATION_CANCELLED')
        setActionError(`${bleError.code}: ${bleError.message}`);
    }
  };

  const back = () => {
    peripheral.disconnect().catch(() => {});
    props.onBack();
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <ActionButton compact title="‹ Devices" testID="explorer-back" onPress={back} />
        <Chip label={state} tone={connected ? 'accent' : busy ? 'signal' : 'plain'} />
      </View>
      <Card>
        <Text style={text.title}>{peripheral.name ?? 'Unnamed device'}</Text>
        <Text style={text.muted} selectable>
          {peripheral.id}
        </Text>
        <Text testID="device-state" style={text.body}>
          {connected ? `Connected · MTU ${peripheral.mtu}` : state}
          {rssi !== null && connected ? ` · RSSI ${rssi} dBm` : ''}
        </Text>
        <View style={styles.actions}>
          {state === 'disconnected' ? (
            <ActionButton
              kind="primary"
              title="Connect"
              testID="connect"
              onPress={() => attempt(() => peripheral.connect())}
            />
          ) : (
            <ActionButton
              kind="danger"
              title={connected ? 'Disconnect' : 'Cancel'}
              testID="disconnect"
              onPress={() => attempt(() => peripheral.disconnect())}
            />
          )}
          {connected && (
            <ActionButton
              title="Read RSSI"
              testID="read-rssi"
              onPress={() => attempt(async () => setRssi(await peripheral.readRssi()))}
            />
          )}
        </View>
        {(actionError ?? error) && (
          <Text testID="device-error" style={styles.error}>
            {actionError ?? `${error!.code}: ${error!.message}`}
          </Text>
        )}
      </Card>

      {connected &&
        peripheral.services.map((service) => (
          <Card key={service.uuid} testID={`service-${service.uuid}`}>
            <Text style={text.heading}>
              {gattName(service.uuid) ?? (service.isPrimary ? 'Service' : 'Secondary service')}
            </Text>
            <Text style={text.muted} selectable>
              {shortUUID(service.uuid)}
            </Text>
            {service.characteristics.map((characteristic) => (
              <CharacteristicRow
                key={characteristic.uuid}
                peripheral={peripheral}
                characteristic={characteristic}
              />
            ))}
          </Card>
        ))}
      {connected && peripheral.services.length === 0 && (
        <Text style={text.muted}>The device has no services.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  error: { fontSize: 12, color: colors.bad },
});
