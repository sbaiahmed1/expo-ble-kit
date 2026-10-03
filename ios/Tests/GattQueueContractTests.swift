import Foundation
import XCTest
@testable import BleKitCore

/// test-contracts/gatt-queue.json
private struct QueueContract: Decodable {
  let cases: [QueueContractCase]
}

private struct QueueContractCase: Decodable {
  let name: String
  let steps: [QueueContractStep]
}

private struct QueueContractStep: Decodable {
  let enqueue: String?
  let timeoutMs: Double?
  let first: Bool?
  let thenFirst: String?
  let complete: String?
  let error: String?
  let cancel: String?
  let failAll: String?
  let advance: Double?
  let expect: QueueContractExpectation?
}

private struct QueueContractExpectation: Decodable {
  let started: [String]?
  let results: [String: String?]?
  let depth: Int?
}

/// The shared GATT queue contract (test-contracts/gatt-queue.json): the Kotlin queue and the fake
/// adapter's TypeScript queue run the same cases.
final class GattQueueContractTests: XCTestCase {
  func testEveryContractCasePasses() throws {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("../../test-contracts/gatt-queue.json")
    let contract = try JSONDecoder().decode(QueueContract.self, from: Data(contentsOf: url))
    XCTAssertFalse(contract.cases.isEmpty)
    for contractCase in contract.cases {
      try run(contractCase)
    }
  }

  /// One case's queue, and what the harness saw of it.
  private final class Run {
    let scheduler = TestScheduler()
    lazy var queue = GattQueue(scheduler: scheduler)
    var operations: [String: GattOperation] = [:]
    var started: [String] = []
    var results: [String: String] = [:]
  }

  private func run(_ contractCase: QueueContractCase) throws {
    let run = Run()
    for step in contractCase.steps {
      try apply(step, to: run)
      run.scheduler.runUntilIdle()
      if let expectation = step.expect {
        check(expectation, in: run, caseName: contractCase.name)
      }
    }
  }

  private func enqueue(_ name: String, timeout: TimeInterval?, first: Bool, thenFirst: String?, in run: Run) {
    run.operations[name] = run.queue.enqueue(
      .read,
      target: name,
      timeout: timeout,
      first: first,
      start: { run.started.append(name) },
      completion: { [unowned self] result in
        switch result {
        case .success:
          run.results[name] = "ok"
          if let next = thenFirst {
            enqueue(next, timeout: nil, first: true, thenFirst: nil, in: run)
          }
        case let .failure(error):
          run.results[name] = error.code.rawValue
        }
      }
    )
  }

  private func apply(_ step: QueueContractStep, to run: Run) throws {
    if let name = step.enqueue {
      let timeout = step.timeoutMs.map { $0 / 1000 }
      enqueue(name, timeout: timeout, first: step.first ?? false, thenFirst: step.thenFirst, in: run)
    } else if let name = step.complete {
      let result: Result<GattOperation.Output, CoreError> = try step.error
        .map { .failure(CoreError(try code($0), "from the radio")) } ?? .success(.none)
      run.queue.complete(result) { $0.target == name }
    } else if let name = step.cancel, let operation = run.operations[name] {
      run.queue.cancel(operation)
    } else if let failure = step.failAll {
      run.queue.failAll(CoreError(try code(failure), "failed"))
    } else if let milliseconds = step.advance {
      run.scheduler.advance(by: milliseconds / 1000)
    }
  }

  private func check(_ expectation: QueueContractExpectation, in run: Run, caseName: String) {
    if let expected = expectation.started {
      XCTAssertEqual(run.started, expected, "\(caseName): started")
    }
    for (name, value) in expectation.results ?? [:] {
      XCTAssertEqual(run.results[name], value, "\(caseName): result of \(name)")
    }
    if let depth = expectation.depth {
      XCTAssertEqual(run.queue.depth, depth, "\(caseName): depth")
    }
  }

  private func code(_ name: String) throws -> CoreError.Code {
    try XCTUnwrap(CoreError.Code(rawValue: name), "unknown code \(name)")
  }
}
