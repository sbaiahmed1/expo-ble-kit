# Web Bluetooth in desktop Chrome (P6-02)

`run.mjs` runs the example's Explorer flow in Chrome over Web Bluetooth, with this Mac's Chrome as the central: scan (the browser's device chooser), connect with discovery, a read, a 512-byte long read, a write read back, three notifications, and a disconnect.

```bash
cd example && BROWSER=none yarn expo start --web --port 8092   # the example's web build
node e2e/web-chrome/run.mjs http://localhost:8092 iPhone       # [url] [device name prefix]
```

- The test peripheral has to be another device: the example on a phone serving the test profile (Peripheral tab, or `xcrun devicectl device process launch --payload-url expo.modules.blekit.example://server/serve …`), or the Bumble one. Chrome may list a phone under its system name ("iPhone") rather than the advertised one, and several devices may share it: the script tries each until one has the TEST service.
- Chrome starts with a throwaway profile and DevTools on port 9333 (`CDP_PORT`). The chooser is answered through DevTools (`DeviceAccess`), and taps are DevTools input events, which Chrome counts as the person's: it opens the chooser only right after one.
- Chrome is launched with `open`. Started directly from a terminal, macOS checks Bluetooth access against the terminal's app and stops Chrome for lacking a usage string. The first run asks to let Chrome use Bluetooth (System Settings → Privacy & Security → Bluetooth).
- Web Bluetooth only exposes primary services, so the profile's secondary service doesn't appear.
