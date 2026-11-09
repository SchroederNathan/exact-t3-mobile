import UIKit

final class WorkspaceContainer: UITabBarController, UITabBarControllerDelegate {
  private let contents: ExactTabContents
  private var groups: [[Int]] = []
  private var stacks: [UIViewController] = []
  private var selectedInGroup: [Int: Int] = [:]
  private var hasHinge = false
  private var preparedSecondary: Set<Int> = []
  private var pendingSecondary: (detail: Int, restore: Int)?

  static func make(_ contents: ExactTabContents) -> WorkspaceContainer? {
    let names = Set(contents.tabs.map { $0.name.replacingOccurrences(of: "panel-", with: "") })
    guard names.isSuperset(of: ["threads", "threadDetail", "settings", "settingsDetail"]) else { return nil }
    return WorkspaceContainer(contents)
  }

  private init(_ contents: ExactTabContents) {
    self.contents = contents
    super.init(nibName: nil, bundle: nil)
    let names = contents.tabs.map { $0.name.replacingOccurrences(of: "panel-", with: "") }
    let detailNames = ["threads": "threadDetail", "settings": "settingsDetail"]
    for (index, name) in names.enumerated() where !detailNames.values.contains(name) {
      let primary = contents.tabs[index].controller
      if let detailName = detailNames[name], let detailIndex = names.firstIndex(of: detailName) {
        let split = WorkspaceColumnPair(primary: primary, secondary: contents.tabs[detailIndex].controller)
        split.tabBarItem = nativeTabItem(name: name, tag: index)
        let group = groups.count
        split.onNeedsSecondary = { [weak self] in self?.prepareSecondary(group) }
        groups.append([index, detailIndex])
        stacks.append(split)
      } else {
        let column = WorkspaceSingleColumn(primary)
        column.tabBarItem = nativeTabItem(name: name, tag: index)
        groups.append([index])
        stacks.append(column)
      }
    }
    delegate = self
    if #available(iOS 18.0, *) { mode = .tabBar }
    if #available(iOS 26.0, *) { tabBarMinimizeBehavior = .never }
    contents.onSelect = { [weak self] _ in self?.showSelection() }
    setViewControllers(stacks, animated: false)
    showSelection()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  override func viewDidLoad() {
    super.viewDidLoad()
    tabBar.tintColor = UIColor { $0.userInterfaceStyle == .dark
      ? UIColor(red: 52 / 255, green: 107 / 255, blue: 241 / 255, alpha: 1)
      : UIColor(red: 27 / 255, green: 78 / 255, blue: 216 / 255, alpha: 1) }
    view.tintColor = tabBar.tintColor
    updateTabVisibility()
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      view.addInteraction(UIHingeInteraction { [weak self] _, update in
        guard let self, update.hinge != nil, !self.hasHinge else { return }
        self.hasHinge = true
        self.stacks.compactMap { $0 as? WorkspaceColumnPair }.forEach { $0.setHingeWide(true) }
        self.updateTabVisibility()
      })
    }
    #endif
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let wide = view.bounds.width >= 600 || (view.window?.bounds.width ?? 0) >= 600 || tabBar.bounds.height > tabBar.bounds.width
    stacks.compactMap { $0 as? WorkspaceColumnPair }.forEach { $0.setHingeWide(wide) }
    updateTabVisibility()
  }

  private func nativeTabItem(name: String, tag: Int) -> UITabBarItem {
    let labels = ["threads": "Chats", "pullRequests": "PRs", "usage": "Usage", "settings": "Settings"]
    let symbols = ["threads": "text.bubble", "usage": "chart.bar.xaxis", "settings": "gearshape"]
    let image: UIImage?
    if name == "pullRequests" {
      let url = Bundle.main.bundleURL.appendingPathComponent("assets/pull-request.png")
      image = (try? Data(contentsOf: url)).flatMap { UIImage(data: $0, scale: 3) }?.withRenderingMode(.alwaysTemplate)
    } else {
      image = UIImage(systemName: symbols[name] ?? "circle")
    }
    let item = UITabBarItem(title: "", image: image, tag: tag)
    item.accessibilityLabel = labels[name] ?? name
    item.accessibilityIdentifier = "workspace-tab-\(name)"
    if name == "threads" { item.selectedImage = UIImage(systemName: "text.bubble.fill") }
    return item
  }

