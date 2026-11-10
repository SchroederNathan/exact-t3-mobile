import UIKit

func configureWorkspacePageTitle(_ item: UINavigationItem, bar: UINavigationBar?) {
  func appearance(_ base: UINavigationBarAppearance?, transparent: Bool = false) -> UINavigationBarAppearance {
    let result = base?.copy() as? UINavigationBarAppearance ?? UINavigationBarAppearance()
    if base == nil && transparent { result.configureWithTransparentBackground() }
    result.titleTextAttributes[.font] = UIFont.systemFont(ofSize: 18, weight: .heavy)
    return result
  }
  item.standardAppearance = appearance(item.standardAppearance ?? bar?.standardAppearance)
  item.compactAppearance = appearance(item.compactAppearance ?? bar?.compactAppearance ?? item.standardAppearance)
  item.scrollEdgeAppearance = appearance(item.scrollEdgeAppearance ?? bar?.scrollEdgeAppearance, transparent: true)
  item.compactScrollEdgeAppearance = appearance(item.compactScrollEdgeAppearance ?? bar?.compactScrollEdgeAppearance, transparent: true)
}

final class WorkspaceBrandTitleView: UIView {
  private let wordmark = WorkspaceWordmarkView()
  private let code = UILabel()
  private let badge = UIView()
  private let stage = UILabel()
  var preferredWidth: CGFloat = 242 {
    didSet { invalidateIntrinsicContentSize() }
  }
  var stageName = "DEV" {
    didSet { updateTypography() }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isAccessibilityElement = true
    accessibilityLabel = "T3 Code, Threads"
    accessibilityTraits = .header
    addSubview(wordmark)
    addSubview(code)
    addSubview(badge)
    badge.addSubview(stage)
    badge.backgroundColor = UIColor { $0.userInterfaceStyle == .dark
      ? UIColor(red: 17 / 255, green: 17 / 255, blue: 17 / 255, alpha: 1)
      : UIColor(red: 250 / 255, green: 250 / 255, blue: 250 / 255, alpha: 1) }
    updateTypography()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  override var intrinsicContentSize: CGSize { CGSize(width: preferredWidth, height: 32) }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory {
      updateTypography()
    }
  }

  private func updateTypography() {
    let scale = min(1.4, UIFontMetrics(forTextStyle: .body).scaledValue(for: 21) / 21)
    let muted = UIColor { $0.userInterfaceStyle == .dark
      ? UIColor(red: 131 / 255, green: 131 / 255, blue: 131 / 255, alpha: 1)
      : UIColor(red: 111 / 255, green: 111 / 255, blue: 121 / 255, alpha: 1) }
    code.attributedText = NSAttributedString(string: "Code", attributes: [
      .font: UIFont(name: "DMSans-Medium", size: 21 * scale) ?? UIFont.systemFont(ofSize: 21 * scale, weight: .medium),
      .kern: -0.5, .foregroundColor: muted,
    ])
    stage.attributedText = NSAttributedString(string: stageName.uppercased(), attributes: [
      .font: UIFont(name: "DMSans-Bold", size: 9 * scale) ?? UIFont.boldSystemFont(ofSize: 9 * scale),
      .kern: 0.9, .foregroundColor: muted,
    ])
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let gap: CGFloat = 5.25
    let logoSize = CGSize(width: 15 * 94.3941 / 56.96, height: 15)
    let codeSize = code.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 32))
    let stageSize = stage.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 32))
    let badgeSize = CGSize(width: stageSize.width + 10.5, height: stageSize.height + 3.5)
    wordmark.frame = CGRect(x: 0, y: (bounds.height - logoSize.height) / 2, width: logoSize.width, height: logoSize.height)
    code.frame = CGRect(x: wordmark.frame.maxX + gap, y: (bounds.height - codeSize.height) / 2, width: codeSize.width, height: codeSize.height)
    badge.frame = CGRect(x: code.frame.maxX + gap, y: (bounds.height - badgeSize.height) / 2, width: badgeSize.width, height: badgeSize.height)
    stage.frame = CGRect(x: 5.25, y: 1.75, width: stageSize.width, height: stageSize.height)
    badge.layer.cornerRadius = badgeSize.height / 2
    badge.isHidden = badge.frame.maxX > bounds.width
  }
}

