import CoreBluetooth
import Foundation

/// What a STREAM run received. Used on the central's queue only.
final class StreamStats: @unchecked Sendable {
  var frames = 0
  var gaps = 0
  var corrupt = 0
  var truncated = 0
  var expected: UInt32 = 0
  var first: Date?
  var last = Date()

  func receive(_ frame: Data, size: Int) {
    guard frame.count >= 4 else {
      corrupt += 1
      return
    }
    let seq = frame.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
    if seq > expected { gaps += Int(seq - expected) }
    expected = seq &+ 1
    frames += 1
    if frame.count < size { truncated += 1 }
    // profile.json stream.frame: payload byte j is (seq + j) % 256.
    let payload = frame.dropFirst(4)
    if !payload.enumerated().allSatisfy({ $1 == UInt8(truncatingIfNeeded: Int(seq) + $0) }) { corrupt += 1 }
    if first == nil { first = Date() }
    last = Date()
  }
}

struct InvalidCommand {
  let bytes: [UInt8]
  let expected: [Int]
  let what: String
}

func hex(_ data: Data) -> String {
  data.prefix(20).map { String(format: "%02x", $0) }.joined(separator: " ") + (data.count > 20 ? " …" : "")
}

func uint32(_ data: Data) -> UInt32? {
  data.count == 4 ? data.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) } : nil
}

extension Central {
  func check(_ ok: Bool, _ message: String) {
    if ok { passed += 1 } else { failed += 1 }
    Log.write((ok ? "PASS " : "FAIL ") + message)
  }

  func runChecks() async {
    do {
      try await checkReads()
      try await checkWrites()
      try await checkStream(rateHz: 100, frameSize: 20, seconds: streamSeconds)
      let limit = queue.sync { peripheral?.maximumWriteValueLength(for: .withoutResponse) ?? 20 }
      try await checkStream(rateHz: 1000, frameSize: min(limit, profile.maxFrameSize), seconds: 5)
      try await checkIndications()
      try await checkInvalidCommands()
    } catch {
      check(false, "stopped: \(error)")
    }
  }

  /// P4-01: a static value, and long reads that each come from one handler result.
  func checkReads() async throws {
    let staticValue = try await read("STATIC_READ")
    check(staticValue == profile.staticRead, "STATIC_READ \(staticValue.count) bytes: \(hex(staticValue))")
    // The example's server shifts LONG_READ by one per handler call (a stitched read would mix two
    // shifts); a test peripheral returns it unshifted.
    for _ in 0..<2 {
      let value = try await read("LONG_READ")
      let base = profile.longRead
      let shift = value.isEmpty || base.isEmpty ? 0 : (Int(value[0]) - Int(base[0]) + 256) % 256
      let consistent = value.count == base.count && zip(value, base).allSatisfy { Int($0) == (Int($1) + shift) % 256 }
      check(consistent, "LONG_READ \(value.count) bytes, one snapshot (shift \(shift))")
    }
  }

  /// P4-01: writes, a long write, and writes without response.
  func checkWrites() async throws {
    try await write("ECHO_WRITE", Data([1, 2, 3]))
    let echo = try await read("ECHO_READ")
    check(echo == Data([1, 2, 3]), "ECHO 3 bytes: \(hex(echo))")
    let long = Data((0..<300).map { UInt8($0 % 256) })
    try await write("ECHO_WRITE", long)
    let longEcho = try await read("ECHO_READ")
    check(longEcho == long, "ECHO long write of \(long.count) bytes read back (\(longEcho.count) bytes)")

    try await control("RESET_COUNTERS")
    for _ in 0..<20 { try await writeWithoutResponse("SINK_NO_RSP", Data(count: 100)) }
    try await Task.sleep(nanoseconds: 1_000_000_000)
    let counter = uint32(try await read("SINK_COUNTER"))
    check(counter == 2000, "SINK 20 × 100 bytes without response: counter \(counter.map(String.init) ?? "?")")
  }

  /// P4-02: STREAM at `rateHz` for `seconds`, paced by the server's flow control: no gap allowed.
  func checkStream(rateHz: Int, frameSize: Int, seconds: Double) async throws {
    let stats = StreamStats()
    let size = [UInt8(frameSize & 0xFF), UInt8(frameSize >> 8)]
    try await control("RESET_COUNTERS")
    try await subscribe("STREAM") { stats.receive($0, size: frameSize) }
    try await control("SET_STREAM", [UInt8(rateHz & 0xFF), UInt8(rateHz >> 8)] + size)
    try await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
    try await control("SET_STREAM", [0, 0] + size)
    try await Task.sleep(nanoseconds: 1_000_000_000)
    try await unsubscribe("STREAM")
    queue.sync {
      let span = stats.first.map { stats.last.timeIntervalSince($0) } ?? 0
      let rate = span > 0 ? Double(stats.frames) / span : 0
      let kibPerSecond = rate * Double(frameSize) / 1024
      let summary = String(
        format: "%d frames, %d gaps, %d corrupt, %d truncated, %.1f frames/s, %.1f KiB/s",
        stats.frames, stats.gaps, stats.corrupt, stats.truncated, rate, kibPerSecond
      )
      check(
        stats.frames > 0 && stats.gaps == 0 && stats.corrupt == 0,
        "STREAM \(rateHz) Hz × \(frameSize) B for \(Int(seconds)) s: \(summary)"
      )
    }
  }

  /// P4-02: indications arrive in order, each confirmed.
  func checkIndications() async throws {
    var received: [UInt32] = []
    try await control("RESET_COUNTERS")
    try await subscribe("INDICATE") { value in
      if let seq = uint32(value) { received.append(seq) }
    }
    try await control("SEND_INDICATIONS", [5, 0])
    try await Task.sleep(nanoseconds: 3_000_000_000)
    try await unsubscribe("INDICATE")
    let sequence = queue.sync { received }
    check(sequence == [0, 1, 2, 3, 4], "INDICATE: SEND_INDICATIONS(5) delivered \(sequence)")
  }

  /// Invalid CONTROL commands are refused with an ATT error.
  func checkInvalidCommands() async throws {
    let cases = [
      InvalidCommand(bytes: [profile.unknownOpcode], expected: profile.unknownOpcodeErrors, what: "unknown opcode"),
      InvalidCommand(
        bytes: [try profile.opcode("SET_STREAM"), 100],
        expected: profile.invalidParameterErrors,
        what: "SET_STREAM with 1 parameter byte"
      )
    ]
    for item in cases {
      do {
        try await write("CONTROL", Data(item.bytes))
        check(false, "CONTROL \(item.what) was accepted")
      } catch let error as CBATTError {
        let code = error.code.rawValue
        check(item.expected.contains(code), "CONTROL \(item.what) refused with ATT 0x\(String(code, radix: 16))")
      }
    }
  }
}
