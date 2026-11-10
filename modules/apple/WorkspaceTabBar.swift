import UIKit

private final class WorkspaceTabBar: UITabBar {
  var onContentLayout: ((CGRect) -> Void)?

  override func layoutSubviews() {
    super.layoutSubviews()
    // iOS 26.6 doesn't copy item identifiers onto its tab buttons; the bar holds no other controls.
    let identified = tabButtons(in: self) { $0.accessibilityIdentifier?.hasPrefix("workspace-tab-") == true }
    let candidates = identified.isEmpty ? tabButtons(in: self) { _ in true } : identified
    // Pressing a tab adds a magnified copy of the row for the glass lens, without identifiers.
    // Sizing compose from it leaves compose enlarged until the bar lays out again.
    let buttons = candidates.filter { convert($0.bounds, from: $0).size == $0.bounds.size }
    let row = buttons.reduce(CGRect.null) { $0.union(convert($1.bounds, from: $1)) }
    if !row.isNull { onContentLayout?(row) }
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    invalidateIntrinsicContentSize()
  }

  private func tabButtons(in view: UIView, matching match: (UIView) -> Bool) -> [UIView] {
    view.subviews.filter { !$0.isHidden }.flatMap { subview in
      if subview is UIControl, match(subview) { return [subview] }
      return tabButtons(in: subview, matching: match)
    }
  }
}