  private func updateTabVisibility() {
    // Hiding before attachment leaves UIKit's children with the visible bar's safe area.
    guard viewIfLoaded?.window != nil else { return }
    if #available(iOS 18.0, *) {
      if isTabBarHidden == hasHinge { setTabBarHidden(!hasHinge, animated: false) }
    } else if !tabBar.isHidden {
      tabBar.isHidden = true
    }
  }

  private func prepareSecondary(_ group: Int) {
    guard pendingSecondary == nil, !preparedSecondary.contains(group),
          groups.indices.contains(group), groups[group].count == 2,
          groups[group].first == contents.selected else { return }
    let detail = groups[group][1]
    preparedSecondary.insert(group)
    pendingSecondary = (detail, contents.selected)
    contents.select(detail)
  }

  private func showSelection() {
    if let pending = pendingSecondary {
      pendingSecondary = nil
      if contents.selected == pending.detail {
        contents.select(pending.restore)
        return
      }
    }
    guard let group = groups.firstIndex(where: { $0.contains(contents.selected) }) else { return }
    selectedInGroup[group] = contents.selected
    if let pair = stacks[group] as? WorkspaceColumnPair {
      pair.detailSelected = groups[group].last == contents.selected
    }
    selectedIndex = group
  }

  func tabBarController(_ tabBarController: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
    guard let group = stacks.firstIndex(where: { $0 === viewController }), let primary = groups[group].first else { return false }
    contents.select(group == selectedIndex ? primary : selectedInGroup[group] ?? primary)
    return false
  }
}

private final class WorkspaceSingleColumn: UIViewController {
  private let stack: UINavigationController

  init(_ stack: UINavigationController) {
    self.stack = stack
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  override func viewDidLoad() {
    super.viewDidLoad()
    addChild(stack)
    stack.view.frame = view.bounds
    stack.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(stack.view)
    stack.didMove(toParent: self)
  }
}

private final class WorkspaceColumnPair: UIViewController {
  private let primary: UINavigationController
  private let secondary: UINavigationController
  private let split = UISplitViewController(style: .doubleColumn)
  private var showingSplit: Bool?
  private var hingeWide = false
  private weak var compactStack: UINavigationController?
  var onNeedsSecondary: (() -> Void)?
  var detailSelected = false {
    didSet { if isViewLoaded { updateColumns() } }
  }

  func setHingeWide(_ value: Bool) {
    guard hingeWide != value else { return }
    hingeWide = value
    if isViewLoaded { updateColumns() }
  }

  init(primary: UINavigationController, secondary: UINavigationController) {
    self.primary = primary
    self.secondary = secondary
    super.init(nibName: nil, bundle: nil)
    split.preferredDisplayMode = .oneBesideSecondary
    split.preferredSplitBehavior = .tile
    split.displayModeButtonVisibility = .never
    split.minimumPrimaryColumnWidth = 280
    split.maximumPrimaryColumnWidth = 380
    split.preferredPrimaryColumnWidth = 320
    // UIKit's automatic compact collapse would merge the Exact-owned route arrays.
    split.traitOverrides.horizontalSizeClass = .regular
    registerForTraitChanges([UITraitHorizontalSizeClass.self]) { (controller: WorkspaceColumnPair, _: UITraitCollection) in
      if controller.isViewLoaded { controller.updateColumns() }
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  override func viewDidLoad() {
    super.viewDidLoad()
    updateColumns()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    updateColumns()
    if let width = view.window?.bounds.width, width > 0 {
      let sidebarWidth = min(380, max(280, (width * 0.32).rounded()))
      if split.preferredPrimaryColumnWidth != sidebarWidth {
        split.preferredPrimaryColumnWidth = sidebarWidth
      }
    }
    children.forEach { $0.view.frame = view.bounds }
    if showingSplit == true && secondary.viewControllers.isEmpty { onNeedsSecondary?() }
  }

  private func updateColumns() {
    // A pushed Exact route can temporarily report a compact trait from its
    // navigation controller even while the Duo window remains wide. Use the
    // actual canvas width so detail screens stay in the secondary column.
    // Duo lays the hosted controller out in one segment while its window spans
    // both segments. Use the window width so the native split agrees with the
    // Contract's two-segment wide layout.
    let wide = hingeWide || traitCollection.horizontalSizeClass == .regular || max(view.bounds.width, view.window?.bounds.width ?? 0) >= 600
    if showingSplit != wide {
      if showingSplit == true {
        split.setViewController(nil, for: .primary)
        split.setViewController(nil, for: .secondary)
        detach(split)
      } else if let compactStack {
        detach(compactStack)
        self.compactStack = nil
      }
      showingSplit = wide
      if wide {
        split.setViewController(primary, for: .primary)
        split.setViewController(secondary, for: .secondary)
        mount(split)
      }
    }
    if !wide {
      let selected = detailSelected ? secondary : primary
      guard compactStack !== selected else { return }
      if let compactStack { detach(compactStack) }
      compactStack = selected
      mount(selected)
    }
  }

  private func mount(_ controller: UIViewController) {
    addChild(controller)
    controller.view.frame = view.bounds
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(controller.view)
    controller.didMove(toParent: self)
  }

  private func detach(_ controller: UIViewController) {
    controller.willMove(toParent: nil)
    controller.view.removeFromSuperview()
    controller.removeFromParent()
  }
}
