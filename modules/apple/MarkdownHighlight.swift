import Foundation
import T3Highlight

enum MarkdownHighlight {
  private static let queue = DispatchQueue(label: "com.exact.t3code.markdown-highlight", qos: .userInitiated)

  static func later(_ request: [String: Any], reply: ExactReply) {
    guard let code = request["code"] as? String, let language = request["language"] as? String else {
      reply.fail("Code and language are required.")
      return
    }
    queue.async {
      let tokens: [[String: Int]] = code.utf8CString.withUnsafeBufferPointer { source in
        language.utf8CString.withUnsafeBufferPointer { name in
          let result = t3_highlight_code(source.baseAddress, source.count - 1, name.baseAddress, name.count - 1)
          defer { t3_highlight_free(result) }
          guard let tokens = result.tokens else { return [] }
          return UnsafeBufferPointer(start: tokens, count: result.count).map {
            ["start": Int($0.start), "end": Int($0.end), "kind": Int($0.kind)]
          }
        }
      }
      reply.send(["tokens": tokens])
    }
  }
}