private final class T3SidebarTabBarView: UIView, UITabBarDelegate {
  var onSelectionChange: ((String) -> Void)?
  var onCompose: (() -> Void)?
  private let tabBar = WorkspaceTabBar()
  private let composeButton = UIButton(type: .system)
  private lazy var tabBarTrailing = tabBar.trailingAnchor.constraint(equalTo: trailingAnchor)
  private var itemsByTab: [String: UITabBarItem] = [:]
  var tabs = ["threads", "pullRequests", "usage", "settings"] {
    didSet { if tabs != oldValue { updateItems() } }
  }
  var selectedTab = "threads" { didSet { updateSelection() } }
  var selectedColor: UIColor = .systemBlue { didSet { tabBar.tintColor = selectedColor } }
  var compact = false {
    didSet {
      tabBarTrailing.constant = showsCompose ? (compact ? -64 : -76) : 0
      tabBar.setNeedsLayout()
    }
  }
  var showsCompose = false {
    didSet {
      composeButton.isHidden = !showsCompose
      tabBarTrailing.constant = showsCompose ? (compact ? -64 : -76) : 0
      setNeedsLayout()
    }
  }
  var appearance = "system" {
    didSet {
      switch appearance {
      case "dark": overrideUserInterfaceStyle = .dark
      case "light": overrideUserInterfaceStyle = .light
      default: overrideUserInterfaceStyle = .unspecified
      }
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    tabBar.itemPositioning = .fill
    // iPad's regular bar uses a compressed inline row even with fill positioning.
    // This floating sidebar control needs the same full-size items as a phone bar.
    if #available(iOS 17.0, *) {
      tabBar.traitOverrides.horizontalSizeClass = .compact
    }
    tabBar.delegate = self
    tabBar.translatesAutoresizingMaskIntoConstraints = false
    addSubview(tabBar)
    NSLayoutConstraint.activate([
      tabBar.leadingAnchor.constraint(equalTo: leadingAnchor),
      tabBarTrailing,
      tabBar.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    // UIKit's floating row changes with window geometry. Follow its laid-out items
    // instead of estimating their position from a second set of safe-area updates.
    tabBar.onContentLayout = { [weak self] frame in self?.layoutCompose(alongside: frame) }
    composeButton.accessibilityLabel = "New chat"
    composeButton.addAction(UIAction { [weak self] _ in self?.onCompose?() }, for: .touchUpInside)
    composeButton.isHidden = true
    addSubview(composeButton)
    configureCompose()
    prepareItems()
    updateItems()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  private func configureCompose() {
    var configuration: UIButton.Configuration
    if #available(iOS 26.0, *) {
      configuration = .glass()
    } else {
      configuration = .gray()
    }
    configuration.cornerStyle = .capsule
    configuration.baseForegroundColor = .label
    configuration.image = tabIcon(UIImage(systemName: "square.and.pencil"))
    composeButton.configuration = configuration
  }

  private func prepareItems() {
    let iconPath = Bundle.main.bundleURL.appendingPathComponent("assets/pull-request.png").path
    let pullRequestIcon = UIImage(contentsOfFile: iconPath)?.withRenderingMode(.alwaysTemplate)
    let labels = ["threads": "Chats", "pullRequests": "PRs", "usage": "Usage", "settings": "Settings"]
    let symbols = ["threads": "text.bubble", "usage": "chart.bar.xaxis", "settings": "gearshape"]
    for (tab, label) in labels {
      let icon = tab == "pullRequests" ? pullRequestIcon : UIImage(systemName: symbols[tab] ?? "circle")
      let item = UITabBarItem(title: nil, image: tabIcon(icon), tag: 0)
      item.accessibilityLabel = label
      item.accessibilityIdentifier = "workspace-tab-\(tab)"
      if tab == "threads" { item.selectedImage = tabIcon(UIImage(systemName: "text.bubble.fill")) }
      itemsByTab[tab] = item
    }
  }

  private func updateItems() {
    tabBar.items = tabs.enumerated().compactMap { index, tab in
      guard let item = itemsByTab[tab] else { return nil }
      item.tag = index
      return item
    }
    updateSelection()
  }

  private func layoutCompose(alongside frame: CGRect) {
    guard showsCompose, frame.height > 0 else { return }
    let row = convert(frame, from: tabBar)
    let size = row.height + 8
    composeButton.frame = CGRect(x: row.maxX + 16, y: row.midY - size / 2, width: size, height: size)
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    if showsCompose, let target = composeButton.hitTest(convert(point, to: composeButton), with: event) {
      return target
    }
    return tabBar.hitTest(convert(point, to: tabBar), with: event)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updateSelection()
  }

  // UIKit scales symbols independently unless bitmap assets and symbols share an image box.
  private func tabIcon(_ image: UIImage?) -> UIImage? {
    guard let image else { return nil }
    let canvas = CGSize(width: 28, height: 28)
    let scale = min(24 / image.size.width, 24 / image.size.height)
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    return UIGraphicsImageRenderer(size: canvas).image { _ in
      image.draw(in: CGRect(x: (canvas.width - size.width) / 2, y: (canvas.height - size.height) / 2, width: size.width, height: size.height))
    }.withRenderingMode(.alwaysTemplate)
  }

  private func updateSelection() {
    guard let item = itemsByTab[selectedTab], tabBar.items?.contains(item) == true else { return }
    guard tabBar.selectedItem !== item else { return }
    tabBar.selectedItem = item
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    guard tabs.indices.contains(item.tag) else { return }
    onSelectionChange?(tabs[item.tag])
  }
}

final class T3NativeModule: ExactModule {
  private var probe: DeviceProbe?
  private var device = DeviceTraits(kind: "phone", rail: false, split: false)
  private weak var container: WorkspaceContainer?
  private lazy var connections = WorkspaceConnections { [weak self] in
    self?.context.changed("connections")
  }

  override func call(_ request: [String: Any]) throws -> [String: Any] {
    if (request["op"] as? String)?.hasPrefix("connections.") == true {
      return try connections.call(request)
    }
    guard request["op"] as? String == "device" else { throw ExactNativeRefusal("t3 answers device") }
    return ["kind": device.kind, "rail": device.rail, "split": device.split]
  }

  override func destroy() {
    connections.destroy()
  }

  override func later(_ request: [String: Any], reply: ExactReply) {
    connections.later(request, reply: reply)
  }

  private let toolbarFollower = ToolbarFollower()

  override func navigation(_ navigation: ExactNavigation) {
    MainActor.assumeIsolated { navigation.delegate = toolbarFollower }
  }

  override func tabContainer(_ contents: ExactTabContents) -> UIViewController? {
    MainActor.assumeIsolated {
      let container = WorkspaceContainer.make(contents)
      container?.apply(device)
      self.container = container
      return container
    }
  }

  override func window(_ window: ExactWindow) {
    MainActor.assumeIsolated {
      guard let host = context.sessionView as? UIView else { return }
      if probe?.superview !== host {
        probe?.removeFromSuperview()
        let probe = DeviceProbe { [weak self] traits in
          guard let self, self.device != traits else { return }
          self.device = traits
          self.container?.apply(traits)
          self.context.changed("device")
        }
        host.addSubview(probe)
        self.probe = probe
        window.owns(view: probe, "device probe: hinge and vertical bar edge")
      }
      probe?.publish()
    }
  }

  override func windowEnded(_ window: ExactWindow) {
    MainActor.assumeIsolated {
      probe?.removeFromSuperview()
      probe = nil
    }
  }

  override func route(_ route: ExactRoute) {
    MainActor.assumeIsolated {
      let item = route.controller.navigationItem
      let style = route.data[.workspaceHeader]
      configureWorkspacePageTitle(item, bar: route.controller.navigationController?.navigationBar)
      item.backButtonDisplayMode = .minimal
      item.hidesBackButton = route.data[.hidesBack] == "true"
      if let sidebar = route.data[.sidebar] { container?.setSidebarHidden(sidebar == "hidden") }
      #if canImport(UIKit, _version: 9127.0.85)
      if #available(iOS 27.1, *), style != "settings-sheet" {
        // Leading items belong to their own column; only trailing items move to the Duo rail.
        item.leftBarButtonItems?.forEach { $0.axisBehavior = .horizontalOnly }
      }
      #endif
      guard style == "brand" || style == "editor" || style == "settings-sheet" else { return }
      if style == "settings-sheet" {
        item.rightBarButtonItems?.first { $0.accessibilityIdentifier == "save-settings" }?.tintColor = UIColor {
          $0.userInterfaceStyle == .dark
            ? UIColor(white: 245 / 255, alpha: 1)
            : UIColor(red: 39 / 255, green: 39 / 255, blue: 42 / 255, alpha: 1)
        }
      }
      if style != "settings-sheet" {
        item.style = .editor
        if #available(iOS 27.2, *) { item.titleAlignment = .leading }
      }
      guard style != "editor" else { return }
      if style == "brand" {
        let title = item.titleView as? WorkspaceBrandTitleView ?? WorkspaceBrandTitleView(frame: .zero)
        let searchButtonCount = item.searchController != nil && route.data[.searchPlacement] != "integrated" ? 1 : 0
        let itemCount = (item.leftBarButtonItems?.count ?? 0) + (item.rightBarButtonItems?.count ?? 0) + searchButtonCount
        title.preferredWidth = max(120, route.controller.view.bounds.width - 32 - CGFloat(itemCount) * 44)
        title.frame = CGRect(origin: .zero, size: title.intrinsicContentSize)
        title.stageName = route.data[.brandStage] ?? "DEV"
        item.titleView = title
        route.owns(view: title, "T3 wordmark and build-stage title")
      }
      if let search = item.searchController {
        search.hidesNavigationBarDuringPresentation = false
        search.obscuresBackgroundDuringPresentation = false
        search.searchBar.autocapitalizationType = .none
        item.hidesSearchBarWhenScrolling = false
        if #available(iOS 26.0, *) {
          let integrated = route.data[.searchPlacement] == "integrated" || style == "settings-sheet"
          item.preferredSearchBarPlacement = integrated ? .integrated : .integratedButton
          item.searchBarPlacementAllowsToolbarIntegration = integrated
          let placement = item.searchBarPlacementBarButtonItem
          let sheet = style == "settings-sheet"
          let compactSheet = sheet && route.controller.traitCollection.horizontalSizeClass == .compact
          let filterId = "model-filters-button"
          let existing = route.controller.toolbarItems ?? []
          let filter = item.rightBarButtonItems?.first { $0.accessibilityIdentifier == filterId }
            ?? existing.first { $0.accessibilityIdentifier == filterId }
          var toolbar = existing.filter {
            $0 !== placement && $0.accessibilityIdentifier != filterId && $0.accessibilityIdentifier != "settings-search-space"
          }
          if compactSheet {
            if let filter {
              item.rightBarButtonItems = item.rightBarButtonItems?.filter { $0 !== filter }
              toolbar.append(filter)
            }
            if !self.device.rail {
              let space = UIBarButtonItem(barButtonSystemItem: .fixedSpace, target: nil, action: nil)
              space.width = 8
              space.accessibilityIdentifier = "settings-search-space"
              toolbar.append(space)
            }
            toolbar.append(placement)
          } else if sheet {
            if let filter, !(item.rightBarButtonItems ?? []).contains(where: { $0 === filter }) {
              item.rightBarButtonItems = [filter] + (item.rightBarButtonItems ?? [])
            }
          } else if integrated {
            toolbar.append(placement)
          }
          route.controller.toolbarItems = toolbar.isEmpty ? nil : toolbar
          if let navigation = route.navigation?.controller ?? route.controller.navigationController,
             navigation.topViewController == nil || navigation.topViewController === route.controller {
            navigation.setToolbarHidden(toolbar.isEmpty, animated: false)
          }
        }
      } else if #available(iOS 26.0, *), route.controller.toolbarItems != nil {
        route.controller.toolbarItems = nil
        route.navigation?.controller.setToolbarHidden(true, animated: false)
      }
    }
  }
  override class var views: [String: ExactNativeFactory] {
    [
      "workspace-tab-bar": ExactNativeFactory { props, events in
        WorkspaceTabBarInstance(props: props, events: events)
      },
      "workspace-composer-glass": ExactNativeFactory { props, events in
        ComposerGlassInstance(props: props, events: events)
      },
      "workspace-filter-menu": ExactNativeFactory { props, events in
        try WorkspaceFilterMenuInstance(props: props, events: events)
      },
    ]
  }
}

