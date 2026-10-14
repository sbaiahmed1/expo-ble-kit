import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

import { Editor, TypedCode } from '../Code';
import { Phone } from '../Phone';
import { pop, progress, sceneOpacity } from '../anim';
import { colors, fonts } from '../theme';

const CODE = `import {
  BleManager, GattServices, GattCharacteristics,
} from 'expo-ble-kit';

await BleManager.requestPermissionsAsync();

const strap = await BleManager.scanFor({
  services: [GattServices.HeartRate],
  timeoutMs: 10_000,
});

const device = BleManager.getPeripheral(strap!.id);
await device.connect({ reconnect: {} });

await device.subscribe(
  GattServices.HeartRate,
  GattCharacteristics.HeartRateMeasurement,
  (value) => setBpm(value[1]),
);`;

const TYPE_START = 20;
const TYPE_END = 290;
const SCAN_AT = CODE.indexOf('const strap');
const CONNECT_AT = CODE.indexOf('const device');
const SUBSCRIBE_AT = CODE.length - 2;

/** A heart-rate screen written live: the phone follows the code as it is typed. */
export function CodeDemo({ length }: { length: number }) {
  const frame = useCurrentFrame();
  const chars = interpolate(frame, [TYPE_START, TYPE_END], [0, CODE.length], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const stage =
    chars >= SUBSCRIBE_AT ? 'live' : chars >= CONNECT_AT ? 'connecting' : chars >= SCAN_AT ? 'scanning' : 'idle';
  const caption = progress(frame, 300, 16);
  const phoneIn = pop(frame, 8);
  return (
    <AbsoluteFill style={{ opacity: sceneOpacity(frame, length) }}>
      <div
        style={{
          position: 'absolute',
          top: 70,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: fonts.sans,
          fontSize: 46,
          fontWeight: 700,
          color: colors.text,
        }}>
        A live heart rate monitor, <span style={{ color: colors.accent }}>start to finish</span>
      </div>
      <div style={{ position: 'absolute', left: 90, top: 165 }}>
        <Editor title="HeartRate.tsx" width={1150}>
          <TypedCode code={CODE} chars={chars} fontSize={23} />
        </Editor>
      </div>
      <div
        style={{
          position: 'absolute',
          right: 120,
          top: 150,
          transform: `scale(${phoneIn}) translateY(${(1 - phoneIn) * 60}px)`,
        }}>
        <Phone>
          <HeartRateScreen stage={stage} frame={frame} />
        </Phone>
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: 34,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: fonts.sans,
          fontSize: 32,
          color: colors.muted,
          opacity: caption,
        }}>
        Every operation queued, with a timeout · values as <span style={{ color: colors.text }}>Uint8Array</span>, never base64
      </div>
    </AbsoluteFill>
  );
}

function HeartRateScreen({ stage, frame }: { stage: string; frame: number }) {
  const bpm = Math.round(72 + 4 * Math.sin(frame / 22) + 2 * Math.sin(frame / 7));
  const beat = 1 + 0.12 * Math.max(0, Math.sin((frame / 30) * Math.PI * 2.4));
  const status =
    stage === 'live'
      ? 'Connected · auto-reconnect'
      : stage === 'connecting'
        ? 'Connecting…'
        : stage === 'scanning'
          ? 'Looking for a strap…'
          : 'Ready';
  return (
    <div style={{ padding: '90px 30px 30px', display: 'flex', flexDirection: 'column', gap: 26, height: '100%' }}>
      <div style={{ fontSize: 34, fontWeight: 800, color: '#0b2a2b' }}>Heart Rate</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 20,
          color: stage === 'live' ? colors.brand : '#5b6f6c',
          fontWeight: 600,
        }}>
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: 6,
            background: stage === 'live' ? colors.accentDeep : stage === 'idle' ? '#9bb3ae' : colors.amber,
          }}
        />
        {status}
      </div>
      <div
        style={{
          flex: 1,
          borderRadius: 36,
          background: 'white',
          boxShadow: '0 10px 30px rgba(15,118,110,0.12)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}>
        <div style={{ fontSize: 80, transform: `scale(${stage === 'live' ? beat : 1})`, opacity: stage === 'live' ? 1 : 0.25 }}>
          ❤️
        </div>
        <div style={{ fontSize: 120, fontWeight: 800, color: '#0b2a2b', letterSpacing: -4 }}>
          {stage === 'live' ? bpm : '--'}
        </div>
        <div style={{ fontSize: 26, color: '#5b6f6c', fontWeight: 600 }}>bpm</div>
      </div>
      <div style={{ fontSize: 18, color: '#7a8e8a', textAlign: 'center' }}>BleKit HRM · Heart Rate 0x180D</div>
    </div>
  );
}