private final class WorkspaceWordmarkView: UIView {
  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    contentMode = .redraw
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    setNeedsDisplay()
  }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    context.scaleBy(x: bounds.width / 94.3941, y: bounds.height / 56.96)
    context.translateBy(x: -15.5309, y: -37)
    let path = UIBezierPath()
    path.move(to: CGPoint(x: 33.4509, y: 93))
    path.addLine(to: CGPoint(x: 33.4509, y: 47.56))
    path.addLine(to: CGPoint(x: 15.5309, y: 47.56))
    path.addLine(to: CGPoint(x: 15.5309, y: 37))
    path.addLine(to: CGPoint(x: 64.3309, y: 37))
    path.addLine(to: CGPoint(x: 64.3309, y: 47.56))
    path.addLine(to: CGPoint(x: 46.4109, y: 47.56))
    path.addLine(to: CGPoint(x: 46.4109, y: 93))
    path.addLine(to: CGPoint(x: 33.4509, y: 93))
    path.close()
    path.move(to: CGPoint(x: 86.7253, y: 93.96))
    path.addCurve(to: CGPoint(x: 75.1253, y: 92.44), controlPoint1: CGPoint(x: 82.832, y: 93.96), controlPoint2: CGPoint(x: 78.9653, y: 93.4533))
    path.addCurve(to: CGPoint(x: 65.3653, y: 87.96), controlPoint1: CGPoint(x: 71.2853, y: 91.3733), controlPoint2: CGPoint(x: 68.032, y: 89.88))
    path.addLine(to: CGPoint(x: 70.4053, y: 78.04))
    path.addCurve(to: CGPoint(x: 77.8453, y: 81.72), controlPoint1: CGPoint(x: 72.5386, y: 79.5867), controlPoint2: CGPoint(x: 75.0186, y: 80.8133))
    path.addCurve(to: CGPoint(x: 86.4053, y: 83.08), controlPoint1: CGPoint(x: 80.672, y: 82.6267), controlPoint2: CGPoint(x: 83.5253, y: 83.08))
    path.addCurve(to: CGPoint(x: 94.0853, y: 81.16), controlPoint1: CGPoint(x: 89.6586, y: 83.08), controlPoint2: CGPoint(x: 92.2186, y: 82.44))
    path.addCurve(to: CGPoint(x: 96.8853, y: 75.88), controlPoint1: CGPoint(x: 95.952, y: 79.88), controlPoint2: CGPoint(x: 96.8853, y: 78.12))
    path.addCurve(to: CGPoint(x: 94.4053, y: 70.84), controlPoint1: CGPoint(x: 96.8853, y: 73.7467), controlPoint2: CGPoint(x: 96.0586, y: 72.0667))
    path.addCurve(to: CGPoint(x: 86.4053, y: 69), controlPoint1: CGPoint(x: 92.752, y: 69.6133), controlPoint2: CGPoint(x: 90.0853, y: 69))
    path.addLine(to: CGPoint(x: 80.4853, y: 69))
    path.addLine(to: CGPoint(x: 80.4853, y: 60.44))
    path.addLine(to: CGPoint(x: 96.0853, y: 42.76))
    path.addLine(to: CGPoint(x: 97.5253, y: 47.4))
    path.addLine(to: CGPoint(x: 68.1653, y: 47.4))
    path.addLine(to: CGPoint(x: 68.1653, y: 37))
    path.addLine(to: CGPoint(x: 107.365, y: 37))
    path.addLine(to: CGPoint(x: 107.365, y: 45.4))
    path.addLine(to: CGPoint(x: 91.8453, y: 63.08))
    path.addLine(to: CGPoint(x: 85.2853, y: 59.32))
    path.addLine(to: CGPoint(x: 89.0453, y: 59.32))
    path.addCurve(to: CGPoint(x: 104.645, y: 63.96), controlPoint1: CGPoint(x: 95.9253, y: 59.32), controlPoint2: CGPoint(x: 101.125, y: 60.8667))
    path.addCurve(to: CGPoint(x: 109.925, y: 75.88), controlPoint1: CGPoint(x: 108.165, y: 67.0533), controlPoint2: CGPoint(x: 109.925, y: 71.0267))
    path.addCurve(to: CGPoint(x: 107.445, y: 84.76), controlPoint1: CGPoint(x: 109.925, y: 79.0267), controlPoint2: CGPoint(x: 109.099, y: 81.9867))
    path.addCurve(to: CGPoint(x: 99.8453, y: 91.4), controlPoint1: CGPoint(x: 105.792, y: 87.48), controlPoint2: CGPoint(x: 103.259, y: 89.6933))
    path.addCurve(to: CGPoint(x: 86.7253, y: 93.96), controlPoint1: CGPoint(x: 96.432, y: 93.1067), controlPoint2: CGPoint(x: 92.0586, y: 93.96))
    path.close()
    (traitCollection.userInterfaceStyle == .dark
      ? UIColor(red: 245 / 255, green: 245 / 255, blue: 245 / 255, alpha: 1)
      : UIColor(red: 39 / 255, green: 39 / 255, blue: 42 / 255, alpha: 1)).setFill()
    path.fill()
  }
}
