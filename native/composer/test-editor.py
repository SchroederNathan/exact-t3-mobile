#!/usr/bin/env python3
"""Run the production UIKit composer in an isolated simulator with a small seam stub."""
import pathlib
import plistlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


with tempfile.TemporaryDirectory(prefix="exact-composer-probe-") as temporary:
    app = pathlib.Path(temporary) / "ComposerProbe.app"
    app.mkdir()
    with (app / "Info.plist").open("wb") as output:
        plistlib.dump({"CFBundleIdentifier": "com.exact.composer-probe", "CFBundleName": "ComposerProbe", "CFBundleExecutable": "ComposerProbe", "CFBundlePackageType": "APPL", "CFBundleVersion": "1", "CFBundleShortVersionString": "1", "MinimumOSVersion": "17.0", "UIDeviceFamily": [1], "LSRequiresIPhoneOS": True, "UILaunchScreen": {}, "UIApplicationSceneManifest": {"UIApplicationSupportsMultipleScenes": False}}, output)
    sdk = subprocess.check_output(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"], text=True).strip()
    run(["xcrun", "--sdk", "iphonesimulator", "swiftc", "-target", "arm64-apple-ios17.0-simulator", "-sdk", sdk, ROOT / "native/composer/tests/EditorProbe.swift", ROOT / "modules/apple/ComposerEditor.swift", ROOT / "modules/apple/ComposerClipboard.swift", ROOT / "modules/apple/ComposerMetrics.swift", "-o", app / "ComposerProbe"])
    run(["codesign", "--force", "--sign", "-", app])
    simulator = subprocess.check_output(["xcrun", "simctl", "create", "Exact Composer Probe", "com.apple.CoreSimulator.SimDeviceType.iPhone-17e", "com.apple.CoreSimulator.SimRuntime.iOS-27-2"], text=True).strip()
    try:
        run(["xcrun", "simctl", "boot", simulator])
        run(["xcrun", "simctl", "bootstatus", simulator, "-b"], capture_output=True)
        run(["xcrun", "simctl", "install", simulator, app])
        launch = run(
            ["xcrun", "simctl", "launch", "--console", simulator, "com.exact.composer-probe"],
            timeout=60,
            capture_output=True,
            text=True,
        )
        container = subprocess.check_output(["xcrun", "simctl", "get_app_container", simulator, "com.exact.composer-probe", "data"], text=True).strip()
        result = pathlib.Path(container) / "Documents/probe.txt"
        output = result.read_text() if result.exists() else "No probe result was written."
        print(output, flush=True)
        if "PASS: native composer checks complete" not in output:
            print(launch.stdout, end="", flush=True)
            print(launch.stderr, end="", flush=True)
            run(["xcrun", "simctl", "spawn", simulator, "log", "show", "--last", "1m", "--predicate", 'process == "ComposerProbe"'])
            raise RuntimeError("Native composer probe did not complete")
    finally:
        subprocess.run(["xcrun", "simctl", "shutdown", simulator], capture_output=True)
        subprocess.run(["xcrun", "simctl", "delete", simulator], capture_output=True)