let exactModule: ExactModule.Type = T3NativeModule.self

private final class WorkspaceTabBarInstance: ExactNativeInstance {
  private let bar = T3SidebarTabBarView(frame: .zero)

  init(props: [String: String], events: ExactNativeEvents) {
    super.init(events: events)
    bar.onSelectionChange = { events.message("tab:\($0)") }
    bar.onCompose = { events.message("compose") }
    apply(props)
    events.intrinsicSize(CGSize(width: 402, height: 128))
  }

  override var view: ExactNativeView { bar }

  override func setProps(_ props: [String: String]) throws {
    apply(props)
  }

  private func apply(_ props: [String: String]) {
    bar.selectedTab = props["selected-tab"] ?? "threads"
    bar.compact = props["compact"] == "true"
    bar.showsCompose = props["shows-compose"] == "true"
    bar.appearance = props["appearance"] ?? "system"
    if let hex = props["selected-color"]?.replacingOccurrences(of: "#", with: ""),
       let rgb = UInt32(hex, radix: 16) {
      bar.selectedColor = UIColor(red: CGFloat((rgb >> 16) & 255) / 255,
                                 green: CGFloat((rgb >> 8) & 255) / 255,
                                 blue: CGFloat(rgb & 255) / 255, alpha: 1)
    } else {
      bar.selectedColor = UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 52 / 255, green: 107 / 255, blue: 241 / 255, alpha: 1)
        : UIColor(red: 27 / 255, green: 78 / 255, blue: 216 / 255, alpha: 1) }
    }
  }
}

