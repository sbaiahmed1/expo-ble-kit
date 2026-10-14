import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

import { colors } from './theme';

/** A dark ground with a slow teal glow and a faint grid. */
export function Background() {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [0, 1800], [30, 70]);
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at ${x}% 35%, ${colors.bgGlow} 0%, ${colors.bg} 55%)`,
      }}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${colors.line}22 1px, transparent 1px), linear-gradient(90deg, ${colors.line}22 1px, transparent 1px)`,
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(circle at 50% 50%, black 30%, transparent 75%)',
        }}
      />
    </AbsoluteFill>
  );
}
