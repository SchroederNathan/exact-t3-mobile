#!/usr/bin/env python3
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import shutil
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent
LANGUAGES = ["json", "html", "css", "markdown", "yaml", "go", "java", "javascript", "python", "c", "rust", "bash", "typescript", "tsx"]
EXPECTED_VERSION = "1.2.0-t3.16"
EXPECTED_COMMIT = "29ddd424323a9b5313e01b43716a947e6ee62b69"
CORE = ["CodeBlockHighlighter.cpp", "CodeBlockHighlighter.hpp", "CodeBlockLanguages.cpp", "CodeBlockLanguages.hpp", "HighlightGrammars.hpp", "grammar-versions.json", "vendor/generated/generated_registry.cpp", "vendor/generated/generated_queries.h"]

def digest(data):
    return hashlib.sha256(data).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("package", type=Path)
    parser.add_argument("--record-pin", action="store_true")
    args = parser.parse_args()
    package = args.package.resolve()
    info = json.loads((package / "package.json").read_text())
    fork = json.loads((package / "t3-fork.json").read_text())
    assert info["version"] == EXPECTED_VERSION, info["version"]
    assert fork["commit"] == EXPECTED_COMMIT, fork["commit"]
    source = package / "cpp/highlight"
    versions = json.loads((source / "grammar-versions.json").read_text())
    assert [key for key, value in versions["grammars"].items() if value.get("default")] == LANGUAGES
    files = {name: (source / name).read_bytes() for name in CORE}
    for directory in ["vendor/tree-sitter", *(f"vendor/grammars/{language}" for language in LANGUAGES)]:
        for path in sorted((source / directory).rglob("*")):
            if path.is_file() and not path.name.startswith("."):
                files[path.relative_to(source).as_posix()] = path.read_bytes()
    files["LICENSE"] = (package / "LICENSE").read_bytes()
    files["t3-fork.json"] = (package / "t3-fork.json").read_bytes()

    runtime = versions["runtime"]
    archive = urllib.request.urlopen(runtime["tarball"], timeout=60).read()
    assert digest(archive) == runtime["sha256"], "Tree-sitter release checksum differs"
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        prefix = f"tree-sitter-{runtime['ref'].removeprefix('v')}/"
        files["vendor/tree-sitter/LICENSE"] = tar.extractfile(prefix + "LICENSE").read()
        for name, content in files.items():
            if name.startswith("vendor/tree-sitter/src/") or name.startswith("vendor/tree-sitter/include/"):
                relative = name.removeprefix("vendor/tree-sitter/")
                assert content == tar.extractfile(prefix + "lib/" + relative).read(), name

    receipt = {
        "package": info["name"], "version": info["version"], "fork": fork,
        "runtime": runtime, "languages": LANGUAGES,
        "files": {name: digest(content) for name, content in sorted(files.items())},
    }
    pin = ROOT / "source-pin.json"
    if args.record_pin:
        pin.write_text(json.dumps(receipt, indent=2) + "\n")
    else:
        assert json.loads(pin.read_text()) == receipt, "Pinned source files differ"
    target = ROOT / "vendor/enriched-highlight"
    if target.exists():
        shutil.rmtree(target)
    for name, content in files.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    with (ROOT / "sources.tar.gz").open("wb") as output:
        with gzip.GzipFile(fileobj=output, mode="wb", mtime=0, filename="") as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                for name, content in sorted(files.items()):
                    entry = tarfile.TarInfo(name)
                    entry.size = len(content)
                    entry.mode = 0o644
                    archive.addfile(entry, io.BytesIO(content))
    print(json.dumps({"files": len(files), "bytes": sum(map(len, files.values())), "languages": LANGUAGES, "path": str(target)}))

if __name__ == "__main__":
    main()
