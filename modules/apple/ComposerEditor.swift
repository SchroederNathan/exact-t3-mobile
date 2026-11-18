import UIKit

final class ComposerEditorInstance: ExactNativeInstance {
  private let editor = ComposerEditorView()

  init(props: [String: String], events: ExactNativeEvents, temporary: URL? = nil) {
    super.init(events: events)
    editor.temporary = temporary
    editor.onEvent = { payload in
      guard let data = try? JSONSerialization.data(withJSONObject: payload), let message = String(data: data, encoding: .utf8) else { return }
      events.message(message)
    }
    editor.onSize = { events.intrinsicSize($0) }
    editor.apply(props)
  }

  override var view: ExactNativeView { editor }
  override var focusTarget: ExactNativeView? { editor.input }
  override func setProps(_ props: [String: String]) throws { editor.apply(props) }
  override func agentInput(_ input: ExactNativeInput) throws {
    switch input {
    case let .text(text): editor.replaceAll(text)
    case let .key(key, phase):
      guard phase != "up" else { return }
      switch key {
      case "BACKSPACE", "Backspace": editor.input.deleteBackward()
      case "ENTER", "Enter": editor.input.performReturn([])
      case "Shift+Enter": editor.input.performReturn(.shift)
      case "Meta+Enter", "Command+Enter": editor.input.performReturn(.command)
      default: throw ExactNativeRefusal("Unsupported composer key: \(key)")
      }
    }
  }
  override func destroy() { editor.dispose() }
}

private final class ContextAttachment: NSTextAttachment {
  let source: String
  let label: String
  init(source: String, label: String, image: UIImage, baseline: CGFloat) {
    self.source = source
    self.label = label
    super.init(data: nil, ofType: nil)
    self.image = image
    bounds = CGRect(x: 0, y: baseline, width: image.size.width, height: image.size.height)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}

private final class ComposerContextAction: UIAccessibilityElement {
  var activate: (() -> Bool)?
  override func accessibilityActivate() -> Bool { activate?() ?? false }
}

private final class ComposerInput: UITextView {
  var copySource: (() -> String)?
  var writeClipboard: (() -> Void)?
  var pasteContext: (() -> Bool)?
  var submitOnReturn = true
  var onHardwareSubmit: ((Bool) -> Void)?
  override var keyCommands: [UIKeyCommand]? {
    let modifiers: [UIKeyModifierFlags] = submitOnReturn ? [[], .shift, .command] : [.command, [.command, .shift]]
    return (super.keyCommands ?? []) + modifiers.map { flags in
      let command = UIKeyCommand(input: "\r", modifierFlags: flags, action: #selector(returnKey(_:)))
      command.wantsPriorityOverSystemBehavior = true
      command.discoverabilityTitle = flags == .shift ? "New Line" : "Send Message"
      return command
    }
  }
  @objc private func returnKey(_ command: UIKeyCommand) { performReturn(command.modifierFlags) }
  func performReturn(_ flags: UIKeyModifierFlags) {
    guard isEditable, markedTextRange == nil else { return }
    if flags == .shift || (!submitOnReturn && !flags.contains(.command)) { insertText("\n"); return }
    onHardwareSubmit?(submitOnReturn ? flags.contains(.command) : flags.contains(.shift))
  }
  override func copy(_ sender: Any?) {
    if let writeClipboard { writeClipboard() }
    else if let source = copySource?() { UIPasteboard.general.string = source }
    else { super.copy(sender) }
  }
  override func paste(_ sender: Any?) {
    guard isEditable else { return }
    if pasteContext?() == true { return }
    if let text = UIPasteboard.general.string { insertText(text) }
    else { super.paste(sender) }
  }
  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)), isEditable,
       UIPasteboard.general.hasImages || UIPasteboard.general.hasURLs { return true }
    return super.canPerformAction(action, withSender: sender)
  }
  override func cut(_ sender: Any?) {
    copy(sender)
    if selectedRange.length > 0 { insertText("") }
  }
}

