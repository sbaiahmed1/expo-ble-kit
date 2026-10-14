# Recording an iPhone's screen

`run.sh` records the screen of the iPhone connected to this Mac by cable into a `.mov`, the way QuickTime's movie recording does, for the promo video's phone footage (`promo/README.md`).

```bash
e2e/ios-screen-record/run.sh promo/out/phone.mov 90   # stops after 90 s at most
touch e2e/ios-screen-record/build/stop                 # or earlier, from another shell
```

- The iPhone must be unlocked and trust this Mac. macOS asks once to let BleKitScreenRecord use the camera: an iPhone's screen is a camera to macOS.
- iOS devices only appear as capture devices in a process that allows them (CoreMediaIO's `kCMIOHardwarePropertyAllowScreenCaptureDevices`), so ffmpeg alone doesn't see the phone.
- Drive the app meanwhile with Argent (cable needed too), or by hand.
