#!/usr/bin/env python3
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
NATIVE = ROOT / "native/highlight"
MODULES = ROOT / "modules/apple"

def run(args):
    subprocess.run([str(arg) for arg in args], check=True)

with tempfile.TemporaryDirectory(prefix="t3-markdown-module-") as directory:
    output = Path(directory)
    tests = output / "work-queue-tests"
    strict = ["-swift-version", "6", "-strict-concurrency=complete", "-warnings-as-errors"]
    run(["swiftc", *strict, MODULES / "MarkdownWorkQueue.swift", NATIVE / "tests/WorkQueue.swift", "-o", tests])
    run([tests])
    stub = output / "ExactReply.swift"
    stub.write_text("import Foundation\nfinal class ExactReply: @unchecked Sendable {\n  func send(_ value: [String: Any]) {}\n  func fail(_ message: String) {}\n}\n")
    for identifier, sdk, triple in [
        ("ios-arm64", "iphoneos", "arm64-apple-ios17.0"),
        ("ios-arm64-simulator", "iphonesimulator", "arm64-apple-ios17.0-simulator"),
    ]:
        sdk_path = subprocess.check_output(["xcrun", "--sdk", sdk, "--show-sdk-path"], text=True).strip()
        run(["xcrun", "--sdk", sdk, "swiftc", *strict, "-target", triple, "-sdk", sdk_path,
             "-I", NATIVE / "include", "-L", NATIVE / "build" / identifier, "-lT3Highlight", "-lc++", "-emit-library",
             stub, MODULES / "MarkdownWorkQueue.swift", MODULES / "MarkdownTable.swift", MODULES / "MarkdownHighlight.swift",
             "-o", output / f"libMarkdown-{identifier}.dylib"])
        print(f"PASS: native Markdown helper compile/link for {identifier}", flush=True)
