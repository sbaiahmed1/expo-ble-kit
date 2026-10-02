import XCTest
@testable import BleKitCore

/// P1-02: ordering, per-operation timeouts, cancellation, reject-all on disconnect, and a randomized
/// check that no operation starts while another is in flight.
final class GattQueueTests: XCTestCase {
  private var scheduler: TestScheduler!
  private var queue: GattQueue!
  private var started: [String] = []
  private var results: [String: Result<GattOperation.Output, CoreError>] = [:]

  override func setUp() {
    super.setUp()
    scheduler = TestScheduler()
    queue = GattQueue(scheduler: scheduler)
    started = []
    results = [:]
  }

  @discardableResult
  private func enqueue(_ name: String, timeout: TimeInterval? = nil) -> GattOperation {
    queue.enqueue(
      .read,
      target: name,
      timeout: timeout,
      start: { [unowned self] in started.append(name) },
      completion: { [unowned self] result in
        XCTAssertNil(results[name], "\(name) answered twice")
        results[name] = result
      }
    )
  }

  private func complete(_ name: String, _ output: GattOperation.Output = .none) -> Bool {
    queue.complete(.success(output)) { $0.target == name }
  }

  private func errorCode(_ name: String) -> CoreError.Code? {
    if case let .failure(error) = results[name] {
      return error.code
    }
    return nil
  }

  func testRunsOneOperationAtATimeInSubmissionOrder() {
    enqueue("a")
    enqueue("b")
    enqueue("c")
    XCTAssertEqual(started, [], "nothing starts synchronously")
    scheduler.runUntilIdle()
    XCTAssertEqual(started, ["a"])
    XCTAssertEqual(queue.depth, 3)

    XCTAssertFalse(complete("b"), "only the in-flight operation can complete")
    XCTAssertTrue(complete("a", .value(Data([1]))))
    XCTAssertEqual(started, ["a"], "the next operation starts on the next turn")
    scheduler.runUntilIdle()
    XCTAssertEqual(started, ["a", "b"])
    XCTAssertTrue(complete("b"))
    scheduler.runUntilIdle()
    XCTAssertTrue(complete("c"))
    scheduler.runUntilIdle()

    XCTAssertEqual(started, ["a", "b", "c"])
    XCTAssertEqual(try results["a"]?.get(), .value(Data([1])))
    XCTAssertEqual(queue.depth, 0)
  }

  func testTimeoutRejectsTheOperationMovesOnAndIgnoresTheLateResult() {
    var timeouts: [Int] = []
    queue.onTimeout = { _, count in timeouts.append(count) }
    enqueue("a", timeout: 2)
    enqueue("b")
    scheduler.runUntilIdle()

    scheduler.advance(by: 1.9)
    XCTAssertNil(results["a"])
    scheduler.advance(by: 0.1)
    XCTAssertEqual(errorCode("a"), .operationTimeout)
    XCTAssertEqual(started, ["a", "b"])
    XCTAssertFalse(complete("a"), "a late result for the timed-out operation is ignored")
    XCTAssertEqual(timeouts, [1])
    XCTAssertEqual(queue.consecutiveTimeouts, 1)

    scheduler.advance(by: GattQueue.defaultTimeout)
    XCTAssertEqual(errorCode("b"), .operationTimeout, "the default timeout is 10 s")
    XCTAssertEqual(timeouts, [1, 2])

    enqueue("c")
    scheduler.runUntilIdle()
    XCTAssertTrue(complete("c"))
    XCTAssertEqual(queue.consecutiveTimeouts, 0, "a completion resets the count")
  }

  func testCancellingAQueuedOperationRemovesIt() {
    enqueue("a")
    let second = enqueue("b")
    scheduler.runUntilIdle()

    queue.cancel(second)
    XCTAssertEqual(errorCode("b"), .operationCancelled)
    XCTAssertTrue(complete("a"))
    scheduler.runUntilIdle()
    XCTAssertEqual(started, ["a"])
    XCTAssertEqual(queue.depth, 0)
  }

  func testCancellingTheRunningOperationAnswersAtOnceButKeepsTheRadioBusy() {
    let first = enqueue("a")
    enqueue("b")
    scheduler.runUntilIdle()

    queue.cancel(first)
    XCTAssertEqual(errorCode("a"), .operationCancelled)
    scheduler.runUntilIdle()
    XCTAssertEqual(started, ["a"], "b must wait: the platform read can't be aborted")

    XCTAssertTrue(complete("a", .value(Data([9]))), "the radio's answer frees the queue")
    XCTAssertEqual(errorCode("a"), .operationCancelled, "but the caller keeps the cancellation")
    scheduler.runUntilIdle()
    XCTAssertEqual(started, ["a", "b"])
  }

