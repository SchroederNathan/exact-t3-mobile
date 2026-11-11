import UIKit

final class ComposerMetricsInstance: ExactNativeInstance {
  private let probe = ComposerMetricsView()

  init(props: [String: String], events: ExactNativeEvents) {
    super.init(events: events)
    probe.onBottomOffsetChange = { events.message(String(Double($0))) }
  }

  override var view: ExactNativeView { probe }
}

/// Reports how far the composer moves to meet a vertical bar's bottom edge. It draws nothing.
private final class ComposerMetricsView: UIView {
  private var hasHinge = false
  private var bottomOffset: CGFloat?
  var onBottomOffsetChange: ((CGFloat) -> Void)?

  init() {
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      addInteraction(UIHingeInteraction { [weak self] _, update in
        guard let self, update.hinge != nil, !self.hasHinge else { return }
        self.hasHinge = true
        self.setNeedsLayout()
      })
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) { (view: ComposerMetricsView, _: UITraitCollection) in
        view.setNeedsLayout()
      }
    }
    #endif
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { setNeedsLayout() }
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    reportBottomOffset()
  }

  private func reportBottomOffset() {
    guard window != nil else { return }
    var offset: CGFloat = 0
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      let hasVerticalBar = traitCollection.verticalBarEdge != .unspecified
        || (window?.traitCollection.verticalBarEdge ?? .unspecified) != .unspecified
      var responder: UIResponder? = next
      while let current = responder, !(current is UIViewController) { responder = current.next }
      if hasHinge || hasVerticalBar, let root = (responder as? UIViewController)?.viewIfLoaded {
        let barInset = root.edgeInsets(for: .bar(onEdge: UIRectEdge.bottom, extent: 48)).bottom
        if barInset > 0 {
          // Expo aligns the pill to the native bar edge, replacing its ordinary safe area and 6pt gutter.
          offset = max(0, barInset - 6) - root.safeAreaInsets.bottom
        }
      }
    }
    #endif
    guard bottomOffset != offset else { return }
    bottomOffset = offset
    onBottomOffsetChange?(offset)
  }
}
