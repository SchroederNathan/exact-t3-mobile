import Foundation
import os

private final class Events: Sendable {
  private let values = OSAllocatedUnfairLock(initialState: [String]())

  func add(_ value: String) {
    values.withLock { $0.append(value) }
  }

  func expect(_ expected: [String]) {
    let actual = values.withLock { $0.sorted() }
    precondition(actual == expected.sorted(), "Expected \(expected.sorted()), received \(actual)")
  }
}

@main
private enum WorkQueueTests {
  static func main() {
    coalescedReplies()
    queuedRequests()
    concurrentSubmitters()
    print("PASS: coalesced native replies, all queued requests complete, fresh work after completion, and concurrent submitters")
  }

  private static func coalescedReplies() {
    let queue = MarkdownWorkQueue<String, Int>()
    let release = DispatchSemaphore(value: 0), started = DispatchSemaphore(value: 0)
    let done = DispatchGroup(), events = Events()
    done.enter()
    queue.submit("same", work: {
      events.add("work:first")
      started.signal()
      release.wait()
      return 7
    }, reply: { value in events.add("first:\(value)"); done.leave() })
    started.wait()
    done.enter()
    queue.submit("same", work: { events.add("work:duplicate"); return 8 },
                 reply: { value in events.add("duplicate:\(value)"); done.leave() })
    done.enter()
    queue.submit("next", work: { events.add("work:next"); return 9 },
                 reply: { value in events.add("next:\(value)"); done.leave() })
    release.signal()
    done.wait()
    done.enter()
    queue.submit("same", work: { 10 },
                 reply: { value in events.add("recovered:\(value)"); done.leave() })
    done.wait()
    events.expect(["work:first", "work:next", "first:7", "duplicate:7", "next:9", "recovered:10"])
  }

  private static func queuedRequests() {
    let queue = MarkdownWorkQueue<Int, Int>()
    let release = DispatchSemaphore(value: 0), started = DispatchSemaphore(value: 0)
    let done = DispatchGroup(), events = Events()
    done.enter()
    queue.submit(-1, work: { started.signal(); release.wait(); return -1 },
                 reply: { value in events.add("reply:\(value)"); done.leave() })
    started.wait()
    for value in 0..<256 {
      done.enter()
      queue.submit(value, work: { value },
                   reply: { value in events.add("reply:\(value)"); done.leave() })
    }
    release.signal()
    done.wait()
    events.expect((-1..<256).map { "reply:\($0)" })
  }

  private static func concurrentSubmitters() {
    let queue = MarkdownWorkQueue<String, Int>()
    let release = DispatchSemaphore(value: 0), started = DispatchSemaphore(value: 0)
    let submitted = DispatchGroup(), completed = DispatchGroup(), events = Events()
    completed.enter()
    queue.submit("shared", work: {
      events.add("work")
      started.signal()
      release.wait()
      return 11
    }, reply: { value in events.add("reply:\(value)"); completed.leave() })
    started.wait()
    for _ in 0..<31 {
      submitted.enter()
      completed.enter()
      DispatchQueue.global().async {
        queue.submit("shared", work: { events.add("unexpected work"); return 12 },
                     reply: { value in events.add("reply:\(value)"); completed.leave() })
        submitted.leave()
      }
    }
    submitted.wait()
    release.signal()
    completed.wait()
    events.expect(["work"] + Array(repeating: "reply:11", count: 32))
  }
}
