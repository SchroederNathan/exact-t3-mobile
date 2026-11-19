import UIKit

typealias ExactNativeView = UIView
final class ExactNativeEvents {
  var messages: [[String: Any]] = []
  var rawMessages: [String] = []
  func message(_ value: String) { rawMessages.append(value); if let data = value.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { messages.append(object) } }
  func intrinsicSize(_ value: CGSize?) {}
}
enum ExactNativeInput { case text(String); case key(String, phase: String?) }
struct ExactNativeRefusal: Error { init(_ value: String) {} }
class ExactNativeInstance {
  init(events: ExactNativeEvents) {}
  var view: ExactNativeView { UIView() }
  var focusTarget: ExactNativeView? { nil }
  func setProps(_ props: [String: String]) throws {}
  func agentInput(_ input: ExactNativeInput) throws {}
  func destroy() {}
}

@main
final class EditorProbe: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    return true
  }
  func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Probe", sessionRole: connectingSceneSession.role)
    configuration.delegateClass = ProbeScene.self
    return configuration
  }
  func start(_ window: UIWindow) {
    self.window = window
    log("START: native composer probe")
    DispatchQueue.main.async { self.run() }
  }

  private func log(_ message: String) {
    print(message)
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("probe.txt")
    let previous = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    try! (previous + message + "\n").write(to: url, atomically: true, encoding: .utf8)
  }

  private func check(_ condition: @autoclosure () -> Bool, _ label: String) {
    guard condition() else { log("FAIL: \(label)"); fflush(stdout); exit(1) }
    log("PASS: \(label)")
  }

  private func opaqueChipColor(_ image: UIImage) -> [Double] {
    let image = image.cgImage!
    var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
    bytes.withUnsafeMutableBytes { pointer in
      let context = CGContext(data: pointer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    }
    var colors: [Int: Int] = [:]
    for offset in stride(from: 0, to: bytes.count, by: 4) where bytes[offset + 3] == 255 {
      let rgb = Int(bytes[offset]) << 16 | Int(bytes[offset + 1]) << 8 | Int(bytes[offset + 2])
      colors[rgb, default: 0] += 1
    }
    let rgb = colors.max { $0.value < $1.value }!.key
    return [Double((rgb >> 16) & 255), Double((rgb >> 8) & 255), Double(rgb & 255)]
  }

  private func contrast(_ lhs: [Double], _ rhs: [Double]) -> Double {
    func luminance(_ rgb: [Double]) -> Double {
      let linear = rgb.map { value -> Double in let channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4) }
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
    let a = luminance(lhs), b = luminance(rhs)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)
  }

  private func run() {
    let metricsEvents = ExactNativeEvents()
    let metrics = ComposerMetricsInstance(props: [:], events: metricsEvents)
    metrics.view.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
    window!.rootViewController!.view.addSubview(metrics.view)
    metrics.view.layoutIfNeeded()
    let screenFrame = window!.convert(window!.bounds, to: window!.screen.coordinateSpace)
    func keyboardFrame(_ frame: CGRect) {
      NotificationCenter.default.post(name: UIResponder.keyboardWillChangeFrameNotification, object: nil, userInfo: [UIResponder.keyboardFrameEndUserInfoKey: NSValue(cgRect: frame)])
    }
    keyboardFrame(CGRect(x: screenFrame.minX, y: screenFrame.maxY, width: screenFrame.width, height: 300))
    check(Double(metricsEvents.rawMessages.last ?? "") == 0, "hidden keyboard retains resting composer inset")
    keyboardFrame(CGRect(x: screenFrame.minX, y: screenFrame.maxY - 300, width: screenFrame.width, height: 300))
    check(Double(metricsEvents.rawMessages.last ?? "") == -8, "software keyboard applies upstream opened offset")
    keyboardFrame(CGRect(x: screenFrame.minX, y: screenFrame.maxY - 54, width: screenFrame.width, height: 54))
    check(Double(metricsEvents.rawMessages.last ?? "") == 0, "hardware keyboard accessory does not move composer")
    keyboardFrame(CGRect(x: screenFrame.minX + 20, y: screenFrame.maxY - 300, width: 200, height: 200))
    check(Double(metricsEvents.rawMessages.last ?? "") == 0, "floating keyboard does not move bottom composer")
    keyboardFrame(CGRect(x: screenFrame.minX, y: screenFrame.maxY - 300, width: screenFrame.width, height: 300))
    NotificationCenter.default.post(name: UIResponder.keyboardWillHideNotification, object: nil)
    check(Double(metricsEvents.rawMessages.last ?? "") == 0, "keyboard dismissal restores resting composer inset")
    for (style, label, surfaces) in [(UIUserInterfaceStyle.light, "light", [[252.0, 252, 252], [239, 239, 241], [244, 244, 245]]), (.dark, "dark", [[10.0, 10, 10], [22, 22, 22], [24, 25, 25]])] {
      for kind in ["file", "image", "skill", "thread", "environment", "mention", "review-comment"] {
        let source = kind
        let token: [[String: Any]] = [["type": kind == "skill" ? "skill" : kind == "mention" ? "mention" : "context", "kind": kind, "start": 0, "end": (source as NSString).length, "source": source, "label": kind, "symbol": "doc"]]
        let tokenJSON = String(data: try! JSONSerialization.data(withJSONObject: token), encoding: .utf8)!
        let paletteEditor = ComposerEditorInstance(props: ["text": source, "tokens": tokenJSON], events: ExactNativeEvents())
        paletteEditor.view.overrideUserInterfaceStyle = style
        paletteEditor.view.frame = CGRect(x: 20, y: 660, width: 320, height: 36)
        window!.rootViewController!.view.addSubview(paletteEditor.view)
        paletteEditor.view.layoutIfNeeded()
        let paletteInput = paletteEditor.focusTarget as! UITextView
        let image = (paletteInput.attributedText.attribute(.attachment, at: 0, effectiveRange: nil) as! NSTextAttachment).image!
        let color = opaqueChipColor(image)
        check(surfaces.allSatisfy { contrast(color, $0) >= 5 }, "rendered \(label) \(kind) chip meets reference contrast on all message surfaces")
        paletteEditor.destroy()
        paletteEditor.view.removeFromSuperview()
      }
    }
    let events = ExactNativeEvents()
    let text = "👩🏽‍💻 check @src/a.ts then $tool"
    let mention = (text as NSString).range(of: "@src/a.ts")
    let tokens: [[String: Any]] = [["start": mention.location, "end": NSMaxRange(mention), "source": "@src/a.ts", "label": "a.ts", "symbol": "doc"]]
    let json = String(data: try! JSONSerialization.data(withJSONObject: tokens), encoding: .utf8)!
    var props = ["document-key": "draft-a", "document-revision": "0", "text": text, "tokens": json, "selection-revision": "1", "selection-start": String(NSMaxRange(mention)), "selection-end": String(NSMaxRange(mention))]
    let editor = ComposerEditorInstance(props: props, events: events)
    editor.view.frame = CGRect(x: 20, y: 100, width: 320, height: 104)
    window!.rootViewController!.view.addSubview(editor.view)
    editor.view.layoutIfNeeded()
    let input = editor.focusTarget as! UITextView
    let firstChipAction = editor.view.accessibilityElements?.compactMap { $0 as? UIAccessibilityElement }.first
    check(!input.isFirstResponder && firstChipAction?.accessibilityActivate() == true && input.isFirstResponder, "first blurred chip activation focuses the composer")
    check(events.messages.allSatisfy { $0["kind"] as? String != "context" }, "first blurred chip activation does not open context")
    _ = input.becomeFirstResponder()
    check(input.attributedText.string.contains("\u{FFFC}"), "context is a real inline attachment")
    check(!input.attributedText.string.contains("@src/a.ts"), "context source is compact in display")
    check(input.selectedRange.location == mention.location + 1, "source caret maps over emoji and chip")
    let contextAttachment = input.attributedText.attribute(.attachment, at: mention.location, effectiveRange: nil) as! NSTextAttachment
    for (interaction, label) in [(UITextItemInteraction.invokeDefaultAction, "default action"), (.presentActions, "attachment actions"), (.preview, "system preview")] {
      check(input.delegate?.textView?(input, shouldInteractWith: contextAttachment, in: NSRange(location: mention.location, length: 1), interaction: interaction) == false, "context blocks UIKit \(label)")
    }
    check(input.delegate?.textView?(input, shouldInteractWith: NSTextAttachment(), in: NSRange(location: 0, length: 1), interaction: .invokeDefaultAction) == true, "ordinary attachments retain UIKit interaction")
    let chipActions = editor.view.accessibilityElements?.compactMap { $0 as? UIAccessibilityElement } ?? []
    check(chipActions.count == 1 && chipActions[0].accessibilityLabel == "a.ts" && chipActions[0].accessibilityTraits.contains(.button), "inline context exposes a labeled accessibility button")
    check(chipActions[0].accessibilityActivate() && events.messages.last?["context"] as? String == "@src/a.ts", "accessibility activation opens the matching context")
    input.selectedRange = NSRange(location: mention.location, length: 1)
    input.copy(nil)
    check(UIPasteboard.general.string == "@src/a.ts", "copy preserves complete context source")
    input.selectedRange = NSRange(location: mention.location + 1, length: 0)
    input.deleteBackward()
    let edit = events.messages.last { $0["kind"] as? String == "edit" }!
    let removed = (text as NSString).replacingCharacters(in: mention, with: "")
    check(edit["text"] as? String == removed, "backspace removes context atomically")
    check(edit["revision"] as? Int == 1, "native edit has increasing revision")
    check(!chipActions[0].accessibilityActivate(), "deleted context cannot activate a stale accessibility button")
    try! editor.setProps(props)
    check(!input.attributedText.string.contains("\u{FFFC}"), "stale controlled echo cannot restore deleted chip")
    props["document-revision"] = "1"
    props["text"] = "External command"
    props["tokens"] = "[]"
    try! editor.setProps(props)
    check(input.text == "External command", "acknowledged external changes apply")
    try! editor.agentInput(.text("日本語 👨‍👩‍👧‍👦"))
    let typed = events.messages.last { $0["kind"] as? String == "edit" }!
    check(typed["text"] as? String == "日本語 👨‍👩‍👧‍👦", "Unicode typing serializes losslessly")
    check(typed["revision"] as? Int == 2, "agent typing uses native revision protocol")
    try! editor.setProps(props)
    check(input.text == "日本語 👨‍👩‍👧‍👦", "stale echo cannot replace newer typing")
    props["document-key"] = "draft-b"
    props["document-revision"] = "0"
    props["text"] = "Another draft"
    try! editor.setProps(props)
    check(input.text == "Another draft", "switching draft resets the revision scope")
    input.insertText("\n")
    check(input.text.contains("\n"), "software Return inserts a newline")
    try! editor.agentInput(.key("Enter", phase: nil))
    check(events.messages.last?["kind"] as? String == "submit", "hardware Return submits by default")
    try! editor.agentInput(.key("Shift+Enter", phase: nil))
    check(events.messages.last?["kind"] as? String == "edit", "hardware Shift Return inserts a newline")
    try! editor.agentInput(.key("Meta+Enter", phase: nil))
    check(events.messages.last?["alternate"] as? Bool == true, "hardware Command Return requests alternate send")
    editor.destroy()
    let undoEvents = ExactNativeEvents()
    let undoEditor = ComposerEditorInstance(props: ["document-key": "undo", "document-revision": "0", "text": text, "tokens": json, "selection-revision": "1", "selection-start": String(NSMaxRange(mention)), "selection-end": String(NSMaxRange(mention))], events: undoEvents)
    undoEditor.view.frame = CGRect(x: 20, y: 230, width: 320, height: 104)
    window!.rootViewController!.view.addSubview(undoEditor.view)
    undoEditor.view.layoutIfNeeded()
    let undoInput = undoEditor.focusTarget as! UITextView
    _ = undoInput.becomeFirstResponder()
    undoInput.deleteBackward()
    try! undoEditor.setProps(["document-key": "undo", "document-revision": "1", "text": removed, "tokens": "[]"])
    undoInput.undoManager?.undo()
    check(undoEvents.messages.last { $0["kind"] as? String == "edit" }?["text"] as? String == text, "undo restores deleted context after controlled acknowledgement")
    undoEditor.destroy()
    let reference = "[My thread](t3-context://v1/thread/th_context)"
    let contextRecord: [String: Any] = ["version": 1, "kind": "thread", "contextId": "th_context", "label": "My thread", "environmentId": "env-a", "threadId": "thread-a", "title": "My thread", "attachmentId": "must-not-travel"]
    let extraRecord: [String: Any] = ["version": 1, "kind": "environment", "contextId": "unselected", "label": "Elsewhere", "environmentId": "env-b"]
    let contextJSON = String(data: try! JSONSerialization.data(withJSONObject: ["version": 1, "records": [contextRecord, extraRecord]]), encoding: .utf8)!
    ComposerClipboard.write(text: reference, contextJSON: contextJSON, environmentId: "source-environment")
    let clipboard = UIPasteboard.general.items[0]
    let envelope = try! JSONSerialization.jsonObject(with: clipboard[ComposerClipboard.fragmentType] as! Data) as! [String: Any]
    let copiedRecords = envelope["records"] as! [[String: Any]]
    check(copiedRecords.count == 1 && copiedRecords[0]["contextId"] as? String == "th_context", "rich copy includes only selected context records")
    check((envelope["source"] as? [String: Any])?["environmentId"] as? String == "source-environment", "clipboard envelope includes source environment")
    check(copiedRecords[0]["attachmentId"] == nil, "clipboard schema removes unrelated attachment identifiers")
    let imported = ComposerClipboard.read()!
    check(imported.text == reference && imported.context.contains("th_context"), "native fragment imports supported thread context")
    let unchanged = ComposerClipboard.resolveCollisions(text: imported.text, context: imported.context, existing: imported.context)
    check(unchanged.text == reference, "identical context keeps its identity on repeated paste")
    var conflictingRecord = copiedRecords[0]
    conflictingRecord["threadId"] = "another-thread"
    let conflictJSON = String(data: try! JSONSerialization.data(withJSONObject: ["version": 1, "records": [conflictingRecord]]), encoding: .utf8)!
    let resolved = ComposerClipboard.resolveCollisions(text: reference, context: imported.context, existing: conflictJSON)
    let resolvedPayload = try! JSONSerialization.jsonObject(with: Data(resolved.context.utf8)) as! [String: Any]
    let resolvedRecord = (resolvedPayload["records"] as! [[String: Any]])[0]
    let resolvedID = resolvedRecord["contextId"] as! String
    check(resolvedID.hasPrefix("paste_") && resolved.text == reference.replacingOccurrences(of: "th_context", with: resolvedID), "conflicting paste receives a new identity and matching source link")
    let fileRecord: [String: Any] = ["version": 1, "kind": "file", "contextId": "local_file", "label": "notes.md", "attachmentId": "local-attachment"]
    let existingJSON = String(data: try! JSONSerialization.data(withJSONObject: ["version": 1, "records": [conflictingRecord, fileRecord]]), encoding: .utf8)!
    let merged = ComposerClipboard.merge(resolved.context, into: existingJSON)
    let mergedPayload = try! JSONSerialization.jsonObject(with: Data(merged.utf8)) as! [String: Any]
    let mergedRecords = mergedPayload["records"] as! [[String: Any]]
    check(mergedRecords.count == 3 && mergedRecords[0]["threadId"] as? String == "another-thread" && mergedRecords[1]["attachmentId"] as? String == "local-attachment", "paste preserves existing thread and attachment metadata")
    let environmentReference = "[Elsewhere](t3-context://v1/environment/unselected)"
    let reviewRecord: [String: Any] = ["version": 1, "kind": "review-comment", "contextId": "review_a", "label": "Review", "sectionId": "section-a", "sectionTitle": "Changes", "filePath": "app.ts", "startIndex": 1, "endIndex": 2, "rangeLabel": "L1-L2", "text": "Check this", "diff": "+example"]
    let reviewReference = "[Review](t3-context://v1/review-comment/review_a)"
    let otherJSON = String(data: try! JSONSerialization.data(withJSONObject: ["version": 1, "records": [extraRecord, reviewRecord]]), encoding: .utf8)!
    ComposerClipboard.write(text: environmentReference + " " + reviewReference, contextJSON: otherJSON, environmentId: "env-a")
    let otherImport = ComposerClipboard.read()!
    check(otherImport.context.contains("review_a") && otherImport.context.contains("unselected"), "environment and review-comment context survive rich clipboard round trip")
    UIPasteboard.general.items = [clipboard]
    let pasteEvents = ExactNativeEvents()
    let prefix = "Hi 👋 "
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: temporary) }
    let pasteEditor = ComposerEditorInstance(props: ["document-key": "paste", "document-revision": "0", "text": prefix, "tokens": "[]", "selection-revision": "1", "selection-start": String((prefix as NSString).length), "selection-end": String((prefix as NSString).length)], events: pasteEvents, temporary: temporary)
    pasteEditor.view.frame = CGRect(x: 20, y: 360, width: 320, height: 104)
    window!.rootViewController!.view.addSubview(pasteEditor.view)
    pasteEditor.view.layoutIfNeeded()
    let pasteInput = pasteEditor.focusTarget as! UITextView
    _ = pasteInput.becomeFirstResponder()
    let nativeReference = environmentReference + " " + reviewReference
    ComposerClipboard.write(text: nativeReference, contextJSON: otherJSON, environmentId: "env-a")
    let nativeClipboard = UIPasteboard.general.items[0]
    UIPasteboard.general.items = [nativeClipboard]
    pasteInput.paste(nil)
    let pasted = pasteEvents.messages.last { $0["kind"] as? String == "paste" }!
    check(pasted["text"] as? String == prefix + nativeReference && pasted["revision"] as? Int == 1, "rich local paste emits full text with one document revision")
    check(pasted["start"] as? Int == ((prefix + nativeReference) as NSString).length, "rich paste preserves UTF16 cursor (got \(pasted["start"] ?? -1), expected \(((prefix + nativeReference) as NSString).length))")
    check((pasted["context"] as? String)?.contains("review_a") == true, "rich local paste includes imported context records")
    ComposerClipboard.write(text: environmentReference, contextJSON: otherJSON, environmentId: "env-a")
    pasteInput.paste(nil)
    let consecutive = pasteEvents.messages.last { $0["kind"] as? String == "paste" }!
    let consecutiveState = try! JSONSerialization.jsonObject(with: Data((consecutive["contextState"] as! String).utf8)) as! [String: Any]
    let consecutiveIDs = Set((consecutiveState["records"] as! [[String: Any]]).compactMap { $0["contextId"] as? String })
    check(consecutiveIDs == ["review_a", "unselected"], "consecutive paste publishes full metadata before any controlled acknowledgement")
    check(consecutive["text"] as? String == prefix + nativeReference + environmentReference && consecutive["revision"] as? Int == 2, "consecutive paste retains both source links and advances one revision")
    let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 3)).image { context in
      UIColor.red.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 4, height: 3))
    }
    UIPasteboard.general.image = image
    let beforeImageText = pasteInput.text
    pasteInput.paste(nil)
    let imagePaste = pasteEvents.messages.last { $0["kind"] as? String == "pasteFiles" }!
    let pastedImage = (imagePaste["files"] as! [[String: Any]])[0]
    let imagePath = pastedImage["path"] as! String
    let imageFile = temporary.appendingPathComponent(String(imagePath.dropFirst("app:/tmp/".count)))
    check(imagePath.hasPrefix("app:/tmp/picked/") && FileManager.default.fileExists(atPath: imageFile.path) && pastedImage["type"] as? String == "image/png", "image paste creates an owned picker-compatible file")
    check(pasteInput.text == beforeImageText && imagePaste["revision"] as? Int == 2, "image paste waits for staged attachment insertion without changing text")
    let fileURL = temporary.appendingPathComponent("clipboard.txt")
    try! Data("Pasted file".utf8).write(to: fileURL)
    UIPasteboard.general.urls = [fileURL]
    pasteInput.paste(nil)
    let filePaste = pasteEvents.messages.last { $0["kind"] as? String == "pasteFiles" }!
    let pastedFile = (filePaste["files"] as! [[String: Any]])[0]
    check(pastedFile["name"] as? String == "clipboard.txt" && pastedFile["type"] as? String == "text/plain" && pastedFile["size"] as? Int == 11, "file URL paste stages readable bytes with file metadata")
    let remoteRecord: [String: Any] = ["version": 1, "kind": "file", "contextId": "remote_file", "label": "readme.txt", "attachmentId": "remote_attachment", "name": "readme.txt", "mimeType": "text/plain", "sizeBytes": 11]
    let remoteReference = "[readme.txt](t3-context://v1/file/remote_file)"
    let remoteContext = String(data: try! JSONSerialization.data(withJSONObject: ["version": 1, "records": [remoteRecord]]), encoding: .utf8)!
    ComposerClipboard.write(text: remoteReference, contextJSON: remoteContext, environmentId: "remote-env")
    pasteInput.paste(nil)
    let transfer = pasteEvents.messages.last { $0["kind"] as? String == "pasteFragment" }!
    let transferPayload = try! JSONSerialization.jsonObject(with: Data((transfer["context"] as! String).utf8)) as! [String: Any]
    check((transferPayload["source"] as? [String: Any])?["environmentId"] as? String == "remote-env" && transfer["pastedText"] as? String == remoteReference, "remote attachment clipboard retains source environment for explicit transfer")
    check(pasteInput.text == beforeImageText && transfer["revision"] as? Int == 2, "remote attachment identifiers are never inserted before transfer")
    let threadReference = "[Source thread](t3-context://v1/thread/remote_thread)"
    let threadRecord: [String: Any] = ["version": 1, "kind": "thread", "contextId": "remote_thread", "label": "Source thread", "environmentId": "peer-env", "threadId": "thread-42", "title": "Source thread"]
    let threadEnvelope = try! JSONSerialization.data(withJSONObject: ["version": 1, "source": ["environmentId": "peer-env"], "records": [threadRecord]])
    UIPasteboard.general.items = [["public.utf8-plain-text": threadReference, ComposerClipboard.fragmentType: threadEnvelope]]
    let beforeThreadEnvelopeText = pasteInput.text
    pasteInput.paste(nil)
    let structuredThreadPaste = pasteEvents.messages.last { $0["kind"] as? String == "pasteFragment" && $0["pastedText"] as? String == threadReference }!
    let structuredThreadPayload = try! JSONSerialization.jsonObject(with: Data((structuredThreadPaste["context"] as! String).utf8)) as! [String: Any]
    let structuredThreadRecords = structuredThreadPayload["records"] as! [[String: Any]]
    check((structuredThreadPayload["source"] as? [String: Any])?["environmentId"] as? String == "peer-env" && structuredThreadRecords[0]["threadId"] as? String == "thread-42" && pasteInput.text == beforeThreadEnvelopeText, "structured thread context routes through TypeScript transfer resolution without native merge")
    let mixedReference = "\(threadReference) \(remoteReference)"
    let mixedEnvelope = try! JSONSerialization.data(withJSONObject: ["version": 1, "source": ["environmentId": "peer-env"], "records": [threadRecord, remoteRecord]])
    UIPasteboard.general.items = [["public.utf8-plain-text": mixedReference, ComposerClipboard.fragmentType: mixedEnvelope]]
    pasteInput.paste(nil)
    let mixedTransfer = pasteEvents.messages.last { $0["kind"] as? String == "pasteFragment" && $0["pastedText"] as? String == mixedReference }!
    check((mixedTransfer["context"] as? String)?.contains("remote_thread") == true && (mixedTransfer["context"] as? String)?.contains("remote_file") == true, "mixed thread and attachment context stays on the TypeScript transfer path")
    let localEnvironmentReference = "[Local environment](t3-context://v1/environment/local_env)"
    let localEnvironmentRecord: [String: Any] = ["version": 1, "kind": "environment", "contextId": "local_env", "label": "Local environment", "environmentId": "local-env"]
    let localEnvironmentEnvelope = try! JSONSerialization.data(withJSONObject: ["version": 1, "source": ["environmentId": "local-env"], "records": [localEnvironmentRecord]])
    UIPasteboard.general.items = [["public.utf8-plain-text": localEnvironmentReference, ComposerClipboard.fragmentType: localEnvironmentEnvelope]]
    check(ComposerClipboard.readTransferFragment() == nil && ComposerClipboard.read()?.context.contains("local_env") == true, "local non-transfer context remains on the native merge path")
    let localSkillReference = "$review"
    let localSkillEnvelope = try! JSONSerialization.data(withJSONObject: ["version": 1, "source": ["environmentId": "local-env"], "records": [["version": 1, "kind": "skill", "contextId": "skill_review", "label": "review"]]])
    UIPasteboard.general.items = [["public.utf8-plain-text": localSkillReference, ComposerClipboard.fragmentType: localSkillEnvelope]]
    check(ComposerClipboard.readTransferFragment() == nil && ComposerClipboard.read() == nil, "local skill text is not promoted to peer transfer")
    UIPasteboard.general.items = [["public.utf8-plain-text": reference, "public.html": clipboard["public.html"]!]]
    check(ComposerClipboard.read()?.context.contains("th_context") == true, "HTML clipboard envelope imports across compatible clients")
    UIPasteboard.general.items = [["public.utf8-plain-text": reference, ComposerClipboard.fragmentType: Data("{broken".utf8), "public.html": clipboard["public.html"]!]]
    check(ComposerClipboard.read()?.context.contains("th_context") == true, "valid HTML recovers context when custom clipboard data is malformed")
    UIPasteboard.general.items = [["public.utf8-plain-text": reference, ComposerClipboard.fragmentType: Data("{\"version\":2,\"records\":[]}".utf8), "public.html": clipboard["public.html"]!]]
    check(ComposerClipboard.read()?.context.contains("th_context") == true, "valid HTML recovers context when custom clipboard schema is unsupported")
    let threadLink = "See [Thread](t3-thread://v2/source/thread-one)"
    UIPasteboard.general.string = threadLink
    let beforeThreadPaste = pasteInput.text
    pasteInput.paste(nil)
    let threadPaste = pasteEvents.messages.last { $0["kind"] as? String == "pasteFragment" }!
    check(threadPaste["context"] as? String == "" && threadPaste["pastedText"] as? String == threadLink && pasteInput.text == beforeThreadPaste, "plain thread links defer to context resolution without duplicate text insertion")
    UIPasteboard.general.string = "https://app.t3.codes/threads/source/thread-two"
    check(ComposerClipboard.threadLinkText() == UIPasteboard.general.string, "HTTPS thread links use the same context resolution path")
    UIPasteboard.general.items = [["public.utf8-plain-text": threadLink], ["public.utf8-plain-text": "second item"]]
    check(ComposerClipboard.threadLinkText() == nil, "multiple clipboard items retain native plain-paste handling")
    let unsupported: [String: Any] = ["version": 1, "source": ["environmentId": "other"], "records": [["version": 1, "kind": "file", "contextId": "file_context", "label": "file.txt", "attachmentId": "remote-file-id"]]]
    UIPasteboard.general.items = [["public.utf8-plain-text": "ordinary file text", ComposerClipboard.fragmentType: try! JSONSerialization.data(withJSONObject: unsupported)]]
    pasteInput.paste(nil)
    check(pasteEvents.messages.last { ["edit", "paste"].contains($0["kind"] as? String ?? "") }?["kind"] as? String == "edit", "unsupported file fragment falls back to ordinary text")
    check(pasteInput.text.contains("ordinary file text"), "fallback never imports cross-environment attachment IDs")
    UIPasteboard.general.items = [["public.utf8-plain-text": "malformed", ComposerClipboard.fragmentType: Data("{broken".utf8)]]
    check(ComposerClipboard.read() == nil, "malformed clipboard envelope is ignored")
    pasteEditor.destroy()
    _ = pasteInput.resignFirstResponder()
    let focusEditor = ComposerEditorInstance(props: ["document-key": "focus", "document-revision": "0", "focus-request": "0", "text": "", "tokens": "[]"], events: ExactNativeEvents())
    focusEditor.view.frame = CGRect(x: 20, y: 490, width: 320, height: 104)
    window!.rootViewController!.view.addSubview(focusEditor.view)
    focusEditor.view.layoutIfNeeded()
    let focusInput = focusEditor.focusTarget as! UITextView
    check(!focusInput.isFirstResponder, "initial focus request does not open keyboard")
    try! focusEditor.setProps(["document-key": "focus", "document-revision": "0", "focus-request": "1", "text": "", "tokens": "[]"])
    DispatchQueue.main.async {
      self.check(focusInput.isFirstResponder, "changed focus request reaches native editor after mount")
      focusEditor.destroy()
      self.log("PASS: native composer checks complete")
      fflush(stdout)
      exit(0)
    }
  }
}

final class ProbeScene: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    let window = UIWindow(windowScene: scene as! UIWindowScene)
    window.rootViewController = UIViewController()
    self.window = window
    window.makeKeyAndVisible()
    (UIApplication.shared.delegate as! EditorProbe).start(window)
  }
}
