import UIKit
import UniformTypeIdentifiers

/// Attachment references leave this layer through the owning data source's import path.
enum ComposerClipboard {
  static let fragmentType = "app.t3.context-fragment"
  private static let maximumCharacters = 16_000_000
  private static let supportedKinds = Set(["thread", "environment", "review-comment"])

  static func write(text: String, contextJSON: String, environmentId: String) {
    var item: [String: Any] = ["public.utf8-plain-text": text]
    let context = object(contextJSON)
    let selected = validatedRecords(context?["records"], includingAttachments: true).filter { referenced($0, in: text) }
    let environment = nonempty(environmentId) ?? selected.compactMap { nonempty($0["environmentId"]) }.first
    if let environment, !selected.isEmpty,
       let data = try? JSONSerialization.data(withJSONObject: ["version": 1, "source": ["environmentId": environment], "records": selected]),
       let encoded = String(data: data, encoding: .utf8), encoded.utf16.count <= maximumCharacters {
      item[fragmentType] = data
      let attribute = encoded.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
      let safe = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
      item["public.html"] = Data("<pre data-t3-context-fragment=\"\(attribute)\">\(safe)</pre>".utf8)
    }
    UIPasteboard.general.items = [item]
  }

  static func read() -> (text: String, context: String)? {
    guard let (text, payload) = envelope() else { return nil }
    let records = validatedRecords(payload["records"]).filter { referenced($0, in: text) }
    guard !records.isEmpty, let data = try? JSONSerialization.data(withJSONObject: ["version": 1, "records": records]),
          let context = String(data: data, encoding: .utf8) else { return nil }
    return (text, context)
  }

  static func readTransferFragment() -> (text: String, fragment: String)? {
    guard let (text, payload) = envelope() else { return nil }
    let records = validatedRecords(payload["records"], includingAttachments: true).filter { referenced($0, in: text) }
    // Thread records must take the same transfer path as attachment records. The
    // owning TypeScript layer resolves the source environment and applies peer-link
    // access rules; merging a thread-only envelope natively would bypass that check.
    guard records.contains(where: { ["image", "file", "thread"].contains($0["kind"] as? String ?? "") }),
          let data = try? JSONSerialization.data(withJSONObject: ["version": 1, "source": payload["source"]!, "records": records]),
          let fragment = String(data: data, encoding: .utf8) else { return nil }
    return (text, fragment)
  }

  static func threadLinkText() -> String? {
    let board = UIPasteboard.general
    guard board.numberOfItems == 1, let text = board.string, text.utf16.count <= maximumCharacters,
          text.contains("t3-thread://v2/") || text.contains("https://app.t3.codes/threads/") else { return nil }
    return text
  }