  func testFailAllRejectsEverythingAndStartsNothing() {
    enqueue("a")
    enqueue("b")
    scheduler.runUntilIdle()

    queue.failAll(CoreError(.disconnected, "link lost"))
    scheduler.advance(by: 60)

    XCTAssertEqual(errorCode("a"), .disconnected)
    XCTAssertEqual(errorCode("b"), .disconnected)
    XCTAssertEqual(started, ["a"])
    XCTAssertEqual(queue.depth, 0)
  }

  func testAnOperationCompletingInsideStartDoesNotStartTheNextReentrantly() {
    var insideStart = false
    queue.enqueue(.writeWithoutResponse, target: "a", start: { [unowned self] in
      insideStart = true
      XCTAssertTrue(complete("a"))
      insideStart = false
    }, completion: { _ in })
    queue.enqueue(.writeWithoutResponse, target: "b", start: {
      XCTAssertFalse(insideStart, "b started inside a's start")
    }, completion: { _ in })

    scheduler.runUntilIdle()
    XCTAssertEqual(queue.current?.target, "b")
  }

  /// Randomized: whatever happens, an operation never starts while another holds the radio, every
  /// caller is answered exactly once, and successful results arrive in submission order.
  func testRandomizedOperationsNeverOverlap() {
    for seed in UInt64(1)...25 {
      RandomizedQueueRun(seed: seed).run(steps: 2_000)
    }
  }
}

/// Drives a `GattQueue` with random actions and checks its invariants.
private final class RandomizedQueueRun {
  private let seed: UInt64
  private let scheduler = TestScheduler()
  private let queue: GattQueue
  private var random: SplitMix64
  /// The radio is held from `start` until the operation completes, times out or the queue fails.
  private var radioHolder: Int?
  private var answers: [Int: Int] = [:]
  private var successes: [Int] = []
  private var operations: [GattOperation] = []

  init(seed: UInt64) {
    self.seed = seed
    random = SplitMix64(seed: seed)
    queue = GattQueue(scheduler: scheduler, defaultTimeout: 3)
    queue.onTimeout = { [unowned self] operation, _ in
      if radioHolder == operation.id {
        radioHolder = nil
      }
    }
  }

  func run(steps: Int) {
    for _ in 0..<steps {
      step()
    }
    queue.failAll(CoreError(.disconnected, "end of test"))
    scheduler.advance(by: 60)
    for operation in operations {
      let count = answers[operation.id] ?? 0
      XCTAssertEqual(count, 1, "seed \(seed): op \(operation.id) answered \(count) times")
    }
    XCTAssertEqual(successes, successes.sorted(), "seed \(seed): successes out of submission order")
  }

  private func step() {
    switch random.next(upTo: 10) {
    case 0...2: enqueueOne()
    case 3, 4: completeRunning()
    case 5: cancelRandom()
    case 6, 7: scheduler.advance(by: Double(random.next(upTo: 2000)) / 1000)
    case 8: scheduler.runUntilIdle()
    default: maybeDisconnect()
    }
  }

  private func enqueueOne() {
    var operation: GattOperation!
    operation = queue.enqueue(
      .read,
      timeout: Double(random.next(upTo: 5) + 1),
      start: { [unowned self] in
        let holder = radioHolder ?? -1
        XCTAssertNil(radioHolder, "seed \(seed): op \(operation.id) started while op \(holder) was in flight")
        radioHolder = operation.id
      },
      completion: { [unowned self] result in
        answers[operation.id, default: 0] += 1
        if case .success = result {
          successes.append(operation.id)
        }
      }
    )
    operations.append(operation)
  }

  private func completeRunning() {
    guard let holder = radioHolder else {
      return
    }
    let result: Result<GattOperation.Output, CoreError> =
      random.next(upTo: 4) != 0 ? .success(.none) : .failure(CoreError(.gattError, "status 133"))
    if queue.complete(result, where: { $0.id == holder }) {
      radioHolder = nil
    }
  }

  private func cancelRandom() {
    guard !operations.isEmpty else {
      return
    }
    queue.cancel(operations[Int(random.next(upTo: UInt64(operations.count)))])
  }

  private func maybeDisconnect() {
    guard random.next(upTo: 20) == 0 else {
      return
    }
    queue.failAll(CoreError(.disconnected, "link lost"))
    radioHolder = nil
  }
}

/// Small seedable PRNG so randomized tests are reproducible.
struct SplitMix64 {
  private var state: UInt64

  init(seed: UInt64) {
    state = seed
  }

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var value = state
    value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
    value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
    return value ^ (value >> 31)
  }

  mutating func next(upTo bound: UInt64) -> UInt64 {
    next() % bound
  }
}
