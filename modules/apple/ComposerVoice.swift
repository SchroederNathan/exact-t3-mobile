import AVFoundation
import Foundation
import Speech
import UIKit

@MainActor
final class ComposerVoice: NSObject, @preconcurrency AVAudioRecorderDelegate {
  private let context: ExactModuleContext
  private let changed: () -> Void
  private var recorder: AVAudioRecorder?
  private var recordingURL: URL?
  private var operation: Task<Void, Never>?
  private var analysisCancellation: (() -> Void)?
  private var modelPreparation: Task<Locale, Error>?
  private var observers: [NSObjectProtocol] = []
  private var meterTicket: ExactTicket?
  private var lastMeterTime = 0.0
  private var generation = 0
  private var owner = ""
  private var phase = "idle"
  private var error = ""
  private var transcript = ""
  private var elapsed = 0.0
  private var levels = [Double](repeating: 0, count: 48)

  init(context: ExactModuleContext, changed: @escaping () -> Void) {
    self.context = context
    self.changed = changed
    super.init()
    observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue
      if type == AVAudioSession.InterruptionType.began.rawValue { MainActor.assumeIsolated { self?.interrupt("Recording was interrupted. Try recording again.") } }
    })
    observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
      let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
      if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { MainActor.assumeIsolated { self?.interrupt("The microphone disconnected. Try recording again.") } }
    })
    observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.cancel() }
    })
  }

  deinit { observers.forEach(NotificationCenter.default.removeObserver) }

  private var available: Bool {
    if #available(iOS 26.0, *) { return SpeechTranscriber.isAvailable }
    return false
  }

  func call(_ request: [String: Any]) throws -> [String: Any] {
    switch request["op"] as? String {
    case "voice.state": return snapshot()
    case "voice.settings":
      if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
      return snapshot()
    case "voice.cancel":
      if let requestedOwner = request["owner"] as? String, !requestedOwner.isEmpty, requestedOwner != owner { return snapshot() }
      cancel()
      return snapshot()
    default: throw ExactNativeRefusal("Unknown voice input operation.")
    }
  }

  func later(_ request: [String: Any], reply: ExactReply) {
    let requestedOwner = request["owner"] as? String ?? ""
    switch request["op"] as? String {
    case "voice.start": start(owner: requestedOwner, reply: reply)
    case "voice.confirm":
      guard owner == requestedOwner, phase == "recording" else { reply.send(snapshot()); return }
      confirm(reply: reply)
    default: reply.fail("Unknown voice input operation.")
    }
  }

  func cancel() {
    generation += 1
    operation?.cancel()
    operation = nil
    modelPreparation?.cancel()
    modelPreparation = nil
    analysisCancellation?()
    analysisCancellation = nil
    releaseAudio()
    removeRecording()
    owner = ""
    phase = "idle"
    error = ""
    transcript = ""
    elapsed = 0
    levels = [Double](repeating: 0, count: 48)
    changed()
  }

  private func snapshot() -> [String: Any] {
    ["available": available, "owner": owner, "phase": phase, "error": error,
     "transcript": transcript, "elapsed": elapsed, "levels": levels]
  }

  private func start(owner: String, reply: ExactReply) {
    cancel()
    self.owner = owner
    guard available else {
      phase = "error"
      error = "Voice input requires on-device transcription on iOS 26 or later."
      changed()
      reply.send(snapshot())
      return
    }
    let requestGeneration = generation
    phase = "preparing"
    changed()
    operation = Task { [weak self] in
      guard let self else { reply.fail("Voice input ended."); return }
      do {
        let granted = await AVAudioApplication.requestRecordPermission()
        try Task.checkCancellation()
        guard requestGeneration == self.generation else { throw CancellationError() }
        guard granted else { throw VoiceError("Microphone access is off. Allow microphone access in Settings to use voice input.") }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [])
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("composer-voice-\(UUID().uuidString).wav")
        self.recordingURL = url
        let recorder = try AVAudioRecorder(url: url, settings: [
          AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 24_000,
          AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
          AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
        ])
        recorder.delegate = self
        recorder.isMeteringEnabled = true
        guard recorder.prepareToRecord(), recorder.record() else { throw VoiceError("The microphone could not start recording. Try again.") }
        self.recorder = recorder
        if #available(iOS 26.0, *) {
          self.modelPreparation = Task { try await Self.prepareSpeech() }
        }
        self.phase = "recording"
        self.beginMetering()
        self.changed()
        reply.send(self.snapshot())
      } catch {
        if requestGeneration == self.generation {
          self.releaseAudio()
          self.removeRecording()
          self.phase = "error"
          self.error = error.localizedDescription
          self.changed()
        }
        reply.send(self.snapshot())
      }
    }
  }

  private func beginMetering() {
    lastMeterTime = 0
    meterTicket = context.frames { [weak self] frame in
      MainActor.assumeIsolated {
        guard let self, let recorder = self.recorder, self.phase == "recording" else { return }
        guard frame.now - self.lastMeterTime >= 100 else { return }
        self.lastMeterTime = frame.now
        recorder.updateMeters()
        self.elapsed = recorder.currentTime
        let power = Double(recorder.averagePower(forChannel: 0))
        let amplitude = max(0, min(1, pow(10, power / 40)))
        self.levels = Array(self.levels.dropFirst()) + [amplitude]
        self.changed()
        if self.elapsed >= 600 { self.confirm(reply: nil) }
      }
    }
  }

  private func confirm(reply: ExactReply?) {
    guard let url = recordingURL else { reply?.send(snapshot()); return }
    elapsed = recorder?.currentTime ?? elapsed
    releaseAudio()
    phase = "transcribing"
    error = ""
    let requestGeneration = generation
    changed()
    operation = Task { [weak self] in
      guard let self else { reply?.fail("Voice input ended."); return }
      do {
        guard #available(iOS 26.0, *) else { throw VoiceError("Voice input requires iOS 26 or later.") }
        let text = try await self.transcribe(url)
        try Task.checkCancellation()
        guard requestGeneration == self.generation else { throw CancellationError() }
        self.transcript = text.trimmingCharacters(in: .whitespacesAndNewlines)
        self.phase = self.transcript.isEmpty ? "error" : "idle"
        self.error = self.transcript.isEmpty ? "No speech was detected. Try recording again." : ""
        self.removeRecording()
        self.analysisCancellation = nil
        self.changed()
        reply?.send(self.snapshot())
      } catch {
        if requestGeneration == self.generation {
          self.phase = "error"
          self.error = error.localizedDescription
          self.removeRecording()
          self.analysisCancellation = nil
          self.changed()
        }
        reply?.send(self.snapshot())
      }
    }
  }

  @available(iOS 26.0, *)
  private func transcribe(_ url: URL) async throws -> String {
    let locale: Locale
    if let modelPreparation { locale = try await modelPreparation.value }
    else { locale = try await Self.prepareSpeech() }
    try Task.checkCancellation()
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    analysisCancellation = { Task { await analyzer.cancelAndFinishNow() } }
    let results = Task { () throws -> String in
      var text = ""
      for try await result in transcriber.results { text += String(result.text.characters) }
      return text
    }
    do {
      let file = try AVAudioFile(forReading: url)
      _ = try await analyzer.analyzeSequence(from: file)
      try await analyzer.finalizeAndFinishThroughEndOfInput()
      return try await results.value
    } catch {
      results.cancel()
      await analyzer.cancelAndFinishNow()
      throw error
    }
  }

  @available(iOS 26.0, *)
  private static func prepareSpeech() async throws -> Locale {
    var supported: Locale?
    for candidate in Locale.preferredLanguages.map({ Locale(identifier: $0) }) + [Locale.current] {
      if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: candidate) { supported = locale; break }
      try Task.checkCancellation()
    }
    guard let locale = supported else { throw VoiceError("On-device transcription does not support this language.") }
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    if let assets = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await assets.downloadAndInstall() }
    try Task.checkCancellation()
    return locale
  }

  private func interrupt(_ message: String) {
    guard phase == "preparing" || phase == "recording" else { return }
    let previousOwner = owner
    cancel()
    owner = previousOwner
    phase = "error"
    error = message
    changed()
  }

  private func releaseAudio() {
    meterTicket?.stop()
    meterTicket = nil
    recorder?.delegate = nil
    recorder?.stop()
    recorder = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func removeRecording() {
    if let recordingURL { try? FileManager.default.removeItem(at: recordingURL) }
    recordingURL = nil
  }

  func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
    if phase == "recording" { interrupt(flag ? "The recording stopped. Try recording again." : "Recording failed. Try again.") }
  }

  func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
    releaseAudio()
    removeRecording()
    phase = "error"
    self.error = error?.localizedDescription ?? "The recording stopped unexpectedly. Try again."
    changed()
  }
}

private struct VoiceError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
