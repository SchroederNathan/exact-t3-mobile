import UIKit

struct MarkdownTable: Hashable, Sendable {
  struct Run: Hashable, Sendable {
    let text: String
    let strong: Bool
    let emphasis: Bool
    let code: Bool
  }

  struct Cell: Hashable, Sendable {
    let column: Int
    let header: Bool
    let runs: [Run]
  }

  let columns: Int
  let cells: [Cell]

  init?(_ request: [String: Any]) {
    guard let columns = request["columns"] as? Int, columns > 0,
          let source = request["cells"] as? [[String: Any]], columns <= source.count else { return nil }
    var cells: [Cell] = []
    for cell in source {
      guard let column = cell["column"] as? Int, (0..<columns).contains(column),
            let header = cell["header"] as? Bool, let sourceRuns = cell["runs"] as? [[String: Any]] else { return nil }
      var runs: [Run] = []
      for run in sourceRuns {
        guard let text = run["text"] as? String, let strong = run["strong"] as? Bool,
              let emphasis = run["emphasis"] as? Bool, let code = run["code"] as? Bool else { return nil }
        runs.append(Run(text: text, strong: strong, emphasis: emphasis, code: code))
      }
      cells.append(Cell(column: column, header: header, runs: runs))
    }
    self.columns = columns
    self.cells = cells
  }

  func widths() -> [Double] {
    var widths = Array(repeating: 60.0, count: columns)
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = 23
    for cell in cells {
      let text = NSMutableAttributedString(string: "")
      for run in cell.runs {
        let bold = cell.header || run.strong
        let face = bold ? (run.emphasis ? "BoldItalic" : "Bold") : (run.emphasis ? "Italic" : "Regular")
        let size = run.code ? 14.4 : 16.0
        let font = UIFont(name: "\(run.code ? "Menlo" : "DMSans")-\(face)", size: size)
          ?? (run.code ? UIFont.monospacedSystemFont(ofSize: size, weight: bold ? .bold : .regular)
              : UIFont.systemFont(ofSize: size, weight: bold ? .bold : .regular))
        text.append(NSAttributedString(string: run.text, attributes: [.font: font, .paragraphStyle: paragraph]))
      }
      let measured = text.boundingRect(with: CGSize(width: 300, height: CGFloat.greatestFiniteMagnitude),
                                      options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
      widths[cell.column] = max(widths[cell.column], min(320, max(60, ceil(Double(measured.width)) + 20)))
    }
    return widths
  }
}
