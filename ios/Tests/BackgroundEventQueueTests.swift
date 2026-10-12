import XCTest
@testable import BleKitCore

/// P3-02: background events wait until the app's JS had time to listen, then go out in order.
final class BackgroundEventQueueTests: XCTestCase {
  private var scheduler: TestScheduler!
  private var delivered: [Int] = []
  private var queue: BackgroundEventQueue!

  override func setUp() {
    super.setUp()
    scheduler = TestScheduler()
    delivered = []
    queue = BackgroundEventQueue(scheduler: scheduler) { [unowned self] in delivered.append($0["n"] as? Int ?? -1) }
  }

  func testEventsWaitForJsPlusTheGraceThenGoOutInOrder() {
    queue.launched()
    (1...3).forEach { queue.submit(["n": $0]) }
    scheduler.advance(by: 5)
    XCTAssertTrue(delivered.isEmpty)

    queue.jsStarted()
    scheduler.advance(by: BackgroundEventQueue.grace - 0.1)
    XCTAssertTrue(delivered.isEmpty, "TaskManager may still be starting to listen")
    queue.submit(["n": 4])
    scheduler.advance(by: 0.1)
    XCTAssertEqual(delivered, [1, 2, 3, 4])

    queue.submit(["n": 5])
    scheduler.runUntilIdle()
    XCTAssertEqual(delivered, [1, 2, 3, 4, 5], "released: straight through")
  }

  func testWithoutJsTheFallbackReleasesThem() {
    queue.launched()
    queue.submit(["n": 1])
    scheduler.advance(by: BackgroundEventQueue.fallbackDelay)
    XCTAssertEqual(delivered, [1])
  }

  func testTheOldestAreDroppedBeyondTheLimit() {
    (0...BackgroundEventQueue.maxHeld).forEach { queue.submit(["n": $0]) }
    XCTAssertEqual(queue.heldCount, BackgroundEventQueue.maxHeld)
    XCTAssertEqual(queue.dropped, 1)
    queue.jsStarted()
    scheduler.advance(by: BackgroundEventQueue.grace)
    XCTAssertEqual(delivered.first, 1)
    XCTAssertEqual(delivered.count, BackgroundEventQueue.maxHeld)
  }
}
