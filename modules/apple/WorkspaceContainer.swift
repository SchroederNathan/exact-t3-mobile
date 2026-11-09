import UIKit

final class WorkspaceContainer: UITabBarController, UITabBarControllerDelegate {
  private let contents: ExactTabContents
  private var groups: [[Int]] = []
  private var stacks: [UIViewController] = []
  private var selectedInGroup: [Int: Int] = [:]
  private var hasHinge = false

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
        split.tabBarItem = contents.tabs[index].item
        groups.append([index, detailIndex])
        stacks.append(split)
      } else {
        groups.append([index])
        stacks.append(primary)
      }
    }
    delegate = self
    setViewControllers(stacks, animated: false)
    contents.onSelect = { [weak self] _ in self?.showSelection() }
    showSelection()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  override func viewDidLoad() {
    super.viewDidLoad()
    tabBar.tintColor = UIColor { $0.userInterfaceStyle == .dark
      ? UIColor(red: 52 / 255, green: 107 / 255, blue: 241 / 255, alpha: 1)
      : UIColor(red: 27 / 255, green: 78 / 255, blue: 216 / 255, alpha: 1) }
    updateTabVisibility()
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      view.addInteraction(UIHingeInteraction { [weak self] _, update in
        guard let self, update.hinge != nil, !self.hasHinge else { return }
        self.hasHinge = true
        self.updateTabVisibility()
      })
    }
    #endif
  }

  private func updateTabVisibility() {
    if #available(iOS 18.0, *) { setTabBarHidden(!hasHinge, animated: false) }
    else { tabBar.isHidden = true }
  }

  private func showSelection() {
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

private final class WorkspaceColumnPair: UIViewController {
  private let primary: UINavigationController
  private let secondary: UINavigationController
  private let split = UISplitViewController(style: .doubleColumn)
  private var showingSplit: Bool?
  private weak var compactStack: UINavigationController?
  var detailSelected = false {
    didSet { if isViewLoaded { updateColumns() } }
  }

  init(primary: UINavigationController, secondary: UINavigationController) {
    self.primary = primary
    self.secondary = secondary
    super.init(nibName: nil, bundle: nil)
    split.preferredDisplayMode = .oneBesideSecondary
    split.preferredSplitBehavior = .tile
    split.minimumPrimaryColumnWidth = 280
    split.maximumPrimaryColumnWidth = 320
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
    children.forEach { $0.view.frame = view.bounds }
  }

  private func updateColumns() {
    let wide = traitCollection.horizontalSizeClass == .regular
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
