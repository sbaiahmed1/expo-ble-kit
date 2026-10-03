import { useState } from 'react';
import { View } from 'react-native';

import { BluetoothGate } from '../ui';
import { DeviceDetail } from './explorer/DeviceDetail';
import { DeviceList } from './explorer/DeviceList';

/** P1-15 Explorer: scan list → device → services → read / write / subscribe. */
export function ExplorerScreen() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <View style={{ gap: 12 }}>
      <BluetoothGate />
      {selected ? (
        <DeviceDetail id={selected} onBack={() => setSelected(null)} />
      ) : (
        <DeviceList onSelect={setSelected} />
      )}
    </View>
  );
}
