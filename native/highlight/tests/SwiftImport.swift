import T3Highlight

public func highlightImportProbe(_ code: String, language: String) -> [[String: Int]] {
  code.utf8CString.withUnsafeBufferPointer { source in
    language.utf8CString.withUnsafeBufferPointer { name in
      let result = t3_highlight_code(source.baseAddress, source.count - 1, name.baseAddress, name.count - 1)
      defer { t3_highlight_free(result) }
      guard let tokens = result.tokens else { return [] }
      return UnsafeBufferPointer(start: tokens, count: result.count).map {
        ["start": Int($0.start), "end": Int($0.end), "kind": Int($0.kind)]
      }
    }
  }
}
