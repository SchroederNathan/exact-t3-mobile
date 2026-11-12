import Foundation
import UIKit

// Exact calls and URLSession delegate work share the main queue; completions hop back before state access.
final class WorkspaceConnections: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
  private final class Connection: @unchecked Sendable {
    let id: String
    let generation: Int
    let origin: URL
    var token: String
    var ticket: URLSessionDataTask?
    var socket: URLSessionWebSocketTask?
    var opened = false
    var ended = false
    var receiving = false
    var sending = false
    var recoverable = false
    var recoveryAvailable = false
    var recoveryRequested = false
    var retryAttempt = 0
    var retryAfterLiveLoss = false
    var openedAt: Date?
    var retryWorkItem: DispatchWorkItem?
    var stabilityWorkItem: DispatchWorkItem?
    var probe: UUID?
    var probeTimeout: DispatchWorkItem?
    var outgoing: [String] = []
    var outgoingBytes = 0

    init(id: String, generation: Int, origin: URL, token: String) {
      self.id = id
      self.generation = generation
      self.origin = origin
      self.token = token
    }

    func stop() {
      ended = true
      opened = false
      cancelProbe()
      retryWorkItem?.cancel()
      retryWorkItem = nil
      stabilityWorkItem?.cancel()
      stabilityWorkItem = nil
      ticket?.cancel()
      socket?.cancel(with: .goingAway, reason: nil)
      outgoing.removeAll()
      outgoingBytes = 0
    }

    func cancelProbe() {
      probe = nil
      probeTimeout?.cancel()
      probeTimeout = nil
    }
  }

  private let changed: () -> Void
  private final class Receipt {
    var reply: ExactReply?
    var finished = false
  }
  private var receipts: [String: Receipt] = [:]
  private var connections: [String: Connection] = [:]
  private var events: [[String: Any]] = []
  private var bufferedBytes = 0
  private var session: URLSession?
  private var lifecycleObservers: [NSObjectProtocol] = []
  private var active = true
  private let maximumBytes = 8 * 1024 * 1024

  init(changed: @escaping () -> Void) {
    self.changed = changed
    super.init()
    lifecycleObservers = [
      NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
        self?.becameActive()
      },
      NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
        self?.resignedActive()
      },
    ]
  }

  func call(_ request: [String: Any]) throws -> [String: Any] {
    switch request["op"] as? String {
    case "connections.sync":
      guard let desired = request["connections"] as? [[String: Any]] else {
        throw ExactNativeRefusal("Connections are required.")
      }
      let inputs = try desired.map { entry -> (String, Int, URL, String) in
        guard let id = entry["id"] as? String, !id.isEmpty,
              let generation = entry["generation"] as? Int, generation > 0,
              let text = entry["origin"] as? String,
              let parts = URLComponents(string: text),
              ["http", "https"].contains(parts.scheme ?? ""),
              parts.host?.isEmpty == false, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", let origin = parts.url,
              let token = entry["token"] as? String, !token.isEmpty else {
          throw ExactNativeRefusal("A connection requires an HTTP origin and a pairing credential.")
        }
        return (id, generation, origin, token)
      }
      guard Set(inputs.map { $0.0 }).count == inputs.count else {
        throw ExactNativeRefusal("Each environment must have one connection.")
      }
      let ids = Set(inputs.map { $0.0 })
      for id in Array(connections.keys) where !ids.contains(id) {
        connections.removeValue(forKey: id)?.stop()
      }
      for (id, generation, origin, token) in inputs {
        if let existing = connections[id], existing.generation == generation, existing.origin == origin,
           !existing.recoveryRequested { continue }
        let previous = connections[id]
        let preservingRetry = previous?.recoveryRequested == true
        let delay = preservingRetry ? previous.map(retryDelay(for:)) ?? 0 : 0
        previous?.stop()
        let connection = Connection(id: id, generation: generation, origin: origin, token: token)
        if preservingRetry, let previous {
          // Preserve the backoff across the replacement triggered by a transient
          // failure. Without this, every failed retry starts from zero and can
          // spin the server and battery while the environment is unavailable.
          connection.retryAttempt = previous.retryAttempt
        }
        connection.recoveryAvailable = active
        connections[id] = connection
        connect(connection, delay: delay)
      }
      let drained = events.filter { event in
        guard let id = event["id"] as? String, let generation = event["generation"] as? Int else { return false }
        return connections[id]?.generation == generation
      }
      events.removeAll(keepingCapacity: true)
      bufferedBytes = 0
      for connection in connections.values { receive(connection) }
      return ["events": drained]
    case "connections.send":
      let connection = try connection(request)
      guard connection.opened, !connection.ended, let data = request["data"] as? String else {
        throw ExactNativeRefusal("This environment is disconnected.")
      }
      let bytes = data.utf8.count
      guard bytes <= maximumBytes - connection.outgoingBytes, connection.outgoing.count < 256 else {
        throw ExactNativeRefusal("The connection is busy. Try sending again.")
      }
      connection.outgoing.append(data)
      connection.outgoingBytes += bytes
      send(connection)
      return [:]
    case "connections.close":
      if let connection = try? connection(request) {
        connection.recoveryAvailable = false
        connection.recoveryRequested = false
        connection.recoverable = false
        finish(connection, reason: "Disconnected")
      }
      return [:]
    case "connections.finish":
      let (id, receipt) = try receipt(request)
      if let reply = receipt.reply {
        receipts.removeValue(forKey: id)
        reply.send([:])
      } else {
        receipt.finished = true
      }
      return [:]
    default:
      throw ExactNativeRefusal("Unknown connection operation.")
    }
  }

  func later(_ request: [String: Any], reply: ExactReply) {
    guard request["op"] as? String == "connections.wait" else {
      reply.fail("Unknown connection operation.")
      return
    }
    do {
      let (id, receipt) = try receipt(request)
      if receipt.finished {
        receipts.removeValue(forKey: id)
        reply.send([:])
      } else if receipt.reply == nil {
        receipt.reply = reply
      } else {
        reply.fail("This connection reply is already awaited.")
      }
    } catch {
      reply.fail("Too many connection replies are pending.")
    }
  }

  private func receipt(_ request: [String: Any]) throws -> (String, Receipt) {
    guard let id = request["receipt"] as? String, UUID(uuidString: id) != nil else {
      throw ExactNativeRefusal("A connection reply identity is required.")
    }
    if let receipt = receipts[id] { return (id, receipt) }
    guard receipts.count < 64 else { throw ExactNativeRefusal("Too many connection replies are pending.") }
    let receipt = Receipt()
    receipts[id] = receipt
    return (id, receipt)
  }

  func destroy() {
    lifecycleObservers.forEach(NotificationCenter.default.removeObserver)
    lifecycleObservers.removeAll()
    for receipt in receipts.values { receipt.reply?.fail("The connection session ended.") }
    receipts.removeAll()
    for connection in connections.values { connection.stop() }
    connections.removeAll()
    events.removeAll()
    bufferedBytes = 0
    session?.invalidateAndCancel()
    session = nil
  }

  private func resignedActive() {
    active = false
    for connection in connections.values {
      connection.recoveryAvailable = false
      connection.recoveryRequested = false
      connection.retryWorkItem?.cancel()
      connection.retryWorkItem = nil
      connection.cancelProbe()
    }
  }

  private func becameActive() {
    active = true
    for connection in connections.values {
      connection.recoveryAvailable = true
      if connection.ended {
        if connection.recoverable {
          // Foregrounding is an explicit wakeup. Match the supervisor's
          // wakeup behavior by abandoning stale backoff accumulated while the
          // app was away and trying the environment immediately.
          connection.retryAttempt = 0
          connection.recoveryAvailable = false
          connection.recoveryRequested = true
          changed()
        }
      } else if !connection.opened && connection.ticket == nil && connection.socket == nil {
        // A delayed retry may have been canceled while the app was in the
        // background. Start it now rather than waiting for another sync.
        connection.retryAttempt = 0
        connect(connection)
      } else if connection.opened, let socket = connection.socket {
        connection.cancelProbe()
        let probe = UUID()
        connection.probe = probe
        let timeout = DispatchWorkItem { [weak self, weak connection] in
          guard let self, let connection, self.current(connection), connection.probe == probe else { return }
          self.finish(connection, reason: "The connection did not answer after resuming.", recoverable: true)
        }
        connection.probeTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)
        socket.sendPing { [weak self, weak connection] error in
          DispatchQueue.main.async {
            guard let self, let connection, self.current(connection), connection.probe == probe else { return }
            connection.cancelProbe()
            if let error {
              self.finish(connection, reason: "Disconnected. Reconnect to continue.", recoverable: self.transient(error, socket: socket))
            }
          }
        }
      }
    }
  }

  private func connection(_ request: [String: Any]) throws -> Connection {
    guard let id = request["id"] as? String, let generation = request["generation"] as? Int,
          let connection = connections[id], connection.generation == generation else {
      throw ExactNativeRefusal("This environment is disconnected.")
    }
    return connection
  }

  private func retryDelay(for connection: Connection) -> TimeInterval {
    guard connection.retryAttempt > 0 else { return 0 }
    // A live session gets a quick first retry for brief Wi-Fi or server blips.
    // Initial ticket failures use a one-second base; later failures double up
    // to five minutes. Small jitter keeps several environments from reconnecting
    // in lockstep.
    if connection.retryAfterLiveLoss && connection.retryAttempt == 1 {
      return 0.25 * Double.random(in: 0.5...1.0)
    }
    let ceiling = min(300, 1.0 * pow(2, Double(min(connection.retryAttempt, 18))))
    return ceiling * Double.random(in: 0.5...1.0)
  }

  private func connect(_ connection: Connection, delay: TimeInterval = 0) {
    guard current(connection) else { return }
    let start = DispatchWorkItem { [weak self, weak connection] in
      guard let self, let connection, self.current(connection) else { return }
      connection.retryWorkItem = nil
      self.startTicket(connection)
    }
    connection.retryWorkItem = start
    if delay > 0 {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: start)
    } else {
      start.perform()
    }
  }

  private func startTicket(_ connection: Connection) {
    if session == nil {
      // Keep custom URLProtocol handlers from intercepting the ticket request or
      // WebSocket upgrade. The upstream Expo client uses the same isolation for
      // its native URLSession transport.
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = []
      session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    }
    var request = URLRequest(url: connection.origin.appendingPathComponent("api/auth/websocket-ticket/rpc"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 30
    let task = session!.dataTask(with: request) { [weak self, weak connection] data, response, error in
      DispatchQueue.main.async {
        guard let self, let connection, self.current(connection) else { return }
        connection.ticket = nil
        guard error == nil, let response = response as? HTTPURLResponse,
              response.statusCode == 200, let data, data.count <= 64 * 1024,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ticket = json["ticket"] as? String, !ticket.isEmpty else {
          let reason = (response as? HTTPURLResponse)?.statusCode == 401
            ? "Pairing required" : "Could not connect to the environment."
          let status = (response as? HTTPURLResponse)?.statusCode ?? 0
          self.finish(connection, reason: reason, recoverable: error.map { self.transient($0) } ?? (status == 408 || status == 429 || (500...599).contains(status)))
          return
        }
        var url = URLComponents(url: connection.origin, resolvingAgainstBaseURL: false)!
        url.scheme = url.scheme == "https" ? "wss" : "ws"
        url.path = "/ws"
        url.queryItems = [URLQueryItem(name: "wsTicket", value: ticket), URLQueryItem(name: "orchestrationProtocol", value: "2")]
        let socket = self.session!.webSocketTask(with: url.url!)
        socket.maximumMessageSize = self.maximumBytes
        connection.socket = socket
        socket.resume()
      }
    }
    connection.ticket = task
    task.resume()
  }

  private func current(_ connection: Connection) -> Bool {
    connections[connection.id] === connection && !connection.ended
  }

  private func enqueue(
    _ connection: Connection,
    type: String,
    data: String = "",
    reason: String = "",
    recoverable: Bool = false
  ) {
    let wasEmpty = events.isEmpty
    var event: [String: Any] = [
      "id": connection.id,
      "generation": connection.generation,
      "type": type,
      "data": data,
      "reason": reason,
    ]
    if type == "close" { event["recoverable"] = recoverable }
    events.append(event)
    bufferedBytes += data.utf8.count
    if wasEmpty { changed() }
  }

  private func transientClose(_ code: URLSessionWebSocketTask.CloseCode) -> Bool {
    // Foundation omits names for IANA service-restart, try-again-later, and bad-gateway codes.
    [.goingAway, .noStatusReceived, .abnormalClosure, .internalServerError].contains(code) || [1012, 1013, 1014].contains(code.rawValue)
  }

  private func transient(_ error: Error, socket: URLSessionWebSocketTask? = nil) -> Bool {
    if let socket {
      if let response = socket.response as? HTTPURLResponse, (400...499).contains(response.statusCode) { return false }
      if transientClose(socket.closeCode) { return true }
      if socket.closeCode != .invalid { return false }
    }
    guard let error = error as? URLError else { return false }
    return [.timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
            .dnsLookupFailed, .notConnectedToInternet, .internationalRoamingOff,
            .dataNotAllowed, .backgroundSessionWasDisconnected].contains(error.code)
  }

  private func finish(_ connection: Connection, reason: String, recoverable: Bool = false) {
    guard current(connection) else { return }
    let liveLoss = connection.opened
    connection.stop()
    connection.recoverable = recoverable
    connection.retryAfterLiveLoss = recoverable && liveLoss
    if active && connection.recoveryAvailable && recoverable {
      connection.retryAttempt += 1
      connection.recoveryAvailable = false
      connection.recoveryRequested = true
    }
    enqueue(connection, type: "close", reason: reason, recoverable: recoverable)
  }

  private func receive(_ connection: Connection) {
    guard current(connection), connection.opened, !connection.receiving,
          let socket = connection.socket else { return }
    connection.receiving = true
    socket.receive { [weak self, weak connection] result in
      DispatchQueue.main.async {
        guard let self, let connection, self.current(connection) else { return }
        connection.receiving = false
        if case let .failure(error) = result {
          self.finish(connection, reason: "Disconnected. Reconnect to continue.", recoverable: self.transient(error, socket: socket))
          return
        }
        guard case let .success(message) = result else { return }
        let text: String?
        switch message {
        case .string(let value): text = value
        case .data(let value): text = String(data: value, encoding: .utf8)
        @unknown default: text = nil
        }
        guard let text, text.utf8.count <= self.maximumBytes - self.bufferedBytes else {
          self.finish(connection, reason: "The environment response exceeded this client's buffer.")
          return
        }
        self.enqueue(connection, type: "message", data: text)
        // The next receive begins when sync drains this message, so no protocol frames are dropped.
      }
    }
  }

  private func send(_ connection: Connection) {
    guard current(connection), !connection.sending, let data = connection.outgoing.first,
          let socket = connection.socket else { return }
    connection.sending = true
    socket.send(.string(data)) { [weak self, weak connection] error in
      DispatchQueue.main.async {
        guard let self, let connection, self.current(connection) else { return }
        connection.sending = false
        if let error {
          self.finish(connection, reason: "The connection closed before the message could be sent.", recoverable: self.transient(error, socket: socket))
          return
        }
        connection.outgoing.removeFirst()
        connection.outgoingBytes -= data.utf8.count
        self.send(connection)
      }
    }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    guard let connection = connections.values.first(where: { $0.socket === webSocketTask }), current(connection) else { return }
    connection.opened = true
    connection.retryAfterLiveLoss = false
    let openedAt = Date()
    connection.openedAt = openedAt
    connection.stabilityWorkItem?.cancel()
    let stable = DispatchWorkItem { [weak self, weak connection] in
      guard let self, let connection, self.current(connection), connection.opened,
            connection.openedAt == openedAt else { return }
      connection.retryAttempt = 0
      connection.stabilityWorkItem = nil
    }
    connection.stabilityWorkItem = stable
    DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: stable)
    connection.recoveryAvailable = active
    enqueue(connection, type: "open")
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    guard let connection = connections.values.first(where: { $0.socket === webSocketTask }) else { return }
    finish(connection, reason: "Disconnected. Reconnect to continue.", recoverable: transientClose(closeCode))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let error, let connection = connections.values.first(where: { $0.socket === task }) else { return }
    finish(connection, reason: "Could not connect to the environment.", recoverable: transient(error, socket: connection.socket))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
