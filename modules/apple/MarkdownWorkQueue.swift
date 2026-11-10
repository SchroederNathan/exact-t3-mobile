import Foundation
import os

final class MarkdownWorkQueue<Key: Hashable & Sendable, Value: Sendable>: Sendable {
  private struct Job: Sendable {
    let work: @Sendable () -> Value
    var replies: [@Sendable (Value) -> Void]
  }

  private struct State: Sendable {
    var pending: [Key: Job] = [:]
    var waiting: [Key] = []
    var running = false
  }

  private let state = OSAllocatedUnfairLock(initialState: State())
  private let worker = DispatchQueue(label: "com.exact.t3code.markdown-work", qos: .userInitiated)

  func submit(_ key: Key, work: @escaping @Sendable () -> Value,
              reply: @escaping @Sendable (Value) -> Void) {
    let start: Job? = state.withLock { state in
      if state.pending[key] != nil {
        state.pending[key]!.replies.append(reply)
        return nil
      }
      let job = Job(work: work, replies: [reply])
      state.pending[key] = job
      if state.running {
        state.waiting.append(key)
        return nil
      }
      state.running = true
      return job
    }
    if let start { perform(key, job: start) }
  }

  private func perform(_ key: Key, job: Job) {
    worker.async { [self] in
      let value = job.work()
      let (completed, next): ([@Sendable (Value) -> Void], (Key, Job)?) = state.withLock { state in
        let completed = state.pending.removeValue(forKey: key)!
        if state.waiting.isEmpty {
          state.running = false
          return (completed.replies, nil)
        }
        let key = state.waiting.removeFirst()
        return (completed.replies, (key, state.pending[key]!))
      }
      completed.forEach { $0(value) }
      if let (key, job) = next { perform(key, job: job) }
    }
  }
}
