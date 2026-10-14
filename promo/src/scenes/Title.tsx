import { AbsoluteFill, useCurrentFrame } from 'remotion';

import { Logo } from '../Logo';
import { pop, progress, sceneOpacity } from '../anim';
import { colors, fonts } from '../theme';

/** The logo, the name and the one-line pitch. */
export function Title({ length }: { length: number }) {
  const frame = useCurrentFrame();
  const logo = pop(frame, 4, 11);
  const name = progress(frame, 16, 18);
  const pitch = progress(frame, 34, 18);
  return (
    <AbsoluteFill
      style={{
        opacity: sceneOpacity(frame, length),
        justifyContent: 'center',
        alignItems: 'center',
        gap: 36,
        flexDirection: 'column',
      }}>
      <div style={{ transform: `scale(${logo})` }}>
        <Logo size={220} />
      </div>
      <div
        style={{
          fontFamily: fonts.sans,
          fontSize: 120,
          fontWeight: 800,
          letterSpacing: -3,
          color: colors.text,
          opacity: name,
          transform: `translateY(${(1 - name) * 24}px)`,
        }}>
        expo-ble-kit <span style={{ color: colors.accent }}>2.0</span>
      </div>
      <div
        style={{
          fontFamily: fonts.sans,
          fontSize: 44,
          fontWeight: 500,
          color: colors.muted,
          opacity: pitch,
        }}>
        Bluetooth Low Energy for Expo and React Native
      </div>
    </AbsoluteFill>
  );
}