  private static func envelope() -> (String, [String: Any])? {
    let board = UIPasteboard.general
    guard let text = board.string, !text.isEmpty, text.utf16.count <= maximumCharacters else { return nil }
    func decode(_ encoded: String?) -> [String: Any]? {
      guard let encoded, let payload = object(encoded), integer(payload["version"]) == 1,
            let source = payload["source"] as? [String: Any], nonempty(source["environmentId"]) != nil,
            let raw = payload["records"] as? [Any], raw.count <= 200 else { return nil }
      return payload
    }
    if let payload = decode(board.data(forPasteboardType: fragmentType).flatMap { String(data: $0, encoding: .utf8) }) { return (text, payload) }
    if let data = board.data(forPasteboardType: "public.html"), data.count <= maximumCharacters * 9 + 4096,
       let html = String(data: data, encoding: .utf8) {
      let expression = try! NSRegularExpression(pattern: #"data-t3-context-fragment\s*=\s*(?:"([^"]+)"|'([^']+)')"#)
      if let match = expression.firstMatch(in: html, range: NSRange(location: 0, length: (html as NSString).length)) {
        let range = match.range(at: match.range(at: 1).location == NSNotFound ? 2 : 1)
        if let payload = decode((html as NSString).substring(with: range).removingPercentEncoding) { return (text, payload) }
      }
    }
    return nil
  }

  static func pickedFiles(in temporary: URL) throws -> [[String: Any]] {
    let board = UIPasteboard.general
    let images = board.images ?? []
    let files = images.isEmpty ? (board.urls ?? []).filter(\.isFileURL) : []
    guard images.count + files.count <= 100 else { throw ClipboardError("A message can have at most 100 attachments.") }
    var folders: [URL] = []
    var result: [[String: Any]] = []
    func target(_ name: String) throws -> (URL, String) {
      let id = UUID().uuidString.lowercased()
      let directory = temporary.appendingPathComponent("picked", isDirectory: true).appendingPathComponent(id, isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      folders.append(directory)
      return (directory.appendingPathComponent(name), "app:/tmp/picked/\(id)/\(name)")
    }
    do {
      for (index, image) in images.enumerated() {
        guard let data = image.pngData(), data.count <= 80_000_000 else { throw ClipboardError("The pasted image is too large.") }
        let name = images.count == 1 ? "pasted-image.png" : "pasted-image-\(index + 1).png"
        let (url, path) = try target(name)
        try data.write(to: url, options: .atomic)
        result.append(["path": path, "name": name, "type": "image/png", "size": data.count,
                       "width": Int(image.size.width * image.scale), "height": Int(image.size.height * image.scale), "duration": 0])
      }
      for file in files {
        let scoped = file.startAccessingSecurityScopedResource()
        defer { if scoped { file.stopAccessingSecurityScopedResource() } }
        let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, let size = values.fileSize, size > 0, size <= 2_000_000_000 else { throw ClipboardError("The pasted file could not be read.") }
        let name = String(file.lastPathComponent.prefix(255))
        guard !name.isEmpty, name != ".", name != "..", !name.contains("\\"), !name.contains("\0") else { throw ClipboardError("The pasted file name is invalid.") }
        let (url, path) = try target(name)
        try FileManager.default.copyItem(at: file, to: url)
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        result.append(["path": path, "name": name, "type": mime, "size": size, "width": 0, "height": 0, "duration": 0])
      }
      return result
    } catch {
      folders.forEach { try? FileManager.default.removeItem(at: $0) }
      throw error
    }
  }

  static func resolveCollisions(text: String, context: String, existing: String) -> (text: String, context: String) {
    let existingRecords = object(existing)?["records"] as? [[String: Any]] ?? []
    var known = Dictionary(existingRecords.compactMap { entry -> (String, [String: Any])? in
      guard let id = entry["contextId"] as? String else { return nil }
      return (id, entry)
    }, uniquingKeysWith: { first, _ in first })
    var updatedText = text
    let records = validatedRecords(object(context)?["records"]).map { entry -> [String: Any] in
      guard let id = entry["contextId"] as? String, let kind = entry["kind"] as? String else { return entry }
      var result = entry
      if let previous = known[id], !NSDictionary(dictionary: previous).isEqual(to: entry) {
        let replacement = "paste_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        result["contextId"] = replacement
        updatedText = updatedText.replacingOccurrences(of: "t3-context://v1/\(kind)/\(id))", with: "t3-context://v1/\(kind)/\(replacement))")
        known[replacement] = result
      } else {
        known[id] = result
      }
      return result
    }
    guard let data = try? JSONSerialization.data(withJSONObject: ["version": 1, "records": records]),
          let json = String(data: data, encoding: .utf8) else { return (text, context) }
    return (updatedText, json)
  }

  static func merge(_ imported: String, into existing: String) -> String {
    var records = object(existing)?["records"] as? [[String: Any]] ?? []
    var identities = Set(records.compactMap { $0["contextId"] as? String })
    for record in validatedRecords(object(imported)?["records"]) {
      guard let id = record["contextId"] as? String, identities.insert(id).inserted else { continue }
      records.append(record)
    }
    guard let data = try? JSONSerialization.data(withJSONObject: ["version": 1, "records": records]),
          let json = String(data: data, encoding: .utf8) else { return existing }
    return json
  }

  private static func object(_ text: String) -> [String: Any]? {
    guard text.utf16.count <= maximumCharacters, let data = text.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  private static func referenced(_ record: [String: Any], in text: String) -> Bool {
    guard let kind = record["kind"] as? String, let id = record["contextId"] as? String else { return false }
    return text.contains("t3-context://v1/\(kind)/\(id))")
  }

  private static func string(_ value: Any?, limit: Int) -> String? {
    guard let value = value as? String, value.utf16.count <= limit else { return nil }
    return value
  }

  private static func nonempty(_ value: Any?, limit: Int = 2048) -> String? {
    guard let value = string(value, limit: limit), !value.isEmpty,
          value == value.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
    return value
  }

  private static func integer(_ value: Any?) -> Int? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
          value.doubleValue.isFinite, value.doubleValue.rounded() == value.doubleValue,
          value.doubleValue >= 0, value.doubleValue <= 9_007_199_254_740_991 else { return nil }
    return value.intValue
  }

  private static func validatedRecords(_ value: Any?, includingAttachments: Bool = false) -> [[String: Any]] {
    guard let values = value as? [Any], values.count <= 200 else { return [] }
    var seen = Set<String>()
    return values.compactMap { value in
      guard let value = value as? [String: Any], integer(value["version"]) == 1,
            let kind = value["kind"] as? String, supportedKinds.contains(kind) || (includingAttachments && ["file", "image"].contains(kind)),
            let id = nonempty(value["contextId"], limit: 128),
            id.range(of: #"^[a-zA-Z0-9_-]+$"#, options: .regularExpression) != nil,
            let label = string(value["label"], limit: 200), !seen.contains(id) else { return nil }
      var clean: [String: Any] = ["version": 1, "kind": kind, "contextId": id, "label": label]
      switch kind {
      case "file", "image":
        guard let attachment = nonempty(value["attachmentId"], limit: 128),
              attachment.range(of: #"^[a-zA-Z0-9_-]+$"#, options: .regularExpression) != nil,
              let name = nonempty(value["name"], limit: 255), let mime = nonempty(value["mimeType"], limit: 100),
              let size = integer(value["sizeBytes"]) else { return nil }
        clean.merge(["attachmentId": attachment, "name": name, "mimeType": mime, "sizeBytes": size]) { _, new in new }
      case "thread":
        guard let environment = nonempty(value["environmentId"]), let thread = nonempty(value["threadId"]),
              let title = string(value["title"], limit: 200) else { return nil }
        clean.merge(["environmentId": environment, "threadId": thread, "title": title]) { _, new in new }
      case "environment":
        guard let environment = nonempty(value["environmentId"]) else { return nil }
        clean["environmentId"] = environment
      case "review-comment":
        guard let section = nonempty(value["sectionId"], limit: 255), let title = string(value["sectionTitle"], limit: 2048),
              let path = nonempty(value["filePath"]), let start = integer(value["startIndex"]), let end = integer(value["endIndex"]), end >= start,
              let range = string(value["rangeLabel"], limit: 2048), let text = string(value["text"], limit: 16000), let diff = string(value["diff"], limit: 32000) else { return nil }
        clean.merge(["sectionId": section, "sectionTitle": title, "filePath": path, "startIndex": start, "endIndex": end, "rangeLabel": range, "text": text, "diff": diff]) { _, new in new }
        if let language = string(value["fenceLanguage"], limit: 64) { clean["fenceLanguage"] = language }
        if let pull = value["pullRequest"] as? [String: Any], let number = integer(pull["number"]), number > 0,
           let title = string(pull["title"], limit: 2048), let url = string(pull["url"], limit: 2048),
           let head = string(pull["headBranch"], limit: 2048), let base = string(pull["baseBranch"], limit: 2048),
           let state = pull["state"] as? String, ["open", "closed", "merged"].contains(state), let draft = pull["isDraft"] as? Bool {
          clean["pullRequest"] = ["number": number, "title": title, "url": url, "headBranch": head, "baseBranch": base, "state": state, "isDraft": draft]
        }
      default: return nil
      }
      seen.insert(id)
      return clean
    }
  }
}

private struct ClipboardError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
