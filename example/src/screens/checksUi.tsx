import { Text, View } from 'react-native';

/** A titled card of developer checks. */
export function Group(props: { name: string; children: React.ReactNode }) {
  return (
    <View style={checkStyles.group}>
      <Text style={checkStyles.groupHeader}>{props.name}</Text>
      {props.children}
    </View>
  );
}

export const checkStyles = {
  groupHeader: { fontSize: 20, marginBottom: 20 },
  group: { marginBottom: 16, backgroundColor: '#fff', borderRadius: 10, padding: 20 },
  value: { fontSize: 24, marginBottom: 10 },
  result: { marginTop: 10, fontSize: 12 },
};
