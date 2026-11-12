import UIKit

final class WorkingIslandInstance: ExactNativeInstance {
  private let island = WorkingIslandView()

  init(props: [String: String], events: ExactNativeEvents) {
    super.init(events: events)
    island.onSize = { events.intrinsicSize($0) }
    island.onAction = { events.message($0) }
    island.apply(props)
  }

  override var view: ExactNativeView { island }

  override func setProps(_ props: [String: String]) throws { island.apply(props) }
}

private final class WorkingIslandView: UIView {
  var onSize: ((CGSize) -> Void)?
  var onAction: ((String) -> Void)?
  private let container = UIVisualEffectView()
  private let capsule = UIVisualEffectView()
  private let arrow = UIVisualEffectView()
  private let statusButton = UIButton(type: .custom)
  private let actionButton = UIButton(type: .custom)
  private let actionDivider = UIView()
  private let arrowButton = UIButton(type: .custom)
  private let label = UILabel()
  private let symbol = UIImageView()
  private let dot = UIView()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private var statusKind = ""
  private var indicator = ""
  private var statusAction = "none"
  private var reconnect = false
  private var showArrow = false
  private var animateLayout = false
  private var installedEffects = false
  private var arrowPressedOnTouchDown = false
  private var measuredSize = CGSize(width: 1, height: 38.5)
  private var capsuleWidth: CGFloat = 0
  private var actionWidth: CGFloat = 0
  private var controlHeight: CGFloat = 38.5
  private let gap: CGFloat = 14
  private var hasStatus: Bool { !(label.text ?? "").isEmpty }
  private var hasAction: Bool {
    hasStatus && statusAction != "none" && statusAction != "reconnect" && !(actionButton.currentTitle ?? "").isEmpty
  }
  private var hasGlass: Bool {
    if #available(iOS 26.0, *) { return NSClassFromString("UIGlassContainerEffect") != nil }
    return false
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isAccessibilityElement = false
    addSubview(container)
    for glass in [capsule, arrow] {
      glass.clipsToBounds = true
      glass.layer.cornerCurve = .circular
      container.contentView.addSubview(glass)
    }
    capsule.contentView.addSubview(statusButton)
    capsule.contentView.addSubview(actionDivider)
    capsule.contentView.addSubview(actionButton)
    arrow.contentView.addSubview(arrowButton)
    for view in [label, symbol, dot, spinner] {
      view.isUserInteractionEnabled = false
      view.isAccessibilityElement = false
      statusButton.addSubview(view)
    }
    label.numberOfLines = 1
    label.lineBreakMode = .byTruncatingTail
    symbol.contentMode = .scaleAspectFit
    dot.backgroundColor = .systemRed
    spinner.color = .secondaryLabel
    statusButton.accessibilityIdentifier = "thread-status-pill"
    statusButton.addTarget(self, action: #selector(reconnectPressed), for: .touchUpInside)
    actionDivider.isUserInteractionEnabled = false
    actionDivider.isAccessibilityElement = false
    actionButton.titleLabel?.numberOfLines = 1
    actionButton.titleLabel?.lineBreakMode = .byTruncatingTail
    actionButton.accessibilityIdentifier = "thread-status-action"
    actionButton.addTarget(self, action: #selector(statusActionPressed), for: .touchUpInside)
    actionButton.addTarget(self, action: #selector(actionTouchDown), for: .touchDown)
    actionButton.addTarget(self, action: #selector(actionTouchEnded), for: [.touchUpInside, .touchCancel, .touchUpOutside])
    arrowButton.setImage(UIImage(systemName: "chevron.down"), for: .normal)
    arrowButton.accessibilityLabel = "Scroll to end"
    arrowButton.accessibilityIdentifier = "scroll-to-bottom"
    arrowButton.addTarget(self, action: #selector(scrollTouchDown), for: .touchDown)
    arrowButton.addTarget(self, action: #selector(scrollActivated), for: .primaryActionTriggered)
    arrowButton.addTarget(self, action: #selector(scrollCancelled), for: [.touchCancel, .touchUpOutside])
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (view: WorkingIslandView, _: UITraitCollection) in
      view.updateTypography()
      view.updateSize()
    }
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: WorkingIslandView, _: UITraitCollection) in
      view.installedEffects = false
      view.setNeedsLayout()
    }
    updateTypography()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  override var intrinsicContentSize: CGSize { measuredSize }

  func apply(_ props: [String: String]) {
    let oldHasStatus = hasStatus
    let oldShowArrow = showArrow
    label.text = props["status-label"] ?? ""
    statusKind = props["status-kind"] ?? ""
    indicator = props["indicator"] ?? "none"
    statusAction = props["status-action"] ?? (props["reconnect"] == "true" ? "reconnect" : "none")
    reconnect = statusAction == "reconnect"
    actionButton.setTitle(props["action-label"] ?? "", for: .normal)
    actionButton.isEnabled = props["action-pending"] != "true" && props["action-disabled"] != "true"
    actionButton.alpha = actionButton.isEnabled ? 1 : 0.5
    actionButton.isHidden = !hasAction
    actionButton.isAccessibilityElement = hasAction
    actionButton.accessibilityLabel = props["action-accessibility-label"] ?? actionButton.currentTitle
    actionDivider.isHidden = !hasAction
    showArrow = props["show-arrow"] == "true"
    let symbolName = props["status-symbol"] ?? ""
    symbol.image = symbolName.isEmpty ? nil : UIImage(systemName: symbolName)
    symbol.isHidden = symbol.image == nil || indicator != "none"
    dot.isHidden = indicator != "unavailable"
    indicator == "spinner" && hasStatus ? spinner.startAnimating() : spinner.stopAnimating()
    statusButton.isUserInteractionEnabled = reconnect
    statusButton.isAccessibilityElement = hasStatus
    statusButton.accessibilityLabel = label.text
    statusButton.accessibilityTraits = reconnect ? .button : .staticText
    statusButton.accessibilityHint = reconnect ? "Reconnects to this environment" : nil
    arrowButton.isUserInteractionEnabled = showArrow
    if !showArrow { arrowPressedOnTouchDown = false }
    arrowButton.isAccessibilityElement = showArrow
    arrow.accessibilityElementsHidden = !showArrow
    capsule.accessibilityElementsHidden = !hasStatus
    animateLayout = animateLayout || oldShowArrow != showArrow || oldHasStatus != hasStatus
    updateTypography()
    updateSize()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    installedEffects = false
    setNeedsLayout()
  }

  private func updateTypography() {
    let base = statusKind == "working"
      ? UIFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium)
      : UIFont(name: "DMSans-Medium", size: 13) ?? UIFont.systemFont(ofSize: 13, weight: .medium)
    label.font = UIFontMetrics(forTextStyle: .caption1).scaledFont(for: base, compatibleWith: traitCollection)
    label.textColor = .label
    let actionBase = UIFont(name: "DMSans-Medium", size: 13) ?? UIFont.systemFont(ofSize: 13, weight: .medium)
    actionButton.titleLabel?.font = UIFontMetrics(forTextStyle: .caption1).scaledFont(for: actionBase, compatibleWith: traitCollection)
    actionButton.setTitleColor(.label, for: .normal)
    actionDivider.backgroundColor = UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(white: 25.0 / 255, alpha: 1)
        : UIColor(red: 228.0 / 255, green: 228.0 / 255, blue: 231.0 / 255, alpha: 1)
    }
    symbol.tintColor = statusKind == "stop" ? .systemOrange : .label
    symbol.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: label.font.pointSize)
    arrowButton.tintColor = .label
    arrowButton.setPreferredSymbolConfiguration(UIImage.SymbolConfiguration(pointSize: 14, weight: .medium), forImageIn: .normal)
  }

  private func updateSize() {
    let leadingWidth: CGFloat = indicator == "spinner" ? 20 : indicator == "unavailable" ? 8 : symbol.image != nil ? 13 : 0
    controlHeight = max(38.5, ceil(label.font.lineHeight + 16))
    actionWidth = hasAction ? ceil((actionButton.titleLabel?.intrinsicContentSize.width ?? 0) + 21) + 1 : 0
    let width = hasStatus ? ceil(min(260, label.intrinsicContentSize.width) + 28 + (leadingWidth > 0 ? leadingWidth + 7 : 0)) + actionWidth : 0
    animateLayout = animateLayout || abs(capsuleWidth - width) > 0.5
    capsuleWidth = width
    let size = CGSize(width: max(1, width + (showArrow ? controlHeight + (hasStatus ? gap : 0) : 0)), height: controlHeight)
    if size != measuredSize {
      measuredSize = size
      invalidateIntrinsicContentSize()
      onSize?(size)
    }
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let animated = animateLayout && window != nil && installedEffects && !UIAccessibility.isReduceMotionEnabled
    animateLayout = false
    container.frame = bounds
    let height = min(controlHeight, bounds.height)
    let arrowWidth = showArrow ? height : 0
    let separation = showArrow && hasStatus ? gap : 0
    let statusWidth = hasStatus ? min(capsuleWidth, max(0, bounds.width - arrowWidth - separation)) : 0
    let totalWidth = statusWidth + separation + arrowWidth
    let x = (bounds.width - totalWidth) / 2
    let y = (bounds.height - height) / 2
    let statusFrame = CGRect(x: x, y: y, width: statusWidth, height: height)
    let arrowX = showArrow ? x + statusWidth + separation : statusFrame.maxX - height
    let arrowFrame = CGRect(x: arrowX, y: y, width: height, height: height)
    if !installedEffects {
      if #available(iOS 26.0, *), hasGlass {
        let effect = UIGlassContainerEffect()
        // The lenses stay separate at rest and begin blending as the arrow
        // folds into the status capsule.
        effect.spacing = 12
        container.effect = effect
      }
      capsule.frame = statusFrame
      arrow.frame = arrowFrame
    }
    if hasStatus { capsule.isHidden = false }
    if showArrow { arrow.isHidden = false }
    let changes = {
      self.capsule.frame = statusFrame
      self.arrow.frame = arrowFrame
      self.capsule.alpha = self.hasStatus ? 1 : 0
      self.arrowButton.alpha = self.showArrow ? 1 : 0
      self.configureGlass(self.capsule, visible: self.hasStatus, interactive: self.reconnect || self.hasAction, radius: height / 2)
      // Keep the arrow's glass lens alive while it folds into the status
      // capsule. Only the chevron fades; the shared container then blends the
      // two lenses into one continuous island before the arrow view is hidden.
      self.configureGlass(self.arrow, visible: self.showArrow || self.hasStatus, interactive: true, radius: height / 2)
      self.layoutContent()
    }
    installedEffects = true
    if animated {
      UIView.animate(withDuration: 0.24, delay: 0, options: [.beginFromCurrentState, .curveEaseOut, .allowUserInteraction], animations: changes) { finished in
        if finished { self.finishVisibility() }
      }
    } else {
      UIView.performWithoutAnimation(changes)
      finishVisibility()
    }
  }

  private func configureGlass(_ view: UIVisualEffectView, visible: Bool, interactive: Bool, radius: CGFloat) {
    view.layer.cornerRadius = radius
    if #available(iOS 26.0, *), hasGlass {
      view.cornerConfiguration = .corners(radius: .fixed(Double(radius)))
      let effect = UIGlassEffect(style: .regular)
      effect.isInteractive = interactive
      view.effect = visible ? effect : nil
    } else {
      let dark = traitCollection.userInterfaceStyle == .dark
      view.backgroundColor = visible ? (dark ? UIColor(white: 0.1, alpha: 0.9) : UIColor(white: 0.96, alpha: 0.94)) : .clear
      view.layer.borderWidth = visible ? 1 : 0
      view.layer.borderColor = UIColor.separator.withAlphaComponent(0.3).cgColor
    }
  }

