import Foundation

struct ThreadScrollGeometry: Equatable {
  let contentHeight: Double
  let viewportHeight: Double
  let scrollOffset: Double
  let viewportWidth: Double
  let userScrolling: Bool

  var isAtEnd: Bool { viewportHeight > 0 && contentHeight - viewportHeight - scrollOffset <= 1 }
}

struct ThreadScrollProbe {
  enum Result { case pending, settled, exhausted, inactive }

  private(set) var generation: UInt64 = 0
  private var remaining = 0
  private var quietFrames = 0
  private var previous: ThreadScrollGeometry?

  mutating func restart() {
    generation &+= 1
    remaining = 8
    quietFrames = 0
    previous = nil
  }

  mutating func cancel() {
    generation &+= 1
    remaining = 0
    previous = nil
  }

  mutating func sample(_ geometry: ThreadScrollGeometry, generation: UInt64, touching: Bool) -> Result {
    guard generation == self.generation, remaining > 0 else { return .inactive }
    remaining -= 1
    quietFrames = !touching && !geometry.userScrolling && geometry.viewportHeight > 0 && geometry == previous
      ? quietFrames + 1 : 0
    previous = geometry
    if quietFrames >= 2 {
      remaining = 0
      return .settled
    }
    return remaining == 0 ? .exhausted : .pending
  }
}

#if canImport(UIKit)
import UIKit

final class ThreadScrollObserverInstance: ExactNativeInstance {
  private let observer: ThreadScrollObserverView

  init(props: [String: String], events: ExactNativeEvents) {
    observer = MainActor.assumeIsolated { ThreadScrollObserverView() }
    super.init(events: events)
    MainActor.assumeIsolated {
      observer.onMessage = { events.message($0) }
      observer.apply(props)
    }
  }

  override var view: ExactNativeView { observer }

  override func setProps(_ props: [String: String]) throws {
    MainActor.assumeIsolated { observer.apply(props) }
  }

  override func destroy() {
    MainActor.assumeIsolated { observer.dispose() }
  }
}

@MainActor private final class ThreadScrollFrameTarget: NSObject {
  weak var observer: ThreadScrollObserverView?

  @objc func frame() { observer?.sampleFrame() }
}

private final class ThreadScrollObserverView: UIView {
  var onMessage: ((String) -> Void)?
  private weak var scroll: UIScrollView?
  private var observations: [NSKeyValueObservation] = []
  private var targetID = ""
  private var observationKey = ""
  private var probe = ThreadScrollProbe()
  private var displayLink: CADisplayLink?
  private var queuedUpdate = false
  private var queuedMotion = false
  private var queueGeneration: UInt64 = 0
  private var disposed = false
  private var lastPayload = ""
  private var lastGeometry: ThreadScrollGeometry?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  isolated deinit { displayLink?.invalidate() }

  func apply(_ props: [String: String]) {
    let nextTarget = props["target-test-id"] ?? ""
    let nextKey = props["observation-key"] ?? ""
    guard nextTarget != targetID || nextKey != observationKey else { return }
    if nextTarget != targetID { detach() }
    targetID = nextTarget
    observationKey = nextKey
    lastPayload = ""
    changed()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { detach() }
    else { changed() }
  }

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    detach()
    if superview != nil { changed() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if scroll == nil { changed() }
  }

