import QuickLook
import UIKit

private enum AttachmentPreviewState: String { case loading, ready, error }

private final class AttachmentPreviewItem: NSObject, QLPreviewItem {
  var previewItemURL: URL?
  let previewItemTitle: String?
  let sourceId: String
  var state: AttachmentPreviewState

  init(url: URL?, title: String, sourceId: String, state: AttachmentPreviewState) {
    previewItemURL = url
    previewItemTitle = title
    self.sourceId = sourceId
    self.state = state
  }
}

private final class AttachmentPreviewController: QLPreviewController {
  var onAppear: (() -> Void)?
  var onDismiss: (() -> Void)?
  private let spinner = UIActivityIndicatorView(style: .large)
  private let failure = UILabel()
  var state = AttachmentPreviewState.ready {
    didSet { if isViewLoaded { showState() } }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    spinner.accessibilityLabel = "Loading image"
    failure.text = "This image could not be loaded."
    failure.textColor = .secondaryLabel
    failure.textAlignment = .center
    failure.numberOfLines = 0
    failure.font = .preferredFont(forTextStyle: .body)
    failure.adjustsFontForContentSizeCategory = true
    for status in [spinner, failure] as [UIView] {
      status.isUserInteractionEnabled = false
      status.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(status)
      NSLayoutConstraint.activate([
        status.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        status.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: 64),
        status.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48),
      ])
    }
    showState()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    view.bringSubviewToFront(spinner)
    view.bringSubviewToFront(failure)
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    onAppear?()
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isBeingDismissed || presentingViewController == nil { onDismiss?() }
  }

  private func showState() {
    if state == .loading { spinner.startAnimating() } else { spinner.stopAnimating() }
    failure.isHidden = state != .error
  }
}

