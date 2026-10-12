import Link from '@docusaurus/Link';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import Layout from '@theme/Layout';
import TabItem from '@theme/TabItem';
import Tabs from '@theme/Tabs';
import { useState, type ReactNode } from 'react';

import styles from './index.module.css';

const INSTALL = 'npx expo install expo-ble-kit';

const SCAN = `import { BleManager, GattCharacteristics, GattServices } from 'expo-ble-kit';

await BleManager.requestPermissionsAsync();

const found = await BleManager.scanFor({
  services: [GattServices.HeartRate],
  timeoutMs: 10_000,
});
if (found) {
  const monitor = BleManager.getPeripheral(found.id);
  await monitor.connect();
  await monitor.subscribe(
    GattServices.HeartRate,
    GattCharacteristics.HeartRateMeasurement,
    (value) => {
      const bpm = value[0] & 0x01 ? value[1] | (value[2] << 8) : value[1];
      console.log(bpm, 'bpm');
    }
  );
}`;

const HOOKS = `import { useCharacteristicValue, usePeripheral } from 'expo-ble-kit';

function HeartRate({ id }: { id: string }) {
  const { peripheral, state } = usePeripheral(id);
  const { value } = useCharacteristicValue(peripheral, '180d', '2a37');
  if (state !== 'connected') {
    return <Button title="Connect" onPress={() => peripheral?.connect()} />;
  }
  return <Text>{value ? \`\${value[1]} bpm\` : '…'}</Text>;
}`;

const TEST = `import { installFakeBle } from 'expo-ble-kit/testing';
import { GattCharacteristics, GattServices } from 'expo-ble-kit';

const ble = installFakeBle();
const hrm = ble.addPeripheral({
  name: 'HRM',
  services: [
    {
      uuid: GattServices.HeartRate,
      characteristics: [
        { uuid: GattCharacteristics.HeartRateMeasurement, properties: ['notify'] },
      ],
    },
  ],
});

// Render the screen under test, then:
hrm.notify(
  GattServices.HeartRate,
  GattCharacteristics.HeartRateMeasurement,
  Uint8Array.of(0, 72)
);`;

const MIGRATE = `- import { BleManager, Device } from 'react-native-ble-plx';
+ import { BleManager, Device } from 'expo-ble-kit/compat/plx';`;

type Feature = { title: string; body: ReactNode; link: string };

const FEATURES: Feature[] = [
  {
    title: 'The phone as a central',
    body: (
      <>
        Scan with filters while other scans share the radio, connect with timeouts and reconnection
        policies, then read, write and subscribe, on several devices at once.
      </>
    ),
    link: '/docs/getting-started#scan',
  },
  {
    title: 'The phone as the device',
    body: (
      <>
        Publish a GATT server with static and dynamic values, send flow-controlled notifications,
        advertise, and serve L2CAP channels.
      </>
    ),
    link: '/docs/getting-started#acting-as-a-peripheral-a-gatt-server',
  },
  {
    title: 'Predictable under pressure',
    body: (
      <>
        One GATT operation at a time per connection, a timeout on every one,{' '}
        <code>AbortSignal</code> cancellation, and a <code>BleError</code> code for every failure.
      </>
    ),
    link: '/docs/getting-started#errors',
  },
  {
    title: 'Bytes in, bytes out',
    body: (
      <>
        <code>Uint8Array</code> end to end, no base64. <code>writeStream</code> sends payloads of
        any size with progress, and fast notifications arrive in batches.
      </>
    ),
    link: '/docs/getting-started#sending-a-lot-of-data',
  },
  {
    title: 'Tests without hardware',
    body: (
      <>
        <code>expo-ble-kit/testing</code> runs a fake Bluetooth stack in Jest: virtual peripherals
        and centrals with the real ordering, timeouts and errors.
      </>
    ),
    link: '/docs/getting-started#testing-your-app',
  },
  {
    title: 'Configured at build time',
    body: (
      <>
        A config plugin writes the permissions and options. A missing declaration rejects with{' '}
        <code>MISCONFIGURED</code> instead of crashing the app.
      </>
    ),
    link: '/docs/guides/permissions',
  },
];

