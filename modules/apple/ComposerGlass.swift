import UIKit

final class ComposerGlassInstance: ExactNativeInstance {
  private let glass = ComposerGlassView()

  init(props: [String: String], events: ExactNativeEvents) {
    super.init(events: events)
    glass.onBottomOffsetChange = { events.message(String(Double($0))) }
    apply(props)
  }

  override var view: ExactNativeView { glass }

  override func setProps(_ props: [String: String]) throws {
    apply(props)
  }

  private func apply(_ props: [String: String]) {
    let radius = Double(props["radius"] ?? "27") ?? 27
    glass.radius = radius.isFinite ? max(0, radius) : 27
  }
}

private final class ComposerGlassView: UIView {
  private let effectView = UIVisualEffectView()
  private var hasHinge = false
  private var bottomOffset: CGFloat?
  var onBottomOffsetChange: ((CGFloat) -> Void)?
  var radius: CGFloat = 27 {
    didSet { if radius != oldValue { setNeedsLayout() } }
  }

  init() {
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    clipsToBounds = true
    layer.cornerCurve = .circular
    effectView.isUserInteractionEnabled = false
    effectView.layer.cornerCurve = .circular
    addSubview(effectView)
    updateFallback()
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: ComposerGlassView, _: UITraitCollection) in
      view.updateFallback()
    }
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      addInteraction(UIHingeInteraction { [weak self] _, update in
        guard let self, update.hinge != nil, !self.hasHinge else { return }
        self.hasHinge = true
        self.setNeedsLayout()
      })
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) { (view: ComposerGlassView, _: UITraitCollection) in
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
    layer.cornerRadius = radius
    effectView.frame = bounds
    if #available(iOS 26.0, *) {
      effectView.cornerConfiguration = .corners(radius: .fixed(Double(radius)))
      if effectView.effect == nil, window != nil, bounds.width > 0, bounds.height > 0 {
        let effect = UIGlassEffect(style: .regular)
        effect.tintColor = .clear
        effect.isInteractive = false
        effectView.effect = effect
      }
    }
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

  private func updateFallback() {
    if #available(iOS 26.0, *) { return }
    let dark = traitCollection.userInterfaceStyle == .dark
    backgroundColor = dark
      ? UIColor(red: 26 / 255, green: 27 / 255, blue: 27 / 255, alpha: 0.9)
      : UIColor(red: 244 / 255, green: 244 / 255, blue: 245 / 255, alpha: 0.94)
    layer.borderWidth = 1
    layer.borderColor = (dark
      ? UIColor(white: 25 / 255, alpha: 0.8)
      : UIColor(red: 228 / 255, green: 228 / 255, blue: 231 / 255, alpha: 0.8)).cgColor
  }
}
