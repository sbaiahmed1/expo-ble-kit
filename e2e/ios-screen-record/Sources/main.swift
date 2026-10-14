import AVFoundation
import CoreMediaIO
import Foundation

// Records the screen of an iPhone connected by cable, the way QuickTime's movie recording does
// (README.md):
//   BleKitScreenRecord <log> <output.mov> <max seconds> <stop file>
// Recording stops when the stop file exists, or after max seconds. The log ends with DONE or FAILED.

let arguments = CommandLine.arguments
guard arguments.count == 5 else {
  fputs("usage: BleKitScreenRecord <log> <output.mov> <max seconds> <stop file>\n", stderr)
  exit(2)
}
let logURL = URL(fileURLWithPath: arguments[1])
let outputURL = URL(fileURLWithPath: arguments[2])
let maxSeconds = Double(arguments[3]) ?? 120
let stopFile = arguments[4]
let started = Date()

func log(_ line: String) {
  let text = String(format: "%7.3f %@\n", Date().timeIntervalSince(started), line)
  if let handle = try? FileHandle(forWritingTo: logURL) {
    handle.seekToEndOfFile()
    handle.write(Data(text.utf8))
    try? handle.close()
  } else {
    try? Data(text.utf8).write(to: logURL)
  }
}

func fail(_ reason: String) -> Never {
  log("FAILED: \(reason)")
  exit(1)
}

/// Spins the run loop until `done` or `timeout` seconds pass; device and recording events need it.
func wait(_ timeout: TimeInterval, until done: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while !done() {
    if Date() > deadline { return false }
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
  }
  return true
}

// iOS devices appear as capture devices only in a process that allows screen capture devices.
var address = CMIOObjectPropertyAddress(
  mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
  mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
  mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
)
var allow: UInt32 = 1
CMIOObjectSetPropertyData(
  CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow
)

// Capturing an iOS device's screen counts as camera access.
var access: Bool?
AVCaptureDevice.requestAccess(for: .video) { granted in access = granted }
guard wait(120, until: { access != nil }), access == true else {
  fail("camera access was not granted (System Settings → Privacy & Security → Camera)")
}

func phone() -> AVCaptureDevice? {
  AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: .muxed, position: .unspecified)
    .devices.first
}
var device: AVCaptureDevice?
guard wait(20, until: { device = phone(); return device != nil }), let device else {
  fail("no iPhone screen to capture: connect it by cable, unlock it and trust this Mac")
}
log("capturing \(device.localizedName)")

final class Finish: NSObject, AVCaptureFileOutputRecordingDelegate {
  var done = false
  var error: Error?
  func fileOutput(
    _ output: AVCaptureFileOutput, didFinishRecordingTo url: URL, from connections: [AVCaptureConnection],
    error: Error?
  ) {
    self.error = error
    done = true
  }
}

let session = AVCaptureSession()
do {
  session.addInput(try AVCaptureDeviceInput(device: device))
} catch {
  fail("can't open \(device.localizedName): \(error)")
}
let movie = AVCaptureMovieFileOutput()
guard session.canAddOutput(movie) else { fail("can't record a movie from \(device.localizedName)") }
session.addOutput(movie)
session.startRunning()
try? FileManager.default.removeItem(at: outputURL)
let finish = Finish()
movie.startRecording(to: outputURL, recordingDelegate: finish)
guard wait(10, until: { movie.isRecording }) else { fail("recording didn't start") }
log("recording")

_ = wait(maxSeconds, until: { FileManager.default.fileExists(atPath: stopFile) })
movie.stopRecording()
guard wait(15, until: { finish.done }) else { fail("recording didn't finish") }
session.stopRunning()
if let error = finish.error, (error as NSError).userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool != true {
  fail("recording ended with \(error)")
}
log("DONE \(outputURL.path)")
