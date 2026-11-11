import QuickLook
import UIKit

private final class AttachmentPreviewItem: NSObject, QLPreviewItem {
  let previewItemURL: URL?
  let previewItemTitle: String?

  init(url: URL, title: String) {
    previewItemURL = url
    previewItemTitle = title
  }
}

private final class AttachmentPreviewController: QLPreviewController {
  var onDismiss: (() -> Void)?

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isBeingDismissed || presentingViewController == nil { onDismiss?() }
  }
}

@MainActor
final class AttachmentPreview: NSObject, QLPreviewControllerDataSource,
  QLPreviewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  @MainActor private final class Presentation {
    let id: String
    let item: AttachmentPreviewItem
    let controller = AttachmentPreviewController()
    var reply: ExactReply?
    var appeared = false
    var dismissRequested = false
    var dismissing = false
    var animated = true

    init(id: String, item: AttachmentPreviewItem, reply: ExactReply) {
      self.id = id
      self.item = item
      self.reply = reply
    }
  }

  private let context: ExactModuleContext
  private var active: Presentation?

  init(context: ExactModuleContext) {
    self.context = context
  }

  func present(_ request: [String: Any], reply: ExactReply) {
    do {
      let id = try identity(request)
      guard active == nil else { throw ExactNativeRefusal("Close the current preview before opening another file.") }
      guard let path = request["path"] as? String else { throw ExactNativeRefusal("An attachment file is required.") }
      let url = try file(path)
      let title = (request["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      let item = AttachmentPreviewItem(url: url, title: title.isEmpty ? url.lastPathComponent : String(title.prefix(255)))
      guard QLPreviewController.canPreview(item) else {
        throw ExactNativeRefusal("This file type cannot be previewed on this device.")
      }
      guard let host = context.sessionView as? UIView, let presenter = presenter(for: host) else {
        throw ExactNativeRefusal("The attachment preview needs an active app window.")
      }
      let presentation = Presentation(id: id, item: item, reply: reply)
      let controller = presentation.controller
      active = presentation
      controller.dataSource = self
      controller.delegate = self
      controller.onDismiss = { [weak self, weak controller] in
        if let controller { self?.finish(controller) }
      }
      presenter.present(controller, animated: !UIAccessibility.isReduceMotionEnabled) { [self] in
        guard active === presentation else { return }
        presentation.appeared = true
        controller.presentationController?.delegate = self
        if presentation.dismissRequested { dismiss(presentation) }
      }
      controller.presentationController?.delegate = self
    } catch let error as ExactNativeRefusal {
      reply.fail(error.description)
    } catch {
      reply.fail("The attachment file is unavailable.")
    }
  }

  func dismiss(_ request: [String: Any]) throws -> [String: Any] {
    let id = try identity(request)
    guard let active, active.id == id else { return ["dismissed": false] }
    dismiss(active)
    return ["dismissed": true]
  }

  func end() {
    guard let active else { return }
    active.reply?.fail("The attachment preview window closed.")
    active.reply = nil
    active.animated = false
    dismiss(active)
  }

  private func dismiss(_ presentation: Presentation) {
    presentation.dismissRequested = true
    guard presentation.appeared, !presentation.dismissing else { return }
    presentation.dismissing = true
    presentation.controller.dismiss(animated: presentation.animated && !UIAccessibility.isReduceMotionEnabled) { [self] in
      finish(presentation.controller)
    }
  }

  private func finish(_ controller: QLPreviewController) {
    guard let presentation = active, presentation.controller === controller else { return }
    controller.dataSource = nil
    controller.delegate = nil
    controller.presentationController?.delegate = nil
    presentation.controller.onDismiss = nil
    active = nil
    presentation.reply?.send(["presentationId": presentation.id, "status": "dismissed"])
    presentation.reply = nil
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    active?.controller === controller ? 1 : 0
  }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    active!.item
  }

  nonisolated func previewControllerDidDismiss(_ controller: QLPreviewController) {
    MainActor.assumeIsolated { finish(controller) }
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    if let controller = presentationController.presentedViewController as? QLPreviewController { finish(controller) }
  }

  private func identity(_ request: [String: Any]) throws -> String {
    guard let id = request["presentationId"] as? String, !id.isEmpty, id.utf8.count <= 128 else {
      throw ExactNativeRefusal("An attachment presentation identity is required.")
    }
    return id
  }

  private func file(_ path: String) throws -> URL {
    let roots = [("app:/data/composer-attachments/", context.data.appendingPathComponent("composer-attachments", isDirectory: true)),
                 ("app:/cache/attachment-previews/", context.cache.appendingPathComponent("attachment-previews", isDirectory: true))]
    guard let (prefix, root) = roots.first(where: { path.hasPrefix($0.0) }) else {
      throw ExactNativeRefusal("Only an owned attachment file can be previewed.")
    }
    let parts = path.dropFirst(prefix.count).split(separator: "/", omittingEmptySubsequences: false)
    guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\0") && !$0.contains("\\") }) else {
      throw ExactNativeRefusal("The attachment path is invalid.")
    }
    var url = root
    let components = [""] + parts.map(String.init)
    for (index, component) in components.enumerated() {
      if !component.isEmpty { url.appendPathComponent(component) }
      let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey, .isDirectoryKey])
      guard values.isSymbolicLink != true else { throw ExactNativeRefusal("An attachment path cannot contain a symbolic link.") }
      if index == components.count - 1 {
        guard values.isRegularFile == true else { throw ExactNativeRefusal("The attachment is not a file.") }
      } else {
        guard values.isDirectory == true else { throw ExactNativeRefusal("The attachment folder is unavailable.") }
      }
    }
    return url
  }

  private func presenter(for host: UIView) -> UIViewController? {
    guard let window = host.window, window.windowScene?.activationState == .foregroundActive else { return nil }
    var responder: UIResponder? = host
    while responder != nil && !(responder is UIViewController) { responder = responder?.next }
    var controller = responder as? UIViewController ?? window.rootViewController
    while let presented = controller?.presentedViewController { controller = presented }
    guard let controller, controller.viewIfLoaded?.window === window,
          !controller.isBeingDismissed, !controller.isBeingPresented,
          !(controller is UIAlertController), !(controller is UIDocumentPickerViewController),
          !(controller is QLPreviewController) else { return nil }
    return controller
  }
}
