import { AbsoluteFill, useCurrentFrame } from 'remotion';

import { pop, progress, sceneOpacity } from '../anim';
import { colors, fonts } from '../theme';

const FEATURES: [string, string][] = [
  ['One operation at a time', 'A queue per connection, a timeout on every call, AbortSignal to cancel'],
  ['Typed errors', 'BleError with a code you can switch on, and whether a retry can work'],
  ['React hooks', 'useScan, usePeripheral, useCharacteristicValue, useBleState'],
  ['Binary first', 'Uint8Array end to end: no base64'],
  ['Streams and fast sensors', 'writeStream with progress, notifications batched natively'],
  ['The phone as the device', 'A GATT server, notifications and advertising'],
  ['L2CAP channels', 'Raw byte streams, both ways'],
  ['Background', 'iOS state restoration, Android foreground service and wake-ups'],
  ['System pickers', 'AccessorySetupKit on iOS, CompanionDeviceManager on Android'],
  ['Web Bluetooth', 'The same API in Chrome and Edge'],
  ['A fake for Jest', 'Virtual peripherals that behave like real ones'],
  ['Agent skill', 'Ships with recipes your coding agent can follow'],
];

/** Everything else, card by card. */
export function Features({ length }: { length: number }) {
  const frame = useCurrentFrame();
  const title = progress(frame, 0, 14);
  return (
    <AbsoluteFill style={{ opacity: sceneOpacity(frame, length) }}>
      <div
        style={{
          position: 'absolute',
          top: 64,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: fonts.sans,
          fontSize: 50,
          fontWeight: 700,
          color: colors.text,
          opacity: title,
        }}>
        Everything a Bluetooth app needs
      </div>
      <div
        style={{
          position: 'absolute',
          top: 180,
          left: 100,
          right: 100,
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 22,
        }}>
        {FEATURES.map(([name, detail], index) => {
          const shown = pop(frame, 10 + index * 6);
          return (
            <div
              key={name}
              style={{
                height: 238,
                padding: '26px 26px',
                borderRadius: 22,
                background: colors.surface,
                border: `1px solid ${colors.line}`,
                opacity: shown,
                transform: `translateY(${(1 - shown) * 40}px)`,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}>
              <div style={{ width: 40, height: 6, borderRadius: 3, background: colors.accent }} />
              <div style={{ fontFamily: fonts.sans, fontSize: 31, fontWeight: 700, color: colors.text }}>{name}</div>
              <div style={{ fontFamily: fonts.sans, fontSize: 22, lineHeight: 1.4, color: colors.muted }}>{detail}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}
