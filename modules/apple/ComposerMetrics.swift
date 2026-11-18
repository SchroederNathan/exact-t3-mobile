import UIKit

final class ComposerMetricsInstance: ExactNativeInstance {
  private let probe = ComposerMetricsView()

  init(props: [String: String], events: ExactNativeEvents) {
    super.init(events: events)
    probe.onBottomOffsetChange = { events.message(String(Double($0))) }
  }

  override var view: ExactNativeView { probe }
}

/// Reports the composer's native bar alignment and docked-keyboard offset.
private final class ComposerMetricsView: UIView {
  private var hasHinge = false
  private var bottomOffset: CGFloat?
  private var dockedKeyboard: Bool?
  private var keyboardObservers: [NSObjectProtocol] = []
  var onBottomOffsetChange: ((CGFloat) -> Void)?

  init() {
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    keyboardObservers.append(NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] notification in
      guard let self, let window = self.window,
            let value = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue else { return }
      let frame = window.convert(value.cgRectValue, from: window.screen.coordinateSpace)
      let overlap = frame.intersection(window.bounds)
      self.dockedKeyboard = !overlap.isNull && overlap.height > 100 && overlap.width >= window.bounds.width * 0.8 && frame.maxY >= window.bounds.maxY - 1
      self.reportBottomOffset()
    })
    keyboardObservers.append(NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
      self?.dockedKeyboard = false
      self?.reportBottomOffset()
    })
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
  deinit { keyboardObservers.forEach(NotificationCenter.default.removeObserver) }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    dockedKeyboard = nil
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
    guard let window else { return }
    var offset: CGFloat = 0
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      let hasVerticalBar = traitCollection.verticalBarEdge != .unspecified
        || window.traitCollection.verticalBarEdge != .unspecified
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
    // The reference sticky host cancels its bottom inset and adds an 8pt
    // opened-keyboard offset; its 6pt pill gutter therefore overlaps by 2pt.
    let softwareKeyboard = dockedKeyboard ?? (window.keyboardLayoutGuide.layoutFrame.height > max(100, window.safeAreaInsets.bottom + 80))
    if softwareKeyboard { offset = -8 }
    guard bottomOffset != offset else { return }
    bottomOffset = offset
    onBottomOffsetChange?(offset)
  }
}
