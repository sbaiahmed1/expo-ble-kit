import { Platform, StyleSheet, Text, View } from 'react-native';

import { BackgroundScanChecks } from './BackgroundScanChecks';
import { CompanionChecks } from './CompanionChecks';
import { KeepAliveChecks } from './KeepAliveChecks';
import { RestorationChecks } from './RestorationChecks';
import { Card, colors, text } from '../ui';

// P3-06: the background scenarios of plan §8.4 (S-B1 … S-B6), each with what to do, what should
// happen, and its controls. Results per device go to docs/qa/background.md.

type Scenario = {
  id: string;
  platform: 'ios' | 'android' | 'both';
  title: string;
  steps: string;
  expect: string;
};

const SCENARIOS: Scenario[] = [
  {
    id: 'S-B1',
    platform: 'ios',
    title: 'Suspended during a 1 Hz stream',
    steps:
      'With the test peripheral nearby, connect below, then leave the app for two minutes (open another app) and come back.',
    expect: 'Every heart rate value arrived, in the background or on return: the count matches, 0 gaps.',
  },
  {
    id: 'S-B2',
    platform: 'ios',
    title: 'Stopped by the system, then the peripheral notifies',
    steps:
      'Connect below, then stop the app the way iOS does: e2e/ios-restoration/run.sh (closing it from the app switcher is S-B6, not this).',
    expect:
      'iOS relaunches the app in the background; the task receives restored, then every notification. The journal shows it.',
  },
  {
    id: 'S-B3',
    platform: 'android',
    title: 'Screen off for an hour with the foreground service',
    steps:
      'Connect with keep-alive below (the service starts), stream from the test peripheral at 10 Hz, and turn the screen off for 60 minutes.',
    expect: 'The connection stays open and no sequence number is missing.',
  },
  {
    id: 'S-B4',
    platform: 'android',
    title: 'Process killed, then the peripheral advertises',
    steps:
      'Register the background scan below, leave the app, kill it (adb shell am kill expo.modules.blekit.example), then start the test peripheral.',
    expect: 'Android starts the app without its screen; the task logs "BleKit background task" with the results.',
  },
  {
    id: 'S-B5',
    platform: 'android',
    title: 'A companion device comes into range',
    steps:
      'Associate the test peripheral and register the presence task below (Android 12+), kill the app, then stop and restart the test peripheral.',
    expect: 'The task logs "BleKit presence task" with gone, then in range.',
  },
  {
    id: 'S-B6',
    platform: 'both',
    title: 'Closed by the person',
    steps:
      'Connect (S-B1 or S-B3), then close the app from the app switcher (iOS) or force-stop it in Settings (Android).',
    expect:
      'The connection ends and nothing relaunches the app; the next manual launch starts clean (iOS restores nothing).',
  },
];

const CONTROLS: Record<string, React.ComponentType | undefined> = {
  'S-B1': RestorationChecks,
  'S-B3': KeepAliveChecks,
  'S-B4': BackgroundScanChecks,
  'S-B5': CompanionChecks,
};

export function BackgroundScreen() {
  const scenarios = SCENARIOS.filter(
    (scenario) => scenario.platform === 'both' || scenario.platform === Platform.OS
  );
  return (
    <View style={styles.screen}>
      <Text style={text.muted}>
        The background scenarios this library is checked against. Results per device are kept in
        docs/qa/background.md.
      </Text>
      {scenarios.map((scenario) => {
        const Controls = CONTROLS[scenario.id];
        return (
          <View key={scenario.id} testID={`scenario-${scenario.id}`} style={styles.scenario}>
            <Card>
              <Text style={text.heading}>
                {scenario.id} · {scenario.title}
              </Text>
              <Text style={text.body}>{scenario.steps}</Text>
              <Text style={[text.body, styles.expect]}>Expected: {scenario.expect}</Text>
            </Card>
            {Controls && <Controls />}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 12 },
  scenario: { gap: 8 },
  expect: { color: colors.accent },
});
