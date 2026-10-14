import { interpolate, useCurrentFrame } from 'remotion';

/** The library's logo (website/static/img/logo.svg), its radio waves pulsing outwards. */
export function Logo({ size, pulse = true }: { size: number; pulse?: boolean }) {
  const frame = useCurrentFrame();
  const wave = (delay: number) =>
    pulse ? interpolate((frame - delay) % 45, [0, 20, 45], [0.35, 1, 0.35], { extrapolateLeft: 'clamp' }) : 1;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <defs>
        <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14b8a6" />
          <stop offset="1" stopColor="#0f766e" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#tile)" />
      <rect x="12" y="17" width="15" height="30" rx="4" fill="none" stroke="#fff" strokeWidth="4" />
      <path d="M34.2 26.3a8 8 0 0 1 0 11.4" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity={wave(0)} />
      <path d="M39.1 21.2a15 15 0 0 1 0 21.6" fill="none" stroke="#ccfbf1" strokeWidth="4" strokeLinecap="round" opacity={wave(8)} />
      <circle cx="51" cy="32" r="4.5" fill="#fff" opacity={wave(16)} />
    </svg>
  );
}
