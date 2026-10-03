import CoreBluetooth
import Foundation

// writeStream (P2-03): a payload larger than one packet, written in chunks through the queue.

extension PeripheralSession {
  typealias StreamProgress = (_ sent: Int, _ total: Int) -> Void

  /// writeStream reports progress about this many times.
  static let progressSteps = 100

  /// What a writeStream writes, and how.
  struct StreamRequest {
    var data: Data
    var withResponse = false
    /// Bytes per chunk; nil for one packet.
    var chunkSize: Int?
    /// Applies to each chunk.
    var timeout: TimeInterval?
    var operationId: Int?
  }

  /// One stream in flight: what to write, how far it got, and whom to tell.
  final class StreamRun {
    let request: StreamRequest
    let target: CharacteristicLike
    let chunkSize: Int
    let onProgress: StreamProgress
    let completion: WriteCompletion
    let progressStep: Int
    var reported = 0

    var total: Int { request.data.count }

    init(
      _ request: StreamRequest,
      target: CharacteristicLike,
      chunkSize: Int,
      onProgress: @escaping StreamProgress,
      completion: @escaping WriteCompletion
    ) {
      self.request = request
      self.target = target
      self.chunkSize = chunkSize
      self.onProgress = onProgress
      self.completion = completion
      progressStep = max(chunkSize, request.data.count / PeripheralSession.progressSteps)
    }
  }

  /// Writes `request.data` in chunks (plan §5.4): `chunkSize` bytes each, one packet
  /// (`maximumWriteValueLength(for: .withoutResponse)`) by default, every chunk one write through the
  /// queue with the flow control of §4.9. Each chunk queues the next one first, so operations issued
  /// later wait for the end of the stream. `onProgress` hears the bytes written about every 1 % and at
  /// the end. The timeout applies to each chunk; cancelling `operationId` stops the stream within the
  /// chunk in flight.
  func writeStream(
    _ path: AttributePath,
    _ request: StreamRequest,
    onProgress: @escaping StreamProgress,
    completion: @escaping WriteCompletion
  ) {
    let target: CharacteristicLike
    let size: Int
    do {
      target = try findCharacteristic(
        path,
        allowing: request.withResponse ? .write : .writeWithoutResponse,
        otherwise: .writeNotPermitted
      )
      let packet = peripheral.maximumWriteValueLength(for: .withoutResponse)
      let largest = request.withResponse ? Self.maxAttributeLength : packet
      size = request.chunkSize ?? packet
      guard (1...largest).contains(size) else {
        throw CoreError(.invalidArgument, "chunkSize \(size) is outside 1…\(largest) for this write type")
      }
    } catch {
      return completion(.failure(Self.coreError(error)))
    }
    guard !request.data.isEmpty else {
      return completion(.success(()))
    }
    var copy = request
    copy.data = Data(request.data)
    let run = StreamRun(copy, target: target, chunkSize: size, onProgress: onProgress, completion: completion)
    sendChunk(of: run, from: 0)
  }

  private func sendChunk(of run: StreamRun, from offset: Int) {
    let end = min(offset + run.chunkSize, run.total)
    let chunk = run.request.data.subdata(in: offset..<end)
    let withResponse = run.request.withResponse
    let kind: GattOperation.Kind = withResponse ? .write : .writeWithoutResponse
    let start: () -> Void = { [weak self] in
      self?.startWrite(chunk, to: run.target, withResponse: withResponse)
    }
    let finished: GattOperation.Completion = { [weak self] result in
      self?.chunkFinished(of: run, from: offset, to: end, result.map { _ in () })
    }
    let target = Self.key(run.target)
    let first = offset > 0
    let operation = queue.enqueue(
      kind, target: target, timeout: run.request.timeout, first: first, start: start, completion: finished
    )
    track(operation, run.request.operationId)
  }

  private func chunkFinished(of run: StreamRun, from offset: Int, to end: Int, _ result: Result<Void, CoreError>) {
    if case let .failure(error) = result {
      return run.completion(.failure(streamError(error, sent: offset, total: run.total)))
    }
    if end == run.total || end - run.reported >= run.progressStep {
      run.reported = end
      run.onProgress(end, run.total)
    }
    guard end < run.total else {
      return run.completion(.success(()))
    }
    guard state == .ready else {
      let error = CoreError(.disconnected, "Not connected")
      return run.completion(.failure(streamError(error, sent: end, total: run.total)))
    }
    sendChunk(of: run, from: end)
  }

  /// A chunk's error, saying how far the stream got.
  private func streamError(_ error: CoreError, sent: Int, total: Int) -> CoreError {
    CoreError(
      error.code,
      "\(error.message) (stream stopped after \(sent) of \(total) bytes)",
      retryable: error.retryable,
      nativeDomain: error.nativeDomain,
      nativeCode: error.nativeCode
    )
  }
}