struct DeviceTraits: Equatable {
  var kind: String
  var rail: Bool
  /// A list and its detail sit side by side: the Expo app's `usesSplitView` on a Duo.
  var split: Bool
}

// Mirrors the Expo app's layout metrics: a hinge marks a Duo, its width class the pose.
private final class DeviceProbe: UIView {
  private let onChange: (DeviceTraits) -> Void
  private var hasHinge = false

  init(onChange: @escaping (DeviceTraits) -> Void) {
    self.onChange = onChange
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    isHidden = true
    isAccessibilityElement = false
    registerForTraitChanges([UITraitHorizontalSizeClass.self]) { (view: DeviceProbe, _: UITraitCollection) in
      view.publish()
    }
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      addInteraction(UIHingeInteraction { [weak self] _, update in
        guard let self, update.hinge != nil, !self.hasHinge else { return }
        self.hasHinge = true
        self.publish()
      })
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) { (view: DeviceProbe, _: UITraitCollection) in
        view.publish()
      }
    }
    #endif
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    publish()
  }

  func publish() {
    guard window != nil else { return }
    var rail = false
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) { rail = traitCollection.verticalBarEdge != .unspecified }
    #endif
    let unfolded = traitCollection.horizontalSizeClass == .regular
    let width = superview?.bounds.width ?? 0
    onChange(DeviceTraits(
      kind: hasHinge ? (unfolded ? "duo-unfolded" : "duo-folded") : "phone",
      rail: rail,
      split: hasHinge && unfolded && width >= 600))
  }
}

/// A stack's bottom toolbar follows the route it shows: the list's search field, nothing elsewhere.
private final class ToolbarFollower: NSObject, UINavigationControllerDelegate {
  func navigationController(_ navigationController: UINavigationController, willShow viewController: UIViewController, animated: Bool) {
    let hidden = viewController.toolbarItems?.isEmpty ?? true
    if navigationController.isToolbarHidden != hidden {
      navigationController.setToolbarHidden(hidden, animated: animated)
    }
  }
}
