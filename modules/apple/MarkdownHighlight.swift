import Foundation
import T3Highlight

enum MarkdownHighlight {
  private struct Token: Sendable {
    let start: Int
    let end: Int
    let kind: Int
  }

  private enum Output: Sendable {
    case tokens([Token])
    case table(MarkdownTable.Measurement)

    var payload: [String: Any] {
      switch self {
      case let .tokens(tokens): return ["tokens": tokens.map { ["start": $0.start, "end": $0.end, "kind": $0.kind] }]
      case let .table(table): return table.payload
      }
    }
  }

  private enum Work: Hashable, Sendable {
    case highlight(String, String)
    case table(MarkdownTable)

    func run() -> Output {
      switch self {
      case let .table(table): return .table(table.measure())
      case let .highlight(code, language):
        let tokens: [Token] = code.utf8CString.withUnsafeBufferPointer { source in
          language.utf8CString.withUnsafeBufferPointer { name in
            let result = t3_highlight_code(source.baseAddress, source.count - 1, name.baseAddress, name.count - 1)
            defer { t3_highlight_free(result) }
            guard let tokens = result.tokens else { return [] }
            return UnsafeBufferPointer(start: tokens, count: result.count).map {
              Token(start: Int($0.start), end: Int($0.end), kind: Int($0.kind))
            }
          }
        }
        return .tokens(tokens)
      }
    }
  }

  private static let queue = MarkdownWorkQueue<Work, Output>()

  static func later(_ request: [String: Any], reply: ExactReply) {
    let work: Work
    if request["op"] as? String == "markdown.measureTable" {
      guard let table = MarkdownTable(request) else {
        reply.fail("Table columns and styled cells are required.")
        return
      }
      work = .table(table)
    } else {
      guard let code = request["code"] as? String, let language = request["language"] as? String else {
        reply.fail("Code and language are required.")
        return
      }
      work = .highlight(code, language)
    }
    queue.submit(work, work: { work.run() }) { result in
      reply.send(result.payload)
    }
  }
}
