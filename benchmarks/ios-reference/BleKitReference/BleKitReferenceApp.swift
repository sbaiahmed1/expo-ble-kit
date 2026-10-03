import os
import SwiftUI

// The iOS reference app of docs/benchmarks.md (plan P2-08): plain SwiftUI and CoreBluetooth.

@main
struct BleKitReferenceApp: App {
  var body: some Scene {
    WindowGroup {
      ContentView()
    }
  }
}

/// One button, one log. Results also go to the unified log (subsystem `expo.blekit.reference`), one
/// `RESULT` line per transfer.
struct ContentView: View {
  @State private var lines: [String] = []
  @State private var running = false
  private let logger = Logger(subsystem: "expo.blekit.reference", category: "benchmark")

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Button(running ? "Running…" : "Run benchmarks") { run() }
        .buttonStyle(.borderedProminent)
        .disabled(running)
      ScrollView {
        Text(lines.joined(separator: "\n"))
          .font(.system(.footnote, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding()
  }

  private func run() {
    running = true
    lines = []
    Task {
      let benchmark = Benchmark { line in
        lines.append(line)
        logger.notice("\(line, privacy: .public)")
      }
      do {
        _ = try await benchmark.runAll()
        lines.append("Done")
      } catch {
        lines.append("Failed: \(error.localizedDescription)")
      }
      running = false
    }
  }
}
