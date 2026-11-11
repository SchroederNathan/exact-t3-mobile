import UIKit

final class ToolLabelInstance: ExactNativeInstance {
  private let label = ToolLabelView()

  init(props: [String: String], events: ExactNativeEvents) {
    super.init(events: events)
    label.onSize = { events.intrinsicSize($0) }
    apply(props)
  }

  override var view: ExactNativeView { label }

  override func setProps(_ props: [String: String]) throws { apply(props) }

  override func destroy() { label.dispose() }

  private func apply(_ props: [String: String]) {
    label.apply(text: props["tool-label"] ?? "", live: props["live"] == "true")
  }
}

private final class ToolLabelView: UIView {
  var onSize: ((CGSize) -> Void)?
  private let label = UILabel()
  private let maskLabel = UILabel()
  private let highlight = UIView()
  private let gradient = CAGradientLayer()
  private var scrollObservers: [NSKeyValueObservation] = []
  private var timer: Timer?
  private var disposed = false
  private var live = false
  private var step = 0
  private var measuredSize = CGSize.zero
  private let bandWidth: CGFloat = 72
  private let stepDuration: TimeInterval = 1.35 / 12

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    clipsToBounds = true
    for text in [label, maskLabel] {
      text.numberOfLines = 1
      text.lineBreakMode = .byTruncatingTail
      text.isAccessibilityElement = false
    }
    maskLabel.textColor = .white
    addSubview(label)
    addSubview(highlight)
    highlight.mask = maskLabel
    highlight.layer.addSublayer(gradient)
    gradient.startPoint = CGPoint(x: 0, y: 0.5)
    gradient.endPoint = CGPoint(x: 1, y: 0.5)
    gradient.locations = [0, 0.15, 0.35, 0.5, 0.65, 0.85, 1]
    gradient.isHidden = true
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (view: ToolLabelView, _: UITraitCollection) in
      view.updateTypography()
    }
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: ToolLabelView, _: UITraitCollection) in
      view.updateAppearance()
    }
    for name in [UIApplication.didBecomeActiveNotification, UIApplication.willResignActiveNotification,
                 UIAccessibility.reduceMotionStatusDidChangeNotification] {
      NotificationCenter.default.addObserver(self, selector: #selector(environmentChanged), name: name, object: nil)
    }
    updateTypography()
    updateAppearance()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  deinit {
    timer?.invalidate()
    NotificationCenter.default.removeObserver(self)
  }

  override var intrinsicContentSize: CGSize { measuredSize }

  override var isHidden: Bool { didSet { updateAnimation() } }
  override var alpha: CGFloat { didSet { updateAnimation() } }

  func apply(text: String, live: Bool) {
    if label.text != text {
      label.text = text
      maskLabel.text = text
      updateSize()
    }
    self.live = live
    updateAnimation()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    observeScrolling()
    updateAnimation()
  }

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    observeScrolling()
    updateAnimation()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = bounds
    highlight.frame = bounds
    maskLabel.frame = highlight.bounds
    positionBand()
    updateAnimation()
  }

  private func updateTypography() {
    let base = UIFont(name: "DMSans-Regular", size: 14) ?? UIFont.systemFont(ofSize: 14)
    let font = UIFontMetrics(forTextStyle: .body).scaledFont(for: base, compatibleWith: traitCollection)
    label.font = font
    maskLabel.font = font
    updateSize()
  }

  private func updateSize() {
    let size = CGSize(width: max(1, ceil(label.intrinsicContentSize.width)),
                      height: max(ceil(label.font.lineHeight), 19 * label.font.pointSize / 14))
    if size != measuredSize {
      measuredSize = size
      invalidateIntrinsicContentSize()
      onSize?(size)
    }
    setNeedsLayout()
  }

  private func updateAppearance() {
    let dark = traitCollection.userInterfaceStyle == .dark
    label.textColor = dark ? UIColor(white: 131 / 255, alpha: 1)
      : UIColor(red: 111 / 255, green: 111 / 255, blue: 121 / 255, alpha: 1)
    let foreground = dark ? UIColor(white: 245 / 255, alpha: 1)
      : UIColor(red: 39 / 255, green: 39 / 255, blue: 42 / 255, alpha: 1)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradient.colors = [CGFloat(0), 0.12, 0.55, 1, 0.55, 0.12, 0].map { foreground.withAlphaComponent($0).cgColor }
    CATransaction.commit()
  }

  private func observeScrolling() {
    scrollObservers.removeAll()
    guard window != nil, !disposed else { return }
    var ancestor = superview
    while let view = ancestor {
      if let scroll = view as? UIScrollView {
        scrollObservers.append(scroll.observe(\.bounds) { [weak self] _, _ in self?.updateAnimation() })
      }
      ancestor = view.superview
    }
  }

  private var shouldAnimate: Bool {
    guard !disposed, live, !(label.text ?? "").isEmpty, !UIAccessibility.isReduceMotionEnabled,
          UIApplication.shared.applicationState == .active,
          let window, window.windowScene?.activationState == .foregroundActive,
          bounds.width > 0, bounds.height > 0 else { return false }
    var visible = convert(bounds, to: window).intersection(window.bounds)
    var ancestor: UIView? = self
    while let view = ancestor {
      if view.isHidden || view.alpha <= 0 { return false }
      if view.clipsToBounds { visible = visible.intersection(view.convert(view.bounds, to: window)) }
      ancestor = view.superview
    }
    return !visible.isNull && !visible.isEmpty
  }

  @objc private func environmentChanged(_ notification: Notification) {
    if notification.name == UIApplication.willResignActiveNotification { stop() }
    else { updateAnimation() }
  }

  private func updateAnimation() {
    guard shouldAnimate else { stop(); return }
    guard timer == nil else { return }
    step = 0
    gradient.isHidden = false
    positionBand()
    schedule(after: stepDuration)
  }

  private func schedule(after delay: TimeInterval) {
    let next = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
      guard let self else { return }
      self.timer = nil
      guard self.shouldAnimate else { self.stop(); return }
      self.step = self.step % 12 + 1
      self.positionBand()
      self.schedule(after: self.step == 12 ? 1.45 + self.stepDuration : self.stepDuration)
    }
    timer = next
    RunLoop.main.add(next, forMode: .common)
  }

  private func positionBand() {
    let width = min(bounds.width, measuredSize.width)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradient.frame = CGRect(x: -bandWidth + (width + bandWidth) * CGFloat(step) / 12,
                            y: 0, width: bandWidth, height: bounds.height)
    CATransaction.commit()
  }

  private func stop() {
    timer?.invalidate()
    timer = nil
    gradient.isHidden = true
  }

  func dispose() {
    disposed = true
    stop()
    scrollObservers.removeAll()
    NotificationCenter.default.removeObserver(self)
    onSize = nil
  }
}