@MainActor
final class AttachmentPreview: NSObject, QLPreviewControllerDataSource,
  QLPreviewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  @MainActor private final class Presentation {
    let id: String
    let items: [AttachmentPreviewItem]
    let imageGallery: Bool
    let controller = AttachmentPreviewController()
    var selectedIndex: Int
    var staleIndices = Set<Int>()
    var selectionObservation: NSKeyValueObservation?
    var reply: ExactReply?
    var appeared = false
    var dismissRequested = false
    var dismissing = false
    var endRequested = false
    var animated = true

    init(id: String, items: [AttachmentPreviewItem], selectedIndex: Int, imageGallery: Bool, reply: ExactReply) {
      self.id = id
      self.items = items
      self.selectedIndex = selectedIndex
      self.imageGallery = imageGallery
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
      guard let entries = request["items"] as? [[String: Any]], !entries.isEmpty, entries.count <= 100,
            let selectedIndex = request["selectedIndex"] as? Int, entries.indices.contains(selectedIndex),
            let imageGallery = request["imageGallery"] as? Bool,
            imageGallery || entries.count == 1 else {
        throw ExactNativeRefusal("A preview requires its files and a selected page.")
      }
      let items = try entries.map { entry in
        let (url, state) = try content(entry, imageGallery: imageGallery)
        let title = (entry["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return AttachmentPreviewItem(url: url, title: title.isEmpty ? (url?.lastPathComponent ?? "Preview") : String(title.prefix(255)),
                                     sourceId: entry["sourceId"] as? String ?? "", state: state)
      }
      guard let host = context.sessionView as? UIView, let presenter = presenter(for: host) else {
        throw ExactNativeRefusal("The attachment preview needs an active app window.")
      }
      let presentation = Presentation(id: id, items: items, selectedIndex: selectedIndex, imageGallery: imageGallery, reply: reply)
      let controller = presentation.controller
      active = presentation
      controller.dataSource = self
      controller.delegate = self
      controller.currentPreviewItemIndex = selectedIndex
      controller.state = items[selectedIndex].state
      presentation.selectionObservation = controller.observe(\.currentPreviewItemIndex) { [weak self, weak controller] _, _ in
        DispatchQueue.main.async {
          if let controller { self?.selectionChanged(controller) }
        }
      }
      controller.onAppear = { [weak self, weak presentation] in
        if let presentation {
          presentation.appeared = true
          self?.resumeDismissal(presentation)
        }
      }
      controller.onDismiss = { [weak self, weak controller] in
        if let controller { self?.finish(controller) }
      }
      presenter.present(controller, animated: !UIAccessibility.isReduceMotionEnabled) { [self] in
        guard active === presentation else { return }
        presentation.appeared = true
        controller.presentationController?.delegate = self
        resumeDismissal(presentation)
      }
      controller.presentationController?.delegate = self
      context.changed("attachment-preview")
    } catch let error as ExactNativeRefusal {
      reply.fail(error.description)
    } catch {
      reply.fail("The attachment file is unavailable.")
    }
  }

  func update(_ request: [String: Any]) throws -> [String: Any] {
    let id = try identity(request)
    guard let active, active.id == id, !active.dismissRequested else { return ["updated": false] }
    guard let index = request["index"] as? Int, active.items.indices.contains(index) else {
      throw ExactNativeRefusal("The attachment preview page is invalid.")
    }
    let (url, state) = try content(request, imageGallery: active.imageGallery)
    let item = active.items[index]
    guard item.previewItemURL != url || item.state != state else { return ["updated": true] }
    item.previewItemURL = url
    item.state = state
    if active.controller.currentPreviewItemIndex == index {
      active.controller.refreshCurrentPreviewItem()
      active.controller.state = state
    } else {
      active.staleIndices.insert(index)
    }
    return ["updated": true]
  }

  func selection(_ request: [String: Any]) throws -> [String: Any] {
    let id = try identity(request)
    guard let active, active.id == id, !active.dismissRequested else { return ["selectedIndex": -1] }
    return ["selectedIndex": active.controller.currentPreviewItemIndex]
  }

  func dismiss(_ request: [String: Any]) throws -> [String: Any] {
    let id = try identity(request)
    guard let active, active.id == id else { return ["dismissed": false] }
    dismiss(active)
    return ["dismissed": true]
  }

  func end() {
    guard let active else { return }
    active.endRequested = true
    active.animated = false
    dismiss(active)
  }

  private func dismiss(_ presentation: Presentation) {
    presentation.dismissRequested = true
    guard presentation.appeared, !presentation.dismissing,
          !presentation.controller.isBeingPresented, !presentation.controller.isBeingDismissed else { return }
    presentation.dismissing = true
    presentation.controller.dismiss(animated: presentation.animated && !UIAccessibility.isReduceMotionEnabled) { [self] in
      finish(presentation.controller)
    }
  }

  private func resumeDismissal(_ presentation: Presentation) {
    DispatchQueue.main.async { [weak self, weak presentation] in
      guard let self, let presentation, self.active === presentation, presentation.dismissRequested else { return }
      self.dismiss(presentation)
    }
  }

  private func selectionChanged(_ controller: AttachmentPreviewController) {
    guard let active, active.controller === controller, !active.dismissRequested,
          active.items.indices.contains(controller.currentPreviewItemIndex) else { return }
    let index = controller.currentPreviewItemIndex
    if active.staleIndices.remove(index) != nil { controller.refreshCurrentPreviewItem() }
    controller.state = active.items[index].state
    if active.selectedIndex != index {
      active.selectedIndex = index
      context.changed("attachment-preview")
    }
  }

  private func finish(_ controller: QLPreviewController) {
    guard let presentation = active, presentation.controller === controller else { return }
    controller.dataSource = nil
    controller.delegate = nil
    controller.presentationController?.delegate = nil
    presentation.selectionObservation?.invalidate()
    presentation.selectionObservation = nil
    presentation.controller.onAppear = nil
    presentation.controller.onDismiss = nil
    active = nil
    let reply = presentation.reply
    presentation.reply = nil
    if presentation.endRequested {
      reply?.fail("The attachment preview window closed.")
    } else {
      reply?.send(["presentationId": presentation.id, "status": "dismissed"])
    }
    context.changed("attachment-preview")
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    active?.controller === controller ? active!.items.count : 0
  }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    active!.items[index]
  }

  nonisolated func previewController(_ controller: QLPreviewController, transitionViewFor item: QLPreviewItem) -> UIView? {
    MainActor.assumeIsolated { sourceView(for: item, controller: controller) }
  }

  nonisolated func previewController(_ controller: QLPreviewController, frameFor item: QLPreviewItem,
                                    inSourceView view: AutoreleasingUnsafeMutablePointer<UIView?>) -> CGRect {
    MainActor.assumeIsolated {
      guard let source = sourceView(for: item, controller: controller) else { return .zero }
      view.pointee = source
      return source.bounds
    }
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

  private func content(_ request: [String: Any], imageGallery: Bool) throws -> (URL?, AttachmentPreviewState) {
    guard let value = request["state"] as? String, let state = AttachmentPreviewState(rawValue: value),
          let path = request["path"] as? String, state == .ready || (imageGallery && path.isEmpty) else {
      throw ExactNativeRefusal("A preview page requires a local file or an image loading state.")
    }
    guard state == .ready else { return (nil, state) }
    let url = try file(path)
    guard QLPreviewController.canPreview(url as NSURL) else {
      throw ExactNativeRefusal("This file type cannot be previewed on this device.")
    }
    return (url, state)
  }

  private func sourceView(for item: QLPreviewItem, controller: QLPreviewController) -> UIView? {
    guard !UIAccessibility.isReduceMotionEnabled, let active, active.controller === controller,
          let sourceId = active.items.first(where: { $0 === item })?.sourceId, !sourceId.isEmpty,
          let host = context.sessionView as? UIView, let window = host.window else { return nil }
    var candidates = [host]
    while let candidate = candidates.popLast() {
      guard !candidate.isHidden, candidate.alpha > 0.01 else { continue }
      if candidate.accessibilityIdentifier == sourceId {
        var visible = candidate.convert(candidate.bounds, to: window).intersection(window.bounds)
        var ancestor: UIView? = candidate
        while let view = ancestor {
          if view.isHidden || view.alpha <= 0.01 { visible = .null; break }
          if view.clipsToBounds { visible = visible.intersection(view.convert(view.bounds, to: window)) }
          ancestor = view.superview
        }
        if !visible.isEmpty { return candidate }
      }
      candidates.append(contentsOf: candidate.subviews.reversed())
    }
    return nil
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
