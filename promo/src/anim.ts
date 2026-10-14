import { interpolate, spring } from 'remotion';

import { FPS } from './theme';

/** 0 → 1 over `duration` frames from `start`, eased. */
export function progress(frame: number, start: number, duration: number) {
  return interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: (t) => 1 - Math.pow(1 - t, 3),
  });
}

/** A soft spring from `start`. */
export function pop(frame: number, start: number, damping = 14) {
  return spring({ frame: frame - start, fps: FPS, config: { damping, mass: 0.7 } });
}

/** Fades a scene in over its first frames and out over its last. */
export function sceneOpacity(frame: number, length: number, fade = 10) {
  return interpolate(frame, [0, fade, length - fade, length], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}
