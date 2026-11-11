import UIKit

struct MarkdownTable: Hashable, Sendable {
  struct Run: Hashable, Sendable {
    let text: String
    let strong: Bool
    let emphasis: Bool
    let strike: Bool
    let code: Bool
    let href: String
    let linkKind: String
  }

  struct Cell: Hashable, Sendable {
    let column: Int
    let header: Bool
    let align: String
    let parts: [Part]
  }

  struct Part: Hashable, Sendable {
    let runs: [Run]
    let image: Bool
    let inlineImage: Bool
  }

  struct ImageFrame: Sendable {
    let cell: Int
    let part: Int
    let frame: CGRect

    var payload: [String: Any] {
      ["cell": cell, "part": part, "x": frame.minX, "y": frame.minY,
       "width": frame.width, "height": frame.height]
    }
  }

  struct Measurement: Sendable {
    let widths: [Double]
    let height: Double
    let cells: [CGRect]
    let images: [ImageFrame]

    var payload: [String: Any] {
      ["widths": widths, "height": height,
       "cells": cells.map { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] },
       "images": images.map(\.payload)]
    }
  }

  final class ImagePlaceholder: NSTextAttachment {
    var frame: CGRect?

    override func image(forBounds imageBounds: CGRect, textContainer: NSTextContainer?, characterIndex: Int) -> UIImage? {
      // NSStringDrawing reports the attachment's bottom edge, including its baseline offset.
      frame = imageBounds.offsetBy(dx: 0, dy: -imageBounds.height)
      return nil
    }
  }

  struct Text {
    let value: NSMutableAttributedString
    let images: [(part: Int, placeholder: ImagePlaceholder)]
  }

  static let ink = NSAttributedString.Key("t3TableInk")
  static let href = NSAttributedString.Key("t3TableHref")
  static let linkKind = NSAttributedString.Key("t3TableLinkKind")
  let columns: Int
  let cells: [Cell]

  init?(_ request: [String: Any]) {
    guard let columns = request["columns"] as? Int, columns > 0,
          let source = request["cells"] as? [[String: Any]], columns <= source.count,
          source.count % columns == 0 else { return nil }
    var cells: [Cell] = []
    for (index, cell) in source.enumerated() {
      guard let column = cell["column"] as? Int, column == index % columns,
            let header = cell["header"] as? Bool, let align = cell["align"] as? String,
            let sourceParts = cell["parts"] as? [[String: Any]] else { return nil }
      var parts: [Part] = []
      for part in sourceParts {
        guard let sourceRuns = part["runs"] as? [[String: Any]],
              let image = (part["image"] as? Bool) ?? (part["imageSource"] as? String).map({ !$0.isEmpty }),
              let inlineImage = part["inlineImage"] as? Bool else { return nil }
        var runs: [Run] = []
        for run in sourceRuns {
          guard let text = run["text"] as? String, let strong = run["strong"] as? Bool,
                let emphasis = run["emphasis"] as? Bool, let strike = run["strike"] as? Bool,
                let code = run["code"] as? Bool, let href = run["href"] as? String,
                let linkKind = run["linkKind"] as? String else { return nil }
          runs.append(Run(text: text, strong: strong, emphasis: emphasis, strike: strike,
                          code: code, href: href, linkKind: linkKind))
        }
        parts.append(Part(runs: runs, image: image, inlineImage: inlineImage))
      }
      cells.append(Cell(column: column, header: header, align: align, parts: parts))
    }
    self.columns = columns
    self.cells = cells
  }

  private func font(bold: Bool, emphasis: Bool = false, code: Bool = false) -> UIFont {
    let face = bold ? (emphasis ? "BoldItalic" : "Bold") : (emphasis ? "Italic" : "Regular")
    let size = code ? 14.4 : 16.0
    return UIFont(name: "\(code ? "Menlo" : "DMSans")-\(face)", size: size)
      ?? (code ? UIFont.monospacedSystemFont(ofSize: size, weight: bold ? .bold : .regular)
          : UIFont.systemFont(ofSize: size, weight: bold ? .bold : .regular))
  }

  func text(_ cell: Cell, width: CGFloat) -> Text {
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = 23
    paragraph.alignment = cell.align == "right" ? .right : (cell.align == "center" ? .center : .left)
    let baseFont = font(bold: cell.header)
    let text = NSMutableAttributedString(string: "")
    var images: [(part: Int, placeholder: ImagePlaceholder)] = []
    for (partIndex, part) in cell.parts.enumerated() {
      if part.image {
        let attachment = ImagePlaceholder()
        attachment.bounds = CGRect(x: 0, y: part.inlineImage ? (baseFont.capHeight - 20) / 2 : 0,
                                   width: part.inlineImage ? 20 : width, height: part.inlineImage ? 20 : 200)
        images.append((partIndex, attachment))
        let image = NSMutableAttributedString(attachment: attachment)
        image.addAttribute(.font, value: baseFont, range: NSRange(location: 0, length: image.length))
        text.append(image)
      }
      for run in part.runs {
        let linked = !run.href.isEmpty && ["file", "thread", "external"].contains(run.linkKind)
        var attributes: [NSAttributedString.Key: Any] = [
          .font: font(bold: cell.header || run.strong, emphasis: run.emphasis, code: run.code),
          Self.ink: linked ? "link" : (run.code ? "code" : "body")
        ]
        if run.strike { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        if linked {
          attributes[Self.href] = run.href
          attributes[Self.linkKind] = run.linkKind
        }
        text.append(NSAttributedString(string: run.text, attributes: attributes))
      }
    }
    text.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: text.length))
    return Text(value: text, images: images)
  }

  func measure() -> Measurement {
    var widths = Array(repeating: 60.0, count: columns)
    for cell in cells {
      let text = text(cell, width: 300).value
      let measured = text.boundingRect(with: CGSize(width: 300, height: CGFloat.greatestFiniteMagnitude),
                                       options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
      widths[cell.column] = max(widths[cell.column], min(320, max(60, ceil(Double(measured.width)) + 20)))
    }
    guard cells.contains(where: { $0.parts.contains(where: \.image) }) else {
      return Measurement(widths: widths, height: 0, cells: [], images: [])
    }
    var frames: [CGRect] = []
    var images: [ImageFrame] = []
    var y: CGFloat = 0
    for start in stride(from: 0, to: cells.count, by: columns) {
      let texts = (start..<(start + columns)).map { text(cells[$0], width: widths[cells[$0].column] - 20) }
      var height: CGFloat = 0
      for (column, text) in texts.enumerated() {
        let measured = text.value.boundingRect(with: CGSize(width: widths[column] - 20, height: CGFloat.greatestFiniteMagnitude),
                                              options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        height = max(height, ceil(measured.height) + 14)
      }
      var x: CGFloat = 0
      for (column, text) in texts.enumerated() {
        let frame = CGRect(x: x, y: y, width: widths[column], height: height)
        frames.append(frame)
        if !text.images.isEmpty {
          let format = UIGraphicsImageRendererFormat()
          format.scale = 1
          // A one-pixel context invokes every attachment callback without allocating a table-sized bitmap.
          _ = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1), format: format).image { _ in
            text.value.draw(with: frame.insetBy(dx: 10, dy: 7),
                            options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
          }
          for image in text.images {
            if let imageFrame = image.placeholder.frame {
              images.append(ImageFrame(cell: start + column, part: image.part, frame: imageFrame))
            }
          }
        }
        x += widths[column]
      }
      y += height
    }
    return Measurement(widths: widths, height: Double(y), cells: frames, images: images)
  }
}
