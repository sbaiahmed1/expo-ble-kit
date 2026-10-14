import { Config } from '@remotion/cli/config';

// Renders with the Chrome already on this Mac instead of downloading one.
Config.setBrowserExecutable(
  process.env.REMOTION_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
);
Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(92);
Config.setCodec('h264');
Config.setCrf(18);
