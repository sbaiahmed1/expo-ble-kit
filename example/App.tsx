import ExpoBleKit, { useExpoBleKitModuleSharedObject } from 'expo-ble-kit';
import { useEvent } from 'expo';
import { useState } from 'react';
import { Button, SafeAreaView, ScrollView, Text, View } from 'react-native';

export default function App() {
  const onChangePayload = useEvent(ExpoBleKit, 'onChange');
  const sharedObject = useExpoBleKitModuleSharedObject();
  const [sharedObjectCount, setSharedObjectCount] = useState(0);
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.container}>
        <Text style={styles.header}>Module API Example</Text>
        <Group name="Async functions">
          <Button
            title="Set value"
            onPress={async () => {
              await ExpoBleKit.setValueAsync('Hello from JS!');
            }}
          />
        </Group>
        <Group name="Events">
          <Text>{onChangePayload?.value}</Text>
        </Group>
        <Group name="Shared Object">
          <Text>Count: {sharedObjectCount}</Text>
          <Button title="Read count" onPress={() => setSharedObjectCount(sharedObject.count)} />
          <Button
            title="Increment count"
            onPress={() => {
              sharedObject.count += 1;
            }}
          />
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
  view: { flex: 1, height: 200 },
};
