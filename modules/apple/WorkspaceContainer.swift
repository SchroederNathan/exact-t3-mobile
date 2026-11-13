import UIKit

/// The workspace tabs. A list tab and its detail tab share one native tab: side by side in a
/// split view on an unfolded Duo, and the list alone everywhere else.
final class WorkspaceContainer: UITabBarController, UITabBarControllerDelegate {
  private let contents: ExactTabContents
  private var groups: [[Int]] = []
  private var pairs: [WorkspacePair] = []
  private var traits = DeviceTraits(kind: "phone", rail: false, split: false)

  static func make(_ contents: ExactTabContents) -> WorkspaceContainer? {
    let names = contents.tabs.map { $0.name.replacingOccurrences(of: "panel-", with: "") }
    guard Set(names).isSuperset(of: ["threads", "threadDetail", "settings", "settingsDetail"]) else { return nil }
    return WorkspaceContainer(contents, names: names)
  }

  private init(_ contents: ExactTabContents, names: [String]) {
    self.contents = contents
    super.init(nibName: nil, bundle: nil)
    let details = ["threads": "threadDetail", "settings": "settingsDetail"]
    var children: [UIViewController] = []
    for (index, name) in names.enumerated() where !details.values.contains(name) {
      let primary = contents.tabs[index].controller
      let child: UIViewController
      if let detail = details[name].flatMap(names.firstIndex(of:)) {
        let pair = WorkspacePair(primary: primary, secondary: contents.tabs[detail].controller)
        pairs.append(pair)
        groups.append([index, detail])
        child = pair
      } else {
        groups.append([index])
        child = WorkspaceColumn(primary)
      }
      child.tabBarItem = tabItem(name: name, tag: children.count)
      children.append(child)
    }
    delegate = self
    if #available(iOS 18.0, *) { mode = .tabBar }
    if #available(iOS 26.0, *) { tabBarMinimizeBehavior = .never }
    contents.onSelect = { [weak self] _ in self?.showSelection() }
    setViewControllers(children, animated: false)
    showSelection()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  override func viewDidLoad() {
    super.viewDidLoad()
    tabBar.tintColor = UIColor { $0.userInterfaceStyle == .dark
      ? UIColor(red: 52 / 255, green: 107 / 255, blue: 241 / 255, alpha: 1)
      : UIColor(red: 27 / 255, green: 78 / 255, blue: 216 / 255, alpha: 1) }
    view.tintColor = tabBar.tintColor
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    updateTabBar()
  }

  func apply(_ traits: DeviceTraits) {
    self.traits = traits
    pairs.forEach { $0.showsSplit = traits.split }
    updateTabBar()
  }

  /// Only the thread pair has a sidebar toggle; the settings list always shows.
  func setSidebarHidden(_ hidden: Bool) {
    pairs.first?.sidebarHidden = hidden
  }

  private func updateTabBar() {
    // Hiding before attachment leaves UIKit's children with the visible bar's safe area.
    guard viewIfLoaded?.window != nil else { return }
    if #available(iOS 18.0, *) {
      if isTabBarHidden == traits.rail { setTabBarHidden(!traits.rail, animated: false) }
    } else {
      tabBar.isHidden = !traits.rail
    }
  }

  private func tabItem(name: String, tag: Int) -> UITabBarItem {
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

  private func showSelection() {
    guard let group = groups.firstIndex(where: { $0.contains(contents.selected) }) else { return }
    if selectedIndex != group { selectedIndex = group }
  }

  func tabBarController(_ tabBarController: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
    guard let group = viewControllers?.firstIndex(where: { $0 === viewController }), let primary = groups[group].first else { return false }
    // The router owns selection: press the authored tab and follow its answer.
    contents.select(primary)
    return false
  }
}

private final class WorkspaceColumn: UIViewController {
  private let stack: UIViewController

  init(_ stack: UIViewController) {
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

private final class WorkspacePair: UIViewController {
  private let primary: UIViewController
  private let secondary: UIViewController
  private let split = UISplitViewController(style: .doubleColumn)
  private var mounted: UIViewController?
  var showsSplit = false {
    didSet { if showsSplit != oldValue, isViewLoaded { updateColumns() } }
  }
  var sidebarHidden = false {
    didSet { if sidebarHidden != oldValue { updateDisplayMode() } }
  }

  init(primary: UIViewController, secondary: UIViewController) {
    self.primary = primary
    self.secondary = secondary
    super.init(nibName: nil, bundle: nil)
    split.preferredSplitBehavior = .tile
    split.displayModeButtonVisibility = .never
    split.presentsWithGesture = false
    // UIKit's own collapse would merge the two Exact-owned route stacks into one.
    split.traitOverrides.horizontalSizeClass = .regular
    updateDisplayMode()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  override func viewDidLoad() {
    super.viewDidLoad()
    updateColumns()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let width = min(380, max(280, (view.bounds.width * 0.32).rounded()))
    guard split.preferredPrimaryColumnWidth != width else { return }
    // UIKit keeps its automatic fraction unless both edges agree with the preference.
    split.minimumPrimaryColumnWidth = width
    split.maximumPrimaryColumnWidth = width
    split.preferredPrimaryColumnWidth = width
  }

  private func updateDisplayMode() {
    split.preferredDisplayMode = sidebarHidden ? .secondaryOnly : .oneBesideSecondary
  }

  private func updateColumns() {
    let next: UIViewController = showsSplit ? split : primary
    guard mounted !== next else { return }
    if let mounted {
      if mounted === split {
        split.setViewController(nil, for: .primary)
        split.setViewController(nil, for: .secondary)
      }
      mounted.willMove(toParent: nil)
      mounted.view.removeFromSuperview()
      mounted.removeFromParent()
    }
    if showsSplit {
      split.setViewController(primary, for: .primary)
      split.setViewController(secondary, for: .secondary)
    }
    // The list's search toolbar follows its top route; a route moved between stacks left it hidden.
    let toolbarItems = (primary as? UINavigationController)?.topViewController?.toolbarItems
    (primary as? UINavigationController)?.setToolbarHidden(toolbarItems?.isEmpty ?? true, animated: false)
    mounted = next
    addChild(next)
    next.view.frame = view.bounds
    next.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(next.view)
    next.didMove(toParent: self)
  }
}