  private func layoutContent() {
    let actionSegmentWidth = min(actionWidth, max(0, capsule.bounds.width - 28))
    let statusWidth = capsule.bounds.width - actionSegmentWidth
    statusButton.frame = CGRect(x: 0, y: 0, width: statusWidth, height: capsule.bounds.height)
    arrowButton.frame = arrow.bounds
    let h = capsule.bounds.height
    actionDivider.frame = CGRect(x: statusWidth, y: (h - 14) / 2, width: 1, height: 14)
    actionButton.frame = CGRect(x: statusWidth + 1, y: 0, width: max(0, actionSegmentWidth - 1), height: h)
    let size: CGFloat = indicator == "spinner" ? 20 : indicator == "unavailable" ? 8 : 13
    let hasLeading = indicator != "none" || symbol.image != nil
    let leading = CGRect(x: 14, y: (h - size) / 2, width: size, height: size)
    symbol.frame = leading
    spinner.frame = leading
    dot.frame = leading
    dot.layer.cornerRadius = size / 2
    let x: CGFloat = hasLeading ? leading.maxX + 7 : 14
    label.frame = CGRect(x: x, y: 0, width: max(0, statusWidth - x - 14), height: h)
  }

  private func finishVisibility() {
    capsule.isHidden = !hasStatus
    arrow.isHidden = !showArrow
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard isUserInteractionEnabled, !isHidden, alpha > 0.01 else { return nil }
    if showArrow, arrow.frame.contains(point) { return arrowButton }
    if hasAction, capsule.frame.contains(point), actionButton.bounds.contains(actionButton.convert(point, from: self)) {
      return actionButton
    }
    if hasStatus, reconnect, capsule.frame.contains(point) { return statusButton }
    return nil
  }

  @objc private func reconnectPressed() {
    if reconnect { onAction?("reconnect") }
  }

  @objc private func statusActionPressed() {
    if hasAction, actionButton.isEnabled { onAction?(statusAction) }
  }

  @objc private func actionTouchDown() {
    if actionButton.isEnabled { actionButton.alpha = 0.7 }
  }

  @objc private func actionTouchEnded() {
    actionButton.alpha = actionButton.isEnabled ? 1 : 0.5
  }

  @objc private func scrollTouchDown() {
    arrowPressedOnTouchDown = true
    if showArrow { onAction?("scroll") }
  }

  @objc private func scrollActivated() {
    defer { arrowPressedOnTouchDown = false }
    if showArrow && !arrowPressedOnTouchDown { onAction?("scroll") }
  }

  @objc private func scrollCancelled() { arrowPressedOnTouchDown = false }
}
