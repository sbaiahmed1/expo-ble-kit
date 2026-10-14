import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

import { Logo } from '../Logo';
import { progress, sceneOpacity } from '../anim';
import { colors, fonts } from '../theme';

const COMMAND = 'npx expo install expo-ble-kit';

/** Install it, read the docs. */
export function CallToAction({ length }: { length: number }) {
  const frame = useCurrentFrame();
  const typed = Math.floor(interpolate(frame, [14, 60], [0, COMMAND.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  const links = progress(frame, 72, 18);
  return (
    <AbsoluteFill
      style={{
        opacity: sceneOpacity(frame, length, 14),
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'column',
        gap: 54,
      }}>
      <Logo size={150} />
      <div
        style={{
          padding: '30px 50px',
          borderRadius: 22,
          background: colors.surface,
          border: `1px solid ${colors.line}`,
          fontFamily: fonts.mono,
          fontSize: 54,
          color: colors.text,
          minWidth: 1100,
        }}>
        <span style={{ color: colors.accent }}>$ </span>
        {COMMAND.slice(0, typed)}
        <span style={{ opacity: Math.floor(frame / 15) % 2 ? 0 : 1, color: colors.accent }}>▍</span>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18,
          opacity: links,
          transform: `translateY(${(1 - links) * 20}px)`,
          fontFamily: fonts.sans,
        }}>
        <div style={{ fontSize: 44, fontWeight: 700, color: colors.text }}>sbaiahmed1.github.io/expo-ble-kit</div>
        <div style={{ fontSize: 34, color: colors.muted }}>github.com/sbaiahmed1/expo-ble-kit · MIT</div>
      </div>
    </AbsoluteFill>
  );
}
