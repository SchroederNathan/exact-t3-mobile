#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "vendor/enriched-highlight"

def run(args):
    result = subprocess.run([str(arg) for arg in args], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(" ".join(map(str, args)) + "\n" + result.stdout + result.stderr)
    return result.stdout.strip()

def sort_framework_slices(framework):
    path = framework / "Info.plist"
    info = plistlib.loads(path.read_bytes())
    info["AvailableLibraries"].sort(key=lambda library: library["LibraryIdentifier"])
    path.write_bytes(plistlib.dumps(info, sort_keys=True))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "build")
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--host-tests", action="store_true")
    parser.add_argument("--install", action="store_true")
    args = parser.parse_args()
    output = args.output.resolve()
    pin = json.loads((ROOT / "source-pin.json").read_text())
    if not SOURCE.exists():
        with tarfile.open(ROOT / "sources.tar.gz", "r:gz") as archive:
            for name, digest in pin["files"].items():
                data = archive.extractfile(name).read()
                assert hashlib.sha256(data).hexdigest() == digest, name
                target = SOURCE / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
    for name, digest in pin["files"].items():
        assert hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() == digest, name
    languages = pin["languages"]
    sources = [SOURCE / name for name in ["CodeBlockHighlighter.cpp", "CodeBlockLanguages.cpp", "vendor/generated/generated_registry.cpp", "vendor/tree-sitter/src/lib.c"]]
    for language in languages:
        sources.append(SOURCE / f"vendor/grammars/{language}/parser.c")
        scanner = SOURCE / f"vendor/grammars/{language}/scanner.c"
        if scanner.exists(): sources.append(scanner)
    sources.append(ROOT / "wrapper/T3Highlight.cpp")
    includes = [ROOT / "include", SOURCE, SOURCE / "vendor/generated", SOURCE / "vendor/tree-sitter/include"]
    targets = [("ios-arm64", "iphoneos", "arm64-apple-ios17.0"), ("ios-arm64-simulator", "iphonesimulator", "arm64-apple-ios17.0-simulator")]
    if args.host_tests: targets.append(("macos-arm64", "macosx", "arm64-apple-macos14.0"))
    archives = []
    sdk_info = {}
    for identifier, sdk, triple in targets:
        destination = output / identifier
        destination.mkdir(parents=True, exist_ok=True)
        sdk_path = run(["xcrun", "--sdk", sdk, "--show-sdk-path"])
        sdk_info[identifier] = {"sdk": sdk_path, "target": triple}
        objects = [destination / f"{index:02d}-{path.stem}.o" for index, path in enumerate(sources)]
        def compile(entry):
            path, obj = entry
            cpp = path.suffix == ".cpp"
            flags = ["-std=c++17"] if cpp else ["-std=c11"]
            run(["xcrun", "--sdk", sdk, "clang++" if cpp else "clang", "-target", triple, "-isysroot", sdk_path, "-O2", "-fPIC", "-fvisibility=hidden", "-DENRICHED_MARKDOWN_CODE_HIGHLIGHT=1", *flags, *[arg for directory in includes for arg in ["-I", directory]], "-c", path, "-o", obj])
        with ThreadPoolExecutor(max_workers=args.jobs) as executor:
            list(executor.map(compile, zip(sources, objects)))
        archive = destination / "libT3Highlight.a"
        run(["xcrun", "libtool", "-static", "-D", "-o", archive, *objects])
        print(json.dumps({"slice": identifier, "translationUnits": len(sources), "archiveBytes": archive.stat().st_size}), flush=True)
        if sdk != "macosx":
            archives.extend(["-library", archive, "-headers", ROOT / "include"])
            run(["xcrun", "--sdk", sdk, "swiftc", "-target", triple, "-sdk", sdk_path, "-I", ROOT / "include", "-L", destination, "-lT3Highlight", "-lc++", "-emit-library", ROOT / "tests/SwiftImport.swift", "-o", destination / "libImportProbe.dylib"])
        else:
            executable = destination / "highlight-tests"
            run(["xcrun", "clang++", "-std=c++17", "-target", triple, "-isysroot", sdk_path, "-I", ROOT / "include", "-I", SOURCE, ROOT / "tests/wrapper.cpp", archive, "-o", executable])
            print(run([executable]), flush=True)
    framework = output / "T3Highlight.xcframework"
    if framework.exists(): shutil.rmtree(framework)
    print(run(["xcodebuild", "-create-xcframework", *archives, "-output", framework]), flush=True)
    sort_framework_slices(framework)
    shutil.copyfile(SOURCE / "LICENSE", framework / "LICENSE.enriched-markdown")
    notices = ["React Native Enriched Markdown\n" + (SOURCE / "LICENSE").read_text(), "Tree-sitter runtime\n" + (SOURCE / "vendor/tree-sitter/LICENSE").read_text(), "Tree-sitter Unicode\n" + (SOURCE / "vendor/tree-sitter/src/unicode/LICENSE").read_text()]
    notices.extend(f"Grammar: {language}\n" + (SOURCE / f"vendor/grammars/{language}/LICENSE").read_text() for language in languages)
    (framework / "THIRD-PARTY-NOTICES.txt").write_text("\n\n".join(notices))
    receipt = {"compiler": run(["xcrun", "clang", "--version"]), "slices": sdk_info, "translationUnits": [str(path.relative_to(ROOT)) for path in sources], "files": {str(path.relative_to(framework)): {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in sorted(framework.rglob("*")) if path.is_file()}}
    (output / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if args.install:
        app = ROOT.parents[1]
        destination = app / "modules/apple/T3Highlight.xcframework"
        if destination.exists(): shutil.rmtree(destination)
        shutil.copytree(framework, destination)
        shutil.copyfile(framework / "THIRD-PARTY-NOTICES.txt", app / "assets/ThirdPartyNotices.txt")
        print(json.dumps({"installed": str(destination)}), flush=True)

if __name__ == "__main__":
    main()
