import { AbsoluteFill, useCurrentFrame } from 'remotion';

import { pop, progress, sceneOpacity } from '../anim';
import { colors, fonts } from '../theme';

const PLATFORMS: [string, string[]][] = [
  ['iOS', ['iOS 16.4+', 'State restoration', 'AccessorySetupKit']],
  ['Android', ['Android 8+', 'Foreground service', 'Companion devices']],
  ['Web', ['Chrome and Edge', 'Web Bluetooth', 'Same API']],
];

/** Where it runs. */
export function Platforms({ length }: { length: number }) {
  const frame = useCurrentFrame();
  const footer = progress(frame, 40, 16);
  return (
    <AbsoluteFill
      style={{ opacity: sceneOpacity(frame, length), justifyContent: 'center', alignItems: 'center', gap: 60 }}>
      <div style={{ display: 'flex', gap: 40 }}>
        {PLATFORMS.map(([name, lines], index) => {
          const shown = pop(frame, 4 + index * 8);
          return (
            <div
              key={name}
              style={{
                width: 420,
                padding: '44px 40px',
                borderRadius: 28,
                background: colors.surface,
                border: `2px solid ${colors.line}`,
                transform: `scale(${shown})`,
                display: 'flex',
                flexDirection: 'column',
                gap: 18,
              }}>
              <div style={{ fontFamily: fonts.sans, fontSize: 64, fontWeight: 800, color: colors.text }}>{name}</div>
              {lines.map((line) => (
                <div
                  key={line}
                  style={{ fontFamily: fonts.sans, fontSize: 30, color: colors.muted, display: 'flex', gap: 14 }}>
                  <span style={{ color: colors.accent }}>✓</span>
                  {line}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div style={{ fontFamily: fonts.sans, fontSize: 34, color: colors.muted, opacity: footer }}>
        Expo SDK 57 · New Architecture · checked on real phones
      </div>
    </AbsoluteFill>
  );
}
