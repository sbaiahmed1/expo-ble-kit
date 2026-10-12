import Foundation

/// What happened around state restoration (P3-01): launches and why, scenes, restored peripherals,
/// background notifications. A background relaunch shows nothing on screen and may run no JS at
/// all, so the journal keeps the last entries in a file across launches; `getDiagnostics()` reads
/// them. Consecutive notifications from one characteristic count into one entry.
///
/// Threading: any thread.
final class RestorationJournal {
  struct Entry: Codable, Equatable {
    /// Epoch milliseconds of the latest occurrence.
    var time: Double
    var event: String
    /// How many times it happened in a row (notifications).
    var count: Int
  }

  static let maxEntries = 100

  private let url: URL?
  private let lock = NSLock()
  private var entries: [Entry]
  /// The key of the last entry when it counts repeats, so the next same one adds to it.
  private var repeatKey: String?

  /// `url`: the file; nil keeps the journal in memory (tests).
  init(url: URL?) {
    self.url = url
    entries = url.flatMap { try? Data(contentsOf: $0) }
      .flatMap { try? JSONDecoder().decode([Entry].self, from: $0) } ?? []
  }

  /// The default file: Application Support/expo-ble-kit/restoration-journal.json.
  static var defaultURL: URL? {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("expo-ble-kit", isDirectory: true)
      .appendingPathComponent("restoration-journal.json")
  }

  /// Adds `event`. With `repeating`, an entry right after one with the same key counts into it.
  func record(_ event: String, at time: Double = Date().timeIntervalSince1970 * 1000, repeating key: String? = nil) {
    lock.lock()
    if let key, key == repeatKey, var last = entries.popLast() {
      last.count += 1
      last.time = time
      last.event = event
      entries.append(last)
    } else {
      entries.append(Entry(time: time, event: event, count: 1))
      if entries.count > Self.maxEntries {
        entries.removeFirst(entries.count - Self.maxEntries)
      }
    }
    repeatKey = key
    let snapshot = entries
    lock.unlock()
    save(snapshot)
  }

  var all: [Entry] {
    lock.lock()
    defer { lock.unlock() }
    return entries
  }

  func clear() {
    lock.lock()
    entries.removeAll()
    repeatKey = nil
    lock.unlock()
    save([])
  }

  private func save(_ snapshot: [Entry]) {
    guard let url, let data = try? JSONEncoder().encode(snapshot) else {
      return
    }
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: url, options: .atomic)
  }
}
