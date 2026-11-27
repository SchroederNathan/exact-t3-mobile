import Charts
import SwiftUI
import UIKit

private struct UsageChartPeriod: Decodable, Identifiable, Equatable {
  struct Segment: Decodable, Equatable {
    let provider: String
    let cost: Double
    let tokens: Double
  }
  let id: String
  let label: String
  let segments: [Segment]
}

private final class UsagePlotModel: ObservableObject {
  @Published var periods: [UsageChartPeriod] = []
  @Published var showsCost = true
}

private struct UsagePlot: View {
  @ObservedObject var model: UsagePlotModel
  @Environment(\.colorScheme) var scheme
  @Environment(\.accessibilityReduceMotion) var reduceMotion

  private func color(_ provider: String) -> Color {
    let hex: Int
    switch provider {
    case "codex": hex = scheme == .dark ? 0xe6e6e6 : 0x3c3c43
    case "claude": hex = 0xd97757
    case "grok": hex = scheme == .dark ? 0xa1a1aa : 0x52525b
    case "cursor": hex = 0x8b8b8b
    case "opencode": hex = 0x5b9bbd
    case "antigravity": hex = 0x8c7bd1
    case "pi": hex = 0x4d9f8a
    case "muse": hex = 0x0866ff
    default: return .secondary
    }
    return Color(red: Double(hex >> 16) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
  }

  var body: some View {
    Chart(model.periods) { period in
      ForEach(period.segments, id: \.provider) { segment in
        let amount = model.showsCost ? segment.cost : segment.tokens
        BarMark(x: .value("Period", period.id), y: .value(model.showsCost ? "Cost" : "Tokens", amount))
          .foregroundStyle(color(segment.provider))
          .cornerRadius(2)
          .accessibilityLabel("\(period.label), \(segment.provider)")
          .accessibilityValue(model.showsCost ? amount.formatted(.currency(code: "USD")) : "\(amount.formatted()) tokens")
      }
    }
    .chartXScale(domain: model.periods.map(\.id))
    .chartXAxis(.hidden)
    .chartYAxis(.hidden)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: model.showsCost)
  }
}

final class UsageChartInstance: ExactNativeInstance {
  private let model = UsagePlotModel()
  private lazy var content = MainActor.assumeIsolated { [model] in
    UIHostingConfiguration { UsagePlot(model: model) }.margins(.all, 0).makeContentView()
  }
  private var series: String?

  init(props: [String: String], events: ExactNativeEvents) throws {
    super.init(events: events)
    try setProps(props)
  }

  override var view: ExactNativeView { content }

  override func setProps(_ props: [String: String]) throws {
    let next = props["series"] ?? "[]"
    if series != next {
      model.periods = try JSONDecoder().decode([UsageChartPeriod].self, from: Data(next.utf8))
      series = next
    }
    let cost = props["metric"] == "Cost"
    if model.showsCost != cost { model.showsCost = cost }
  }
}
