import { colors, fonts } from './theme';

/** A phone outline; `children` fill the screen. */
export function Phone({ children, scale = 1 }: { children: React.ReactNode; scale?: number }) {
  return (
    <div
      style={{
        width: 420 * scale,
        height: 860 * scale,
        borderRadius: 64 * scale,
        padding: 16 * scale,
        background: '#0b0f10',
        border: `3px solid ${colors.line}`,
        boxShadow: `0 50px 100px rgba(0,0,0,0.5), 0 0 0 1px ${colors.surfaceHigh}`,
        position: 'relative',
      }}>
      <div
        style={{
          position: 'absolute',
          top: 30 * scale,
          left: '50%',
          width: 120 * scale,
          height: 34 * scale,
          marginLeft: -60 * scale,
          borderRadius: 20 * scale,
          background: '#000',
          zIndex: 2,
        }}
      />
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 50 * scale,
          overflow: 'hidden',
          background: '#f4f8f7',
          fontFamily: fonts.sans,
          position: 'relative',
        }}>
        {children}
      </div>
    </div>
  );
}