const EXTRAS: { label: string; link: string }[] = [
  { label: 'React hooks', link: '/docs/getting-started#with-react-hooks' },
  { label: 'L2CAP channels', link: '/docs/getting-started#l2cap-channels' },
  { label: 'Bonding (Android)', link: '/docs/getting-started#pairing-and-bonding' },
  {
    label: 'Background scans (Android)',
    link: '/docs/getting-started#scanning-in-the-background-android',
  },
  {
    label: 'Keep-alive service (Android)',
    link: '/docs/getting-started#staying-connected-in-the-background',
  },
  {
    label: 'Background relaunch (iOS)',
    link: '/docs/getting-started#ios-state-restoration-and-background-tasks',
  },
  { label: 'Accessory picker (iOS 18+)', link: '/docs/guides/accessory-setup' },
  { label: 'Logging and diagnostics', link: '/docs/getting-started#logging' },
];

function InstallCommand() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(INSTALL)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className={styles.install}>
      <span className={styles.prompt} aria-hidden="true">
        $
      </span>
      <code>{INSTALL}</code>
      <button type="button" className={styles.copy} onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Hero() {
  return (
    <header className={styles.hero}>
      <div className={styles.waves} aria-hidden="true" />
      <div className={`container ${styles.heroInner}`}>
        <div className={styles.heroText}>
          <p className={styles.eyebrow}>Version 2.0 · on npm</p>
          <Heading as="h1" className={styles.title}>
            Bluetooth Low Energy for Expo
          </Heading>
          <p className={styles.lead}>
            Scan, connect, read, write and subscribe from a React Native app, or make the phone the
            device. Typed errors, React hooks, and a fake Bluetooth stack for your tests.
          </p>
          <div className={styles.actions}>
            <Link className="button button--primary button--lg" to="/docs/getting-started">
              Get started
            </Link>
            <Link className="button button--outline button--primary button--lg" to="/api">
              API reference
            </Link>
          </div>
          <InstallCommand />
        </div>
        <div className={styles.heroCode}>
          <Tabs groupId="hero-sample" className={styles.tabs}>
            <TabItem value="scan" label="Connect" default>
              <CodeBlock language="ts">{SCAN}</CodeBlock>
            </TabItem>
            <TabItem value="hooks" label="Hooks">
              <CodeBlock language="tsx">{HOOKS}</CodeBlock>
            </TabItem>
            <TabItem value="test" label="Testing">
              <CodeBlock language="ts">{TEST}</CodeBlock>
            </TabItem>
          </Tabs>
        </div>
      </div>
    </header>
  );
}

function Features() {
  return (
    <section className={styles.section}>
      <div className="container">
        <div className={styles.grid}>
          {FEATURES.map((feature) => (
            <Link key={feature.title} to={feature.link} className={styles.card}>
              <Heading as="h3">{feature.title}</Heading>
              <p>{feature.body}</p>
            </Link>
          ))}
        </div>
        <div className={styles.extras}>
          <span className={styles.extrasLabel}>Also</span>
          {EXTRAS.map((extra) => (
            <Link key={extra.label} to={extra.link} className={styles.chip}>
              {extra.label}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function Requirements() {
  return (
    <section className={`${styles.section} ${styles.alt}`}>
      <div className={`container ${styles.split}`}>
        <div>
          <Heading as="h2">What it runs on</Heading>
          <p>
            An Expo module with a config plugin, for development builds and bare React Native apps
            with <code>expo</code> installed. Expo Go doesn&apos;t include the native code, and the
            iOS Simulator has no Bluetooth: test on a phone.
          </p>
          <Link to="/docs/getting-started#requirements">All requirements →</Link>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <tbody>
              <tr>
                <th scope="row">Expo SDK</th>
                <td>57 or later</td>
              </tr>
              <tr>
                <th scope="row">React Native</th>
                <td>0.86, New Architecture</td>
              </tr>
              <tr>
                <th scope="row">iOS</th>
                <td>16.4 or later</td>
              </tr>
              <tr>
                <th scope="row">Android</th>
                <td>8.0 (API 26) or later</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Migration() {
  return (
    <section className={styles.section}>
      <div className={`container ${styles.split}`}>
        <div>
          <Heading as="h2">Coming from react-native-ble-plx?</Heading>
          <p>
            <code>expo-ble-kit/compat/plx</code> keeps ble-plx 3.5.1&apos;s API: the same classes,
            base64 values and error codes. Change the imports, then move to expo-ble-kit&apos;s own
            API one screen at a time.
          </p>
          <Link to="/docs/guides/migration-from-plx">Read the migration guide →</Link>
        </div>
        <CodeBlock language="diff">{MIGRATE}</CodeBlock>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout
      title="Bluetooth Low Energy for Expo and React Native"
      description="expo-ble-kit: scan, connect, read, write and subscribe from Expo and React Native apps, act as a GATT server, and test it all without hardware.">
      <Hero />
      <main>
        <Features />
        <Requirements />
        <Migration />
      </main>
    </Layout>
  );
}