private final class ComposerEditorView: UIView, UITextViewDelegate, UIGestureRecognizerDelegate {
  let input = ComposerInput()
  var onEvent: (([String: Any]) -> Void)?
  var onSize: ((CGSize) -> Void)?
  var temporary: URL?
  private let hint = UILabel()
  private var applying = false
  private var source = ""
  private var tokenJSON = "[]"
  private var selectionRevision = ""
  private var documentKey = ""
  private var nativeRevision = 0
  private var contextJSON = ""
  private var contextEnvironment = ""
  private var pendingPasteContext: String?
  private var focusRequest: String?
  private var pendingFocus = false
  private var focusScheduled = false
  private var contextTapStartedFocused = false
  private var measured = CGSize.zero
  private var tokens: [[String: Any]] = []
  private var lastWidth: CGFloat = 0
  private var textFont: UIFont { UIFont(name: "DMSans-Regular", size: 16) ?? .systemFont(ofSize: 16) }
  private var chipFont: UIFont { UIFont(name: "DMSans-Medium", size: 16) ?? .systemFont(ofSize: 16, weight: .medium) }
  private var ink: UIColor { UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 245 / 255, alpha: 1) : UIColor(red: 39 / 255, green: 39 / 255, blue: 42 / 255, alpha: 1) } }
  private var accent: UIColor { UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.43, green: 0.62, blue: 1, alpha: 1) : UIColor(red: 0.10, green: 0.30, blue: 0.82, alpha: 1) } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    input.delegate = self
    input.backgroundColor = .clear
    input.font = textFont
    input.textContainerInset = UIEdgeInsets(top: 6, left: 0, bottom: 6, right: 0)
    input.textContainer.lineFragmentPadding = 0
    input.isScrollEnabled = false
    input.smartDashesType = .no
    input.smartQuotesType = .no
    input.accessibilityLabel = "Message"
    input.copySource = { [weak self] in self?.selectedSource() ?? "" }
    input.writeClipboard = { [weak self] in
      guard let self else { return }
      ComposerClipboard.write(text: self.selectedSource(), contextJSON: self.contextJSON, environmentId: self.contextEnvironment)
    }
    input.pasteContext = { [weak self] in self?.pasteStructuredContext() ?? false }
    input.onHardwareSubmit = { [weak self] alternate in self?.publish("submit", alternate: alternate) }
    let tap = UITapGestureRecognizer(target: self, action: #selector(contextTapped(_:)))
    tap.cancelsTouchesInView = false
    tap.delegate = self
    input.addGestureRecognizer(tap)
    input.translatesAutoresizingMaskIntoConstraints = false
    addSubview(input)
    NSLayoutConstraint.activate([
      input.leadingAnchor.constraint(equalTo: leadingAnchor), input.trailingAnchor.constraint(equalTo: trailingAnchor),
      input.topAnchor.constraint(equalTo: topAnchor), input.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    hint.font = textFont
    hint.textColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 131 / 255, alpha: 1) : UIColor(red: 111 / 255, green: 111 / 255, blue: 121 / 255, alpha: 1) }
    hint.isUserInteractionEnabled = false
    hint.translatesAutoresizingMaskIntoConstraints = false
    addSubview(hint)
    NSLayoutConstraint.activate([
      hint.leadingAnchor.constraint(equalTo: leadingAnchor), hint.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
      hint.topAnchor.constraint(equalTo: topAnchor, constant: 6),
      hint.heightAnchor.constraint(equalToConstant: 23),
    ])
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: ComposerEditorView, _: UITraitCollection) in
      view.render(selection: view.sourceSelection())
    }
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  override var accessibilityElements: [Any]? {
    get {
      var result: [Any] = [input]
      let document = input.attributedText ?? NSAttributedString(string: "")
      document.enumerateAttribute(.attachment, in: NSRange(location: 0, length: document.length)) { value, range, _ in
        guard let attachment = value as? ContextAttachment,
              let start = input.position(from: input.beginningOfDocument, offset: range.location),
              let end = input.position(from: start, offset: range.length),
              let selection = input.textRange(from: start, to: end) else { return }
        let frame = input.selectionRects(for: selection).reduce(CGRect.null) { $0.union($1.rect) }
        guard !frame.isNull, frame.intersects(input.bounds) else { return }
        let action = ComposerContextAction(accessibilityContainer: self)
        action.isAccessibilityElement = true
        action.accessibilityLabel = attachment.label
        action.accessibilityTraits = .button
        action.accessibilityFrameInContainerSpace = input.convert(frame, to: self)
        action.activate = { [weak self] in
          guard let self, range.location < self.input.attributedText.length,
                self.input.attributedText.attribute(.attachment, at: range.location, effectiveRange: nil) as? ContextAttachment === attachment else { return false }
          return self.activateContext(attachment.source, wasFocused: self.input.isFirstResponder)
        }
        result.append(action)
      }
      return result
    }
    set { super.accessibilityElements = newValue }
  }

  func apply(_ props: [String: String]) {
    hint.text = props["placeholder-text"] ?? "Message"
    input.isEditable = props["editable"] != "false"
    input.submitOnReturn = props["enter-behavior"] != "newline"
    input.returnKeyType = .default
    let requestedFocus = props["focus-request"] ?? "0"
    if let previous = focusRequest, previous != requestedFocus { pendingFocus = true }
    focusRequest = requestedFocus
    scheduleFocus()
    let key = props["document-key"] ?? ""
    let acknowledgedRevision = Int(props["document-revision"] ?? "") ?? 0
    if key != documentKey {
      documentKey = key
      nativeRevision = acknowledgedRevision
      selectionRevision = ""
    } else if acknowledgedRevision < nativeRevision {
      return
    }
    nativeRevision = acknowledgedRevision
    contextJSON = props["context-json"] ?? ""
    contextEnvironment = props["context-environment"] ?? ""
    let text = props["text"] ?? ""
    let json = props["tokens"] ?? "[]"
    let changed = text != source || json != tokenJSON
    var selection = sourceSelection()
    if changed {
      source = text
      tokenJSON = json
      tokens = (json.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]]) ?? []
    }
    let revision = props["selection-revision"] ?? ""
    let selectionChanged = revision != selectionRevision
    if selectionChanged {
      selectionRevision = revision
      if let start = Int(props["selection-start"] ?? "") {
        let end = Int(props["selection-end"] ?? "") ?? start
        selection = NSRange(location: max(0, start), length: max(0, end - start))
      }
    }
    if changed || selectionChanged { render(selection: selection) }
    hint.isHidden = !source.isEmpty
    measure()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    scheduleFocus()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    scheduleFocus()
    if abs(bounds.width - lastWidth) > 0.5 {
      lastWidth = bounds.width
      render(selection: sourceSelection())
    }
    measure()
  }

  private func scheduleFocus() {
    guard pendingFocus, !focusScheduled, window != nil else { return }
    focusScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.focusScheduled = false
      guard self.pendingFocus, self.window != nil, self.input.isEditable else { return }
      self.pendingFocus = !self.input.becomeFirstResponder()
    }
  }

  private func attributes() -> [NSAttributedString.Key: Any] {
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = 23
    paragraph.maximumLineHeight = 23
    return [.font: textFont, .foregroundColor: ink, .paragraphStyle: paragraph]
  }

  private func render(selection: NSRange) {
    guard input.markedTextRange == nil else { return }
    applying = true
    let result = NSMutableAttributedString(string: "")
    let text = source as NSString
    var position = 0
    let ordered = tokens.sorted { ($0["start"] as? Int ?? 0) < ($1["start"] as? Int ?? 0) }
    for token in ordered {
      guard let start = token["start"] as? Int, let end = token["end"] as? Int,
            start >= position, end > start, end <= text.length else { continue }
      let range = NSRange(location: start, length: end - start)
      let raw = text.substring(with: range)
      if let expected = token["source"] as? String, expected != raw { continue }
      if start > position { result.append(NSAttributedString(string: text.substring(with: NSRange(location: position, length: start - position)), attributes: attributes())) }
      let kind = token["type"] as? String ?? "mention"
      let value = token["value"] as? String ?? raw
      let label = token["label"] as? String ?? (kind == "mention" ? (value as NSString).lastPathComponent : value)
      let symbol = token["symbol"] as? String ?? (kind == "skill" ? "cube" : kind == "thread" ? "text.bubble" : kind == "environment" ? "server.rack" : kind == "model" ? "cpu" : "doc")
      let contextKind = token["kind"] as? String ?? kind
      let fallbackColor: UIColor
      if contextKind == "file" || contextKind == "image" {
        fallbackColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0, green: 146 / 255, blue: 208 / 255, alpha: 1) : UIColor(red: 0, green: 108 / 255, blue: 155 / 255, alpha: 1) }
      } else {
        switch contextKind {
        case "skill":
          fallbackColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 199 / 255, green: 93 / 255, blue: 215 / 255, alpha: 1) : UIColor(red: 160 / 255, green: 54 / 255, blue: 176 / 255, alpha: 1) }
        case "thread":
          fallbackColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0, green: 156 / 255, blue: 150 / 255, alpha: 1) : UIColor(red: 0, green: 114 / 255, blue: 110 / 255, alpha: 1) }
        case "environment":
          fallbackColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0, green: 159 / 255, blue: 57 / 255, alpha: 1) : UIColor(red: 0, green: 118 / 255, blue: 40 / 255, alpha: 1) }
        case "mention":
          fallbackColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0, green: 150 / 255, blue: 175 / 255, alpha: 1) : UIColor(red: 0, green: 112 / 255, blue: 131 / 255, alpha: 1) }
        case "review-comment":
          fallbackColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 149 / 255, green: 112 / 255, blue: 252 / 255, alpha: 1) : UIColor(red: 115 / 255, green: 74 / 255, blue: 211 / 255, alpha: 1) }
        default:
          fallbackColor = accent
        }
      }
      let color = tokenColor(token["accent"] as? String) ?? fallbackColor
      let image = chip(label: label, detail: token["detail"] as? String ?? "", symbol: symbol, color: color)
      let attachment = ContextAttachment(source: raw, label: label, image: image, baseline: chipFont.ascender - image.size.height)
      let segment = NSMutableAttributedString(attachment: attachment)
      segment.addAttributes(attributes(), range: NSRange(location: 0, length: segment.length))
      result.append(segment)
      position = end
    }
    if position < text.length { result.append(NSAttributedString(string: text.substring(from: position), attributes: attributes())) }
    input.attributedText = result
    input.typingAttributes = attributes()
    let start = displayOffset(min(selection.location, text.length))
    let end = displayOffset(min(NSMaxRange(selection), text.length))
    input.selectedRange = NSRange(location: start, length: max(0, end - start))
    applying = false
    hint.isHidden = !source.isEmpty
  }

  private func tokenColor(_ hex: String?) -> UIColor? {
    guard let hex, hex.hasPrefix("#"), hex.count == 7, let rgb = UInt32(hex.dropFirst(), radix: 16) else { return nil }
    return UIColor(red: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
  }

  private func chip(label: String, detail: String, symbol: String, color: UIColor) -> UIImage {
    let color = color.resolvedColor(with: traitCollection)
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingMiddle
    let text = NSMutableAttributedString(string: label, attributes: [.font: chipFont, .foregroundColor: color, .paragraphStyle: paragraph])
    if !detail.isEmpty { text.append(NSAttributedString(string: " " + detail, attributes: [.font: chipFont.withSize(13.44), .foregroundColor: color])) }
    let icon = UIImage(systemName: symbol.replacingOccurrences(of: "symbol:sf/", with: ""))?.withTintColor(color.resolvedColor(with: traitCollection), renderingMode: .alwaysOriginal)
    let iconWidth: CGFloat = icon == nil ? 0 : 20
    let labelWidth = min(text.size().width, max(48, bounds.width - 10 - iconWidth))
    let size = CGSize(width: ceil(10 + iconWidth + labelWidth), height: ceil(chipFont.ascender - chipFont.descender))
    return UIGraphicsImageRenderer(size: size).image { _ in
      icon?.draw(in: CGRect(x: 5, y: (size.height - 16) / 2, width: 16, height: 16))
      text.draw(in: CGRect(x: 5 + iconWidth, y: 0, width: labelWidth, height: size.height))
    }
  }

  private func sourceOffset(_ display: Int) -> Int {
    let value = input.attributedText ?? NSAttributedString(string: "")
    var offset = 0
    value.enumerateAttribute(.attachment, in: NSRange(location: 0, length: min(display, value.length))) { item, range, _ in
      offset += (item as? ContextAttachment).map { ($0.source as NSString).length } ?? range.length
    }
    return offset
  }
  private func displayOffset(_ source: Int) -> Int {
    let value = input.attributedText ?? NSAttributedString(string: "")
    var inputOffset = 0
    var output = value.length
    value.enumerateAttribute(.attachment, in: NSRange(location: 0, length: value.length)) { item, range, stop in
      let length = (item as? ContextAttachment).map { ($0.source as NSString).length } ?? range.length
      if source <= inputOffset + length {
        output = range.location + (item is ContextAttachment ? (source > inputOffset ? 1 : 0) : max(0, source - inputOffset))
        stop.pointee = true
      }
      inputOffset += length
    }
    return min(output, value.length)
  }
  private func sourceSelection() -> NSRange {
    let range = input.selectedRange
    let start = sourceOffset(range.location)
    return NSRange(location: start, length: max(0, sourceOffset(NSMaxRange(range)) - start))
  }
  private func serialized() -> String {
    let value = input.attributedText ?? NSAttributedString(string: "")
    var result = ""
    value.enumerateAttribute(.attachment, in: NSRange(location: 0, length: value.length)) { item, range, _ in
      result += (item as? ContextAttachment)?.source ?? (value.string as NSString).substring(with: range)
    }
    return result
  }
  private func selectedSource() -> String {
    let value = serialized() as NSString
    let range = sourceSelection()
    return value.substring(with: NSRange(location: min(range.location, value.length), length: min(range.length, max(0, value.length - range.location))))
  }
  func replaceAll(_ value: String) {
    source = value
    tokens = []
    render(selection: NSRange(location: (value as NSString).length, length: 0))
    nativeRevision += 1
    publish("edit")
    measure()
  }
  func textViewDidChange(_ textView: UITextView) {
    guard !applying else { return }
    source = serialized()
    hint.isHidden = !source.isEmpty
    nativeRevision += 1
    if let imported = pendingPasteContext {
      pendingPasteContext = nil
      contextJSON = ComposerClipboard.merge(imported, into: contextJSON)
      publish("paste", context: imported)
    } else {
      publish("edit")
    }
    measure()
  }
  private func pasteStructuredContext() -> Bool {
    if let fragment = ComposerClipboard.readTransferFragment() {
      publish("pasteFragment", context: fragment.fragment, pastedText: fragment.text)
      return true
    }
    if let temporary, UIPasteboard.general.hasImages || (UIPasteboard.general.urls ?? []).contains(where: \.isFileURL) {
      do {
        let files = try ComposerClipboard.pickedFiles(in: temporary)
        if !files.isEmpty { publish("pasteFiles", files: files); return true }
      } catch {
        publish("pasteError", context: error.localizedDescription)
        return true
      }
    }
    guard let fragment = ComposerClipboard.read() else {
      if let text = ComposerClipboard.threadLinkText() {
        publish("pasteFragment", pastedText: text)
        return true
      }
      return false
    }
    let imported = ComposerClipboard.resolveCollisions(text: fragment.text, context: fragment.context, existing: contextJSON)
    pendingPasteContext = imported.context
    input.insertText(imported.text)
    pendingPasteContext = nil
    return true
  }
  func textViewDidChangeSelection(_ textView: UITextView) {
    if !applying { publish("selection") }
  }
  func textViewDidBeginEditing(_ textView: UITextView) { publish("focus") }
  func textViewDidEndEditing(_ textView: UITextView) { publish("blur") }
  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    return true
  }
  func textView(_ textView: UITextView, shouldInteractWith attachment: NSTextAttachment, in range: NSRange, interaction: UITextItemInteraction) -> Bool {
    !(attachment is ContextAttachment)
  }
  @objc private func contextTapped(_ gesture: UITapGestureRecognizer) {
    if let source = contextSource(at: gesture.location(in: input)) { _ = activateContext(source, wasFocused: contextTapStartedFocused) }
  }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    contextTapStartedFocused = input.isFirstResponder
    return contextSource(at: touch.location(in: input)) != nil
  }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    true
  }
  private func activateContext(_ source: String, wasFocused: Bool) -> Bool {
    guard wasFocused else { return input.becomeFirstResponder() }
    publish("context", context: source)
    return true
  }
  private func contextSource(at point: CGPoint) -> String? {
    guard let position = input.closestPosition(to: point) else { return nil }
    let nearest = input.offset(from: input.beginningOfDocument, to: position)
    for offset in [nearest, nearest - 1] where offset >= 0 && offset < input.attributedText.length {
      guard let context = input.attributedText.attribute(.attachment, at: offset, effectiveRange: nil) as? ContextAttachment,
            let start = input.position(from: input.beginningOfDocument, offset: offset),
            let end = input.position(from: start, offset: 1), let range = input.textRange(from: start, to: end),
            input.selectionRects(for: range).contains(where: { $0.rect.insetBy(dx: -2, dy: -2).contains(point) }) else { continue }
      return context.source
    }
    return nil
  }
  private func publish(_ kind: String, context: String = "", alternate: Bool = false, files: [[String: Any]] = [], pastedText: String = "") {
    let selection = sourceSelection()
    onEvent?(["kind": kind, "key": documentKey, "text": serialized(), "revision": nativeRevision,
              "start": selection.location, "end": NSMaxRange(selection), "context": context,
              "contextState": kind == "paste" ? contextJSON : "", "alternate": alternate,
              "files": files, "pastedText": pastedText])
  }
  private func measure() {
    guard bounds.width > 0 else { return }
    let height = input.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height
    input.isScrollEnabled = height > 104
    let size = CGSize(width: max(1, bounds.width), height: min(104, max(36, ceil(height))))
    if size != measured { measured = size; onSize?(size) }
  }
  func dispose() {
    pendingFocus = false
    input.delegate = nil
    input.copySource = nil
    input.writeClipboard = nil
    input.pasteContext = nil
    input.onHardwareSubmit = nil
    onEvent = nil; onSize = nil
  }
}
