import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

import { pop, progress, sceneOpacity } from '../anim';
import { colors, fonts } from '../theme';

const PAINS = [
  'Promises that never resolve',
  'base64 strings for every value',
  'GATT error 133, again',
  'Lost the moment the app is in the background',
];

/** What Bluetooth in React Native usually feels like, struck out one by one. */
export function Hook({ length }: { length: number }) {
  const frame = useCurrentFrame();
  const headline = progress(frame, 100, 18);
  return (
    <AbsoluteFill
      style={{ opacity: sceneOpacity(frame, length), justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 26, marginTop: -120 }}>
        {PAINS.map((pain, index) => {
          const start = 8 + index * 18;
          const shown = pop(frame, start);
          const strike = progress(frame, start + 12, 10);
          return (
            <div
              key={pain}
              style={{
                position: 'relative',
                alignSelf: 'flex-start',
                fontFamily: fonts.sans,
                fontSize: 54,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                color: colors.muted,
                opacity: shown * interpolate(headline, [0, 1], [1, 0.25]),
                transform: `translateX(${(1 - shown) * -40}px)`,
              }}>
              {pain}
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: '52%',
                  height: 6,
                  borderRadius: 3,
                  width: `${strike * 100}%`,
                  background: colors.danger,
                }}
              />
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: 150,
          fontFamily: fonts.sans,
          fontSize: 64,
          fontWeight: 800,
          color: colors.text,
          letterSpacing: -1,
          opacity: headline,
          transform: `translateY(${(1 - headline) * 30}px)`,
        }}>
        Bluetooth in React Native <span style={{ color: colors.accent }}>shouldn't be this hard.</span>
      </div>
    </AbsoluteFill>
  );
}
