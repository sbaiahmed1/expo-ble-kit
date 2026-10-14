import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import {
  BleError,
  type Characteristic,
  type CharacteristicSubscription,
  type Descriptor,
  type Peripheral,
} from 'expo-ble-kit';

import { fromUtf8, isText, parseHex, toHex, toUtf8 } from '../../lib/bytes';
import { gattName, shortUUID } from '../../lib/gattNames';
import { ActionButton, Chip, colors, text } from '../../ui';

function describe(error: unknown): string {
  if (error instanceof BleError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** A value as its length and hex, and as UTF-8 when it is text. */
export function ValueView(props: { value: Uint8Array; testID: string }) {
  return (
    <View style={styles.value}>
      <Text style={text.muted}>{props.value.length} bytes</Text>
      <Text testID={`${props.testID}-hex`} style={text.mono} selectable>
        {props.value.length ? toHex(props.value) : '(empty)'}
      </Text>
      {props.value.length > 0 && isText(props.value) && (
        <Text testID={`${props.testID}-text`} style={text.mono} selectable>
          {`"${toUtf8(props.value)}"`}
        </Text>
      )}
    </View>
  );
}

function DescriptorRow(props: {
  peripheral: Peripheral;
  descriptor: Descriptor;
  serviceUUID: string;
}) {
  const { peripheral, descriptor, serviceUUID } = props;
  const [value, setValue] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = async () => {
    setError(null);
    try {
      setValue(
        await peripheral.readDescriptor(serviceUUID, descriptor.characteristicUUID, descriptor.uuid)
      );
    } catch (e) {
      setError(describe(e));
    }
  };
  return (
    <View style={styles.descriptor}>
      <View style={styles.headRow}>
        <Text style={text.muted}>
          {gattName(descriptor.uuid) ?? 'Descriptor'} · {shortUUID(descriptor.uuid)}
        </Text>
        <ActionButton compact title="Read" testID={`read-${descriptor.uuid}`} onPress={read} />
      </View>
      {value && <ValueView value={value} testID={`value-${descriptor.uuid}`} />}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

/** One characteristic: its properties and the operations they allow. */
export function CharacteristicRow(props: {
  peripheral: Peripheral;
  characteristic: Characteristic;
}) {
  const { peripheral, characteristic } = props;
  const { uuid, serviceUUID, properties } = characteristic;
  const canRead = properties.includes('read');
  const withResponseAllowed = properties.includes('write');
  const withoutResponseAllowed = properties.includes('writeWithoutResponse');
  const canNotify = properties.includes('notify') || properties.includes('indicate');

  const [value, setValue] = useState<Uint8Array | null>(null);
  const [notifications, setNotifications] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [hexInput, setHexInput] = useState(false);
  const [withResponse, setWithResponse] = useState(withResponseAllowed);
  const [subscription, setSubscription] = useState<CharacteristicSubscription | null>(null);
  const subscriptionRef = useRef<CharacteristicSubscription | null>(null);

  useEffect(() => () => subscriptionRef.current?.remove(), []);

  const run = async (work: () => Promise<void>) => {
    setError(null);
    setStatus(null);
    try {
      await work();
    } catch (e) {
      setError(describe(e));
    }
  };

  const read = () => run(async () => setValue(await peripheral.read(serviceUUID, uuid)));

  const write = () =>
    run(async () => {
      const bytes = hexInput ? parseHex(draft) : fromUtf8(draft);
      await peripheral.write(serviceUUID, uuid, bytes, { withResponse });
      setStatus(`Wrote ${bytes.length} bytes${withResponse ? '' : ' without response'}`);
    });

  const toggleSubscription = () =>
    run(async () => {
      if (subscription?.active) {
        subscriptionRef.current = null;
        setSubscription(null);
        await subscription.unsubscribe();
        return;
      }
      const subscribed = await peripheral.subscribe(serviceUUID, uuid, (next) => {
        setValue(next);
        setNotifications((count) => count + 1);
      });
      subscriptionRef.current = subscribed;
      setSubscription(subscribed);
    });

  return (
    <View style={styles.row} testID={`characteristic-${uuid}`}>
      <View style={styles.headRow}>
        <View style={{ flexShrink: 1 }}>
          <Text style={text.heading}>{gattName(uuid) ?? 'Characteristic'}</Text>
          <Text style={text.muted} selectable>
            {shortUUID(uuid)}
          </Text>
        </View>
      </View>
      <View style={styles.chips}>
        {properties.map((property) => (
          <Chip
            key={property}
            label={property}
            tone={property === 'notify' || property === 'indicate' ? 'signal' : 'accent'}
          />
        ))}
      </View>

      <View style={styles.actions}>
        {canRead && <ActionButton compact title="Read" testID={`read-${uuid}`} onPress={read} />}
        {canNotify && (
          <ActionButton
            compact
            kind={subscription?.active ? 'primary' : 'plain'}
            title={subscription?.active ? `Subscribed (${notifications})` : 'Subscribe'}
            testID={`subscribe-${uuid}`}
            onPress={toggleSubscription}
          />
        )}
      </View>

      {(withResponseAllowed || withoutResponseAllowed) && (
        <View style={styles.writeBox}>
          <TextInput
            testID={`write-input-${uuid}`}
            value={draft}
            onChangeText={setDraft}
            placeholder={hexInput ? 'Hex, like 01 ff' : 'Text to write'}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <View style={styles.actions}>
            <ActionButton
              compact
              title={hexInput ? 'Hex' : 'UTF-8'}
              testID={`write-mode-${uuid}`}
              onPress={() => setHexInput((on) => !on)}
            />
            {withResponseAllowed && withoutResponseAllowed && (
              <ActionButton
                compact
                title={withResponse ? 'With response' : 'Without response'}
                onPress={() => setWithResponse((on) => !on)}
              />
            )}
            <ActionButton
              compact
              kind="primary"
              title="Write"
              testID={`write-${uuid}`}
              onPress={write}
            />
          </View>
        </View>
      )}

      {value && <ValueView value={value} testID={`value-${uuid}`} />}
      {status && <Text style={text.muted}>{status}</Text>}
      {error && (
        <Text testID={`error-${uuid}`} style={styles.error}>
          {error}
        </Text>
      )}
      {characteristic.descriptors.map((descriptor) => (
        <DescriptorRow
          key={descriptor.uuid}
          peripheral={peripheral}
          descriptor={descriptor}
          serviceUUID={serviceUUID}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: 8,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  writeBox: { gap: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink,
    backgroundColor: colors.bg,
  },
  value: { gap: 2, padding: 8, borderRadius: 6, backgroundColor: colors.bg },
  descriptor: {
    gap: 6,
    marginLeft: 12,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: colors.line,
  },
  error: { fontSize: 12, color: colors.bad },
});
