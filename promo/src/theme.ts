import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';

const inter = loadInter('normal', { weights: ['400', '500', '600', '700', '800'], subsets: ['latin'] });
const mono = loadMono('normal', { weights: ['400', '500', '700'], subsets: ['latin'] });

/** The website's teal (website/src/css/custom.css), on a dark ground. */
export const colors = {
  bg: '#061416',
  bgGlow: '#0b2f2f',
  surface: '#0c2326',
  surfaceHigh: '#123236',
  line: '#1d4448',
  text: '#e8fbf8',
  muted: '#8fb5af',
  accent: '#2dd4bf',
  accentDeep: '#14b8a6',
  brand: '#0f766e',
  mint: '#ccfbf1',
  danger: '#f87171',
  amber: '#fbbf24',
  // Code
  keyword: '#c4a7ff',
  string: '#fcd38d',
  number: '#f9a8d4',
  fn: '#7dd3fc',
  comment: '#5f8580',
};

export const fonts = {
  sans: inter.fontFamily,
  mono: mono.fontFamily,
};

export const FPS = 30;