  private func changed(motion: Bool = false) {
    guard !disposed else { return }
    probe.restart()
    queuedMotion = queuedMotion || motion
    guard !queuedUpdate else { return }
    queuedUpdate = true
    let generation = queueGeneration
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.disposed, self.queueGeneration == generation else { return }
      self.queuedUpdate = false
      let cause = self.queuedMotion ? "motion" : "geometry"
      self.queuedMotion = false
      guard self.window != nil else { return }
      self.bindIfNeeded()
      guard let geometry = self.geometry() else { return }
      self.startFrames()
      self.publish(geometry, cause: cause, settled: false)
    }
  }

  private func bindIfNeeded() {
    guard scroll == nil, !targetID.isEmpty else { return }
    var ancestor = superview
    while let scope = ancestor, scope !== window {
      if let target = namedTarget(in: scope), let found = firstScroll(in: target) {
        scroll = found
        observations = [
          found.observe(\.contentSize) { [weak self] _, _ in MainActor.assumeIsolated { self?.changed() } },
          found.observe(\.bounds) { [weak self] _, _ in MainActor.assumeIsolated { self?.changed() } },
          found.observe(\.contentInset) { [weak self] _, _ in MainActor.assumeIsolated { self?.changed() } },
          found.observe(\.adjustedContentInset) { [weak self] _, _ in MainActor.assumeIsolated { self?.changed() } },
        ]
        found.panGestureRecognizer.addTarget(self, action: #selector(panChanged))
        return
      }
      ancestor = scope.superview
    }
  }

  private func namedTarget(in root: UIView) -> UIView? {
    if root.accessibilityIdentifier == targetID { return root }
    guard root !== self, !(root is UIScrollView), !root.isHidden else { return nil }
    for child in root.subviews {
      if let found = namedTarget(in: child) { return found }
    }
    return nil
  }

  private func firstScroll(in root: UIView) -> UIScrollView? {
    if let found = root as? UIScrollView { return found }
    for child in root.subviews {
      if let found = firstScroll(in: child) { return found }
    }
    return nil
  }

  @objc private func panChanged() { changed(motion: true) }

  private func geometry() -> ThreadScrollGeometry? {
    guard let scroll, scroll.window === window else { return nil }
    let inset = scroll.adjustedContentInset
    let viewport = max(0, scroll.bounds.height - inset.top - inset.bottom)
    let gesture = scroll.panGestureRecognizer.state
    return ThreadScrollGeometry(
      contentHeight: Double(scroll.contentSize.height),
      viewportHeight: Double(viewport),
      scrollOffset: Double(max(0, scroll.contentOffset.y + inset.top)),
      viewportWidth: Double(scroll.bounds.width),
      userScrolling: scroll.isDragging || scroll.isDecelerating || gesture == .began || gesture == .changed
    )
  }

  private func startFrames() {
    guard displayLink == nil else { return }
    let target = ThreadScrollFrameTarget()
    target.observer = self
    let link = CADisplayLink(target: target, selector: #selector(ThreadScrollFrameTarget.frame))
    displayLink = link
    link.add(to: .main, forMode: .common)
  }

  fileprivate func sampleFrame() {
    guard !disposed, window != nil, let geometry = geometry(), let scroll else { stopFrames(); return }
    let result = probe.sample(geometry, generation: probe.generation, touching: scroll.isTracking)
    switch result {
    case .pending:
      if geometry != lastGeometry {
        publish(geometry, cause: geometry.userScrolling != lastGeometry?.userScrolling ? "motion" : "geometry", settled: false)
      }
    case .settled:
      stopFrames()
      publish(geometry, cause: "settled", settled: true)
    case .exhausted, .inactive:
      stopFrames()
    }
  }

  private func publish(_ geometry: ThreadScrollGeometry, cause: String, settled: Bool) {
    guard !observationKey.contains("\n") else { return }
    let payload = [
      observationKey, cause, String(geometry.contentHeight), String(geometry.viewportHeight),
      String(geometry.scrollOffset), String(geometry.userScrolling), String(settled), String(geometry.isAtEnd),
    ].joined(separator: "\n")
    guard payload != lastPayload else { return }
    lastPayload = payload
    lastGeometry = geometry
    onMessage?(payload)
  }

  private func stopFrames() {
    displayLink?.invalidate()
    displayLink = nil
  }

  private func detach() {
    queueGeneration &+= 1
    queuedUpdate = false
    queuedMotion = false
    probe.cancel()
    stopFrames()
    scroll?.panGestureRecognizer.removeTarget(self, action: #selector(panChanged))
    observations.removeAll()
    scroll = nil
  }

  func dispose() {
    disposed = true
    detach()
    onMessage = nil
  }
}
#endif
