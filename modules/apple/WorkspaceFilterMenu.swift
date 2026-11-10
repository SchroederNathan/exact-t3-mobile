import UIKit

private struct WorkspaceFilterOption: Equatable {
  let id: String
  let title: String
}

final class WorkspaceFilterMenuInstance: ExactNativeInstance {
  private let button = WorkspaceFilterMenuButton(type: .custom)

  init(props: [String: String], events: ExactNativeEvents) throws {
    super.init(events: events)
    button.onSelection = { events.message($0) }
    button.onSize = { events.intrinsicSize($0) }
    try setProps(props)
  }

  override var view: ExactNativeView { button }

  override func setProps(_ props: [String: String]) throws {
    guard let query = URLComponents(string: "?" + (props["options-query"] ?? ""))?.queryItems else {
      throw ExactNativeRefusal("filter menu options must be an encoded query")
    }
    let options = query.map { WorkspaceFilterOption(id: $0.name, title: $0.value ?? "") }
    button.apply(props, options: options)
  }
}

private final class WorkspaceFilterMenuButton: UIButton {
  var onSelection: ((String) -> Void)?
  var onSize: ((CGSize) -> Void)?
  private let glass = UIVisualEffectView()
  private let label = UILabel()
  private let chevron = UIImageView(image: UIImage(systemName: "chevron.down"))
  private var options: [WorkspaceFilterOption] = []
  private var selectedID = ""
  private var menuTitle = ""
  private var active = false
  private var selectedFromMenu = false
  private var measuredSize = CGSize.zero
  private var lineHeight: CGFloat = 19

  override init(frame: CGRect) {
    super.init(frame: frame)
    showsMenuAsPrimaryAction = true
    glass.isUserInteractionEnabled = false
    glass.clipsToBounds = true
    glass.layer.cornerRadius = 16
    glass.layer.cornerCurve = .continuous
    addSubview(glass)
    label.numberOfLines = 1
    label.lineBreakMode = .byTruncatingTail
    label.isUserInteractionEnabled = false
    glass.contentView.addSubview(label)
    chevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 11)
    chevron.contentMode = .scaleAspectFit
    chevron.isUserInteractionEnabled = false
    glass.contentView.addSubview(chevron)
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (view: WorkspaceFilterMenuButton, _: UITraitCollection) in
      view.updateTypography()
    }
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: WorkspaceFilterMenuButton, _: UITraitCollection) in
      view.updateAppearance()
    }
    updateTypography()
    updateAppearance()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  func apply(_ props: [String: String], options nextOptions: [WorkspaceFilterOption]) {
    let nextSelectedID = props["selected-id"] ?? ""
    let nextMenuTitle = props["menu-title"] ?? ""
    if options != nextOptions || selectedID != nextSelectedID || menuTitle != nextMenuTitle || menu == nil {
      options = nextOptions
      selectedID = nextSelectedID
      menuTitle = nextMenuTitle
      menu = UIMenu(title: menuTitle, children: options.map { option in
        UIAction(title: option.title, state: option.id == selectedID ? .on : .off) { [weak self] _ in
          self?.selectedFromMenu = true
          self?.onSelection?(option.id)
        }
      })
    }
    label.text = props["chip-label"] ?? ""
    accessibilityLabel = props["accessibility-label"] ?? label.text
    accessibilityValue = label.text
    accessibilityIdentifier = props["test-id"]
    let nextActive = props["active"] == "true"
    if active != nextActive {
      active = nextActive
      updateAppearance()
    }
    accessibilityTraits = active ? [.button, .selected] : .button
    updateSize()
  }

  private func updateTypography() {
    let base = UIFont(name: "DMSans-Medium", size: 14) ?? UIFont.systemFont(ofSize: 14, weight: .medium)
    label.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: base, compatibleWith: traitCollection)
    lineHeight = 19 * label.font.pointSize / 14
    updateSize()
  }

  private func updateSize() {
    let textSize = label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude))
    let size = CGSize(width: min(180, ceil(textSize.width)) + 21 + 5.25 + 11,
                      height: max(28, max(lineHeight, textSize.height) + 10.5))
    if size != measuredSize {
      measuredSize = size
      invalidateIntrinsicContentSize()
      onSize?(size)
    }
    setNeedsLayout()
  }

  override var intrinsicContentSize: CGSize { measuredSize }

  private func updateAppearance() {
    let dark = traitCollection.userInterfaceStyle == .dark
    let accent = dark
      ? UIColor(red: 52 / 255, green: 107 / 255, blue: 241 / 255, alpha: 1)
      : UIColor(red: 27 / 255, green: 78 / 255, blue: 216 / 255, alpha: 1)
    let foreground = active ? UIColor.white : dark
      ? UIColor(white: 131 / 255, alpha: 1)
      : UIColor(red: 111 / 255, green: 111 / 255, blue: 121 / 255, alpha: 1)
    label.textColor = foreground
    chevron.tintColor = foreground
    if #available(iOS 26.0, *) {
      let effect = UIGlassEffect(style: .regular)
      effect.isInteractive = true
      effect.tintColor = active ? accent : nil
      glass.effect = effect
    } else {
      glass.backgroundColor = active ? accent : dark
        ? UIColor(white: 26 / 255, alpha: 1)
        : UIColor(red: 244 / 255, green: 244 / 255, blue: 245 / 255, alpha: 1)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    glass.frame = bounds
    let textWidth = max(0, min(180, bounds.width - 21 - 5.25 - 11))
    label.frame = CGRect(x: 10.5, y: 5.25, width: textWidth, height: max(0, bounds.height - 10.5))
    chevron.frame = CGRect(x: label.frame.maxX + 5.25, y: (bounds.height - 11) / 2, width: 11, height: 11)
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    bounds.insetBy(dx: -6, dy: -6).contains(point)
  }

  override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
    selectedFromMenu = false
    super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
  }

  override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    contentPreview()
  }

  override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    selectedFromMenu ? nil : contentPreview()
  }

  private func contentPreview() -> UITargetedPreview? {
    guard glass.window != nil else { return nil }
    let parameters = UIPreviewParameters()
    parameters.backgroundColor = .clear
    parameters.visiblePath = UIBezierPath(roundedRect: glass.bounds, cornerRadius: min(16, glass.bounds.height / 2))
    return UITargetedPreview(view: glass, parameters: parameters)
  }
}
