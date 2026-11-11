import UIKit

final class MarkdownTableInstance: ExactNativeInstance {
  private let table = MarkdownTableView()

  init(props: [String: String], events: ExactNativeEvents) throws {
    super.init(events: events)
    table.onEvent = { events.message($0) }
    try table.apply(props)
  }

  override var view: ExactNativeView { table }
  override func setProps(_ props: [String: String]) throws { try table.apply(props) }
  override func destroy() { table.clear() }
}

private final class MarkdownTableView: UIView, UIContextMenuInteractionDelegate {
  var onEvent: ((String) -> Void)?
  private var payload = ""
  private var user = false
  private var headers: [Bool] = []
  private var frames: [CGRect] = []
  private var images: [CGRect] = []
  private var texts: [NSMutableAttributedString] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    isOpaque = false
    contentMode = .redraw
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tap(_:))))
    addInteraction(UIContextMenuInteraction(delegate: self))
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: MarkdownTableView, _: UITraitCollection) in
      view.updateAppearance()
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  func clear() {
    texts = []
    headers = []
    frames = []
    images = []
    accessibilityElements = nil
  }

  func apply(_ props: [String: String]) throws {
    let next = props["table-payload"] ?? ""
    let nextUser = props["user-message"] == "true"
    guard next != payload || nextUser != user else { return }
    guard let data = next.data(using: .utf8),
          let source = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let model = MarkdownTable(source),
          let frameSources = source["frames"] as? [[String: Any]], frameSources.count == model.cells.count,
          let labels = source["labels"] as? [String], labels.count == model.cells.count,
          let imageSources = source["images"] as? [[String: Any]] else {
      throw ExactNativeRefusal("Markdown table text and measured frames are required")
    }
    let cellFrames = frameSources.compactMap(Self.rect)
    let imageFrames = imageSources.compactMap(Self.rect)
    guard cellFrames.count == frameSources.count, imageFrames.count == imageSources.count else {
      throw ExactNativeRefusal("Markdown table frames must be finite and positive")
    }
    clear()
    payload = next
    user = nextUser
    headers = model.cells.map(\.header)
    frames = cellFrames
    images = imageFrames
    texts = model.cells.enumerated().map { model.text($0.element, width: cellFrames[$0.offset].width - 20).value }
    var rows: [UIAccessibilityElement] = []
    for start in stride(from: 0, to: model.cells.count, by: model.columns) {
      let range = start..<(start + model.columns)
      let label = labels[range].filter { !$0.isEmpty }.joined(separator: ", ")
      if label.isEmpty { continue }
      let row = UIAccessibilityElement(accessibilityContainer: self)
      row.accessibilityLabel = "Row \(start / model.columns + 1): \(label)"
      row.accessibilityTraits = headers[start] ? .header : .staticText
      row.accessibilityFrameInContainerSpace = frames[start].union(frames[start + model.columns - 1])
      rows.append(row)
    }
    accessibilityElements = rows
    updateAppearance()
  }

  private static func rect(_ source: [String: Any]) -> CGRect? {
    guard let x = source["x"] as? Double, let y = source["y"] as? Double,
          let width = source["width"] as? Double, let height = source["height"] as? Double,
          [x, y, width, height].allSatisfy(\.isFinite), width > 0, height > 0 else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    if images.contains(where: { $0.contains(point) }) { return nil }
    return super.hitTest(point, with: event)
  }

  private func color(_ light: UInt32, _ dark: UInt32) -> UIColor {
    let value = traitCollection.userInterfaceStyle == .dark ? dark : light
    return UIColor(red: CGFloat(value >> 24) / 255, green: CGFloat((value >> 16) & 255) / 255,
                   blue: CGFloat((value >> 8) & 255) / 255, alpha: CGFloat(value & 255) / 255)
  }

  private var foreground: UIColor { color(0x27272aff, 0xf5f5f5ff) }
  private var link: UIColor { user ? foreground : color(0x1b4ed8ff, 0x346bf1ff) }
  private var code: UIColor { user ? color(0x27272ac7, 0xf5f5f5c7) : color(0x6f6f79ff, 0x838383ff) }
  private var header: UIColor { user ? color(0x00000029, 0x00000047) : color(0xffffffff, 0x111111ff) }
  private var edge: UIColor { user ? foreground : color(0xe4e4e7ff, 0x191919ff) }

  private func updateAppearance() {
    for text in texts {
      text.enumerateAttribute(MarkdownTable.ink, in: NSRange(location: 0, length: text.length)) { ink, range, _ in
        text.addAttribute(.foregroundColor, value: ink as? String == "link" ? link : (ink as? String == "code" ? code : foreground), range: range)
      }
    }
    setNeedsDisplay()
  }

  override func draw(_ rect: CGRect) {
    for (index, frame) in frames.enumerated() where frame.intersects(rect) {
      if headers[index] {
        header.setFill()
        UIRectFill(frame)
      }
      edge.setFill()
      if frame.minX > 0 { UIRectFill(CGRect(x: frame.minX, y: frame.minY, width: 0.333, height: frame.height)) }
      if frame.minY > 0 { UIRectFill(CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: 0.333)) }
      texts[index].draw(with: frame.insetBy(dx: 10, dy: 7),
                        options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    }
  }

  @objc private func tap(_ recognizer: UITapGestureRecognizer) {
    guard recognizer.state == .ended else { return }
    let point = recognizer.location(in: self)
    guard let index = frames.firstIndex(where: { $0.insetBy(dx: 10, dy: 7).contains(point) }) else { return }
    let text = texts[index]
    let frame = frames[index].insetBy(dx: 10, dy: 7)
    let storage = NSTextStorage(attributedString: text)
    let manager = NSLayoutManager()
    let container = NSTextContainer(size: frame.size)
    container.lineFragmentPadding = 0
    manager.addTextContainer(container)
    storage.addLayoutManager(manager)
    manager.ensureLayout(for: container)
    let glyph = manager.glyphIndex(for: CGPoint(x: point.x - frame.minX, y: point.y - frame.minY), in: container)
    guard glyph < manager.numberOfGlyphs else { return }
    let character = manager.characterIndexForGlyph(at: glyph)
    guard character < text.length, let href = text.attribute(MarkdownTable.href, at: character, effectiveRange: nil) as? String,
          let kind = text.attribute(MarkdownTable.linkKind, at: character, effectiveRange: nil) as? String else { return }
    onEvent?("\(kind == "external" ? "external" : "link"):\(href)")
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
    UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      UIMenu(children: [
        UIAction(title: "Copy", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in self?.onEvent?("copy") },
        UIAction(title: "Copy as Markdown", image: UIImage(systemName: "doc.text")) { [weak self] _ in self?.onEvent?("copy-markdown") }
      ])
    }
  }
}
