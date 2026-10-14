# The promo video

A 60-second, 1920×1080 video of expo-ble-kit, written with [Remotion](https://www.remotion.dev) (React components rendered to MP4). Its own dependencies and lockfile, like `website/`.

```bash
cd promo && yarn install
yarn studio    # preview and scrub in the browser
yarn render    # out/expo-ble-kit.mp4
```

Rendering uses the Chrome installed on this Mac (`REMOTION_CHROME` overrides it). Remotion is free for individuals and companies of up to three people; larger companies need its license.

## Scenes

`src/Promo.tsx` lists them with their lengths (30 fps): the hook, the title, the heart rate code typed live next to a phone, real footage, the features, the platforms, and the install command. The code on screen is the library's real API.

## Footage

`public/footage/` holds real recordings of the example app:

- `web.mp4`: the Explorer in Chrome on a Mac, connecting to an iPhone that serves the test profile (`e2e/web-chrome`). To record it again, start the example's web build and the iPhone's GATT server (`e2e/web-chrome/README.md`), then:

  ```bash
  RECORD=promo/out/web-frames PACE=1500 WINDOW=1300,860 node e2e/web-chrome/run.mjs http://localhost:8092 iPhone
  ffmpeg -f concat -safe 0 -i promo/out/web-frames/frames.ffconcat -vf "fps=30,scale=1600:-2,format=yuv420p" -c:v libx264 -crf 16 promo/out/web-raw.mp4
  ```

  then cut the part from connecting to the subscribed heart rate into `public/footage/web.mp4` (about 11 s, sped up to fit).
- `phone.mp4`: the example's Heart Rate tab on the iPhone 14 Pro Max, live from this Mac as the test peripheral (`e2e/macos-peripheral/run.sh 3600 "" heart-rate`, so a scan filtered on Heart Rate finds it). Recorded with `e2e/ios-screen-record/run.sh promo/out/phone.mov 90` while Argent drove the app, then cut, sped up 1.7× and with the Mac's hostname (shown once connected) blurred:

  ```bash
  ffmpeg -ss 4 -to 26 -i promo/out/phone.mov -vf "delogo=x=880:y=690:w=385:h=80,setpts=PTS/1.7,fps=30,scale=860:-2,format=yuv420p" -an -c:v libx264 -crf 17 promo/public/footage/phone.mp4
  ```

  Without it, the footage scene shows the browser alone.
