"""Create labeled composer comparisons without changing the captured pixels.

Run: uv run --with pillow python tools/composer-evidence.py
Inputs are 1260x2736 PNG screenshots of 420x912-point iPhone Air displays.
Only cropping, proportional resizing, and a separate label strip are applied.
"""

import base64
import hashlib
import html
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


EVIDENCE = Path(__file__).resolve().parents[1] / "evidence" / "composer-parity"
REPORT = EVIDENCE.parents[1] / ".exact" / "composer-parity-report.html"


def comparison(output, entries, crop, width):
    height = round((crop[3] - crop[1]) * width / (crop[2] - crop[0]))
    header = 50 if width == 840 else 70
    canvas = Image.new("RGB", (width * len(entries), height + header), "#f0f0f0")
    labels = ImageDraw.Draw(canvas)
    for index, (label, filename) in enumerate(entries):
        with Image.open(EVIDENCE / filename) as source:
            if source.size != (1260, 2736):
                raise ValueError(f"{filename}: expected an unscaled 1260x2736 screenshot")
            panel = source.convert("RGB").crop(crop)
            if panel.size != (width, height):
                panel = panel.resize((width, height), Image.Resampling.LANCZOS)
            canvas.paste(panel, (index * width, header))
        labels.text((index * width + 20, 14), label, fill="black", font_size=24)
    canvas.save(EVIDENCE / output)


STATES = [
    ("empty", (0, 2385, 1260, 2685)),
    ("commands", (0, 840, 1260, 1740)),
    ("context", (0, 1512, 1260, 1740)),
]

for state, crop in STATES:
    comparison(
        f"before-reference-after-{state}.png",
        [
            ("Before (Exact baseline)", f"before-native-{state}-air.png"),
            ("Expo reference", f"reference-native-{state}-air.png"),
            ("After (Exact current)", f"after-native-{state}-final-air.png"),
        ],
        crop,
        840,
    )

differences = []
for state, crop in STATES:
    comparison(
        f"compare-{state}-native.png",
        [
            ("Expo reference", f"reference-native-{state}-air.png"),
            ("Exact current", f"after-native-{state}-final-air.png"),
        ],
        crop,
        1260,
    )
    reference_path = EVIDENCE / f"reference-native-{state}-air.png"
    current_path = EVIDENCE / f"after-native-{state}-final-air.png"
    with Image.open(reference_path) as reference, Image.open(current_path) as current:
        difference = ImageChops.difference(reference.convert("RGB").crop(crop), current.convert("RGB").crop(crop))
        difference.save(EVIDENCE / f"difference-{state}-native.png")
        differences.append({
            "state": state,
            "crop": crop,
            "identical": difference.getbbox() is None,
            "reference_sha256": hashlib.sha256(reference_path.read_bytes()).hexdigest(),
            "current_sha256": hashlib.sha256(current_path.read_bytes()).hexdigest(),
        })

(EVIDENCE / "visual-comparison.json").write_text(json.dumps({
    "method": "RGB difference at identical screen coordinates; no alignment, masks, or tolerance. Crops focus the composer and retain neighboring pixels, cursor timing, and glass rendering differences.",
    "states": differences,
}, indent=2) + "\n")


def figure(filename, caption):
    data = base64.b64encode((EVIDENCE / filename).read_bytes()).decode("ascii")
    return f'<figure><a href="{html.escape(filename)}"><img src="data:image/png;base64,{data}" alt="{html.escape(caption)}"></a><figcaption>{html.escape(caption)}</figcaption></figure>'


summary_path = EVIDENCE / "verification-summary.json"
if summary_path.exists():
    summary = json.loads(summary_path.read_text())
    sections = [
        "<!doctype html><html lang='en'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><base href='../evidence/composer-parity/'>",
        "<title>Composer parity evidence</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:1200px;margin:32px auto;padding:0 20px;color:#202126;background:#fafafa}h1,h2{line-height:1.2}figure{margin:24px 0}img{max-width:100%;height:auto;border:1px solid #ddd;border-radius:8px}figcaption,small{color:#60616a}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #ddd;padding:10px;vertical-align:top}code{overflow-wrap:anywhere}a{color:#164de2}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.gallery img{max-height:600px;width:auto}</style><main>",
        "<h1>Composer parity evidence</h1>",
        "<p>The goal is to match the Expo composer's appearance and behavior in this Exact app. These are captures of running native apps on the same iPhone Air simulator at 420 × 912 points, 3× scale, on iOS 27.2.</p>",
        f'<p><a href="{html.escape(summary["install_url"])}">Install the Exact iPhone build, revision {summary["install_revision"]}</a></p>',
        f'<p>Exact baseline <code>{html.escape(summary["baseline_commit"])}</code>. Expo reference <code>{html.escape(summary["reference_commit"])}</code>. Current implementation is the uncommitted working tree.</p>',
        f'<p>Exact framework <code>{html.escape(summary["exact_framework_commit"])}</code>. <a href="source-hashes.json">Source hashes</a> identify the verified working tree.</p>',
        "<h2>Before, Expo, and after</h2><p>Each row uses the same crop coordinates across all three original screenshots. The images are cropped and proportionally resized. They are not retouched. Empty and command states use matching input. The context row shows the baseline's file-mention draft beside the matching Expo and Exact skill-chip states.</p>",
    ]
    for state, _ in STATES:
        sections.append(figure(f"before-reference-after-{state}.png", f"{state.capitalize()}. Exact before, Expo reference, Exact after."))
    sections.extend([
        "<h2>Pixel comparison</h2>",
        "<p>The raw RGB comparisons are nonzero. These captures do not establish pixel-identical rendering. They retain cursor timing, glass material, text rasterization, and any layout differences. The full source screenshots and raw difference images are included beside this report.</p>",
        "<ul>" + "".join(f'<li>{row["state"].capitalize()}: {"identical" if row["identical"] else "nonzero difference"}.</li>' for row in differences) + "</ul>",
        "<h2>Verification</h2><table><thead><tr><th>Check</th><th>Result</th></tr></thead><tbody>",
    ])
    for check in summary["checks"]:
        sections.append(f'<tr><td>{html.escape(check["name"])}</td><td>{html.escape(check["result"])}</td></tr>')
    sections.append("</tbody></table><h2>Native interaction evidence</h2><div class='gallery'>")
    for filename, caption in summary["gallery"]:
        sections.append(figure(filename, caption))
    sections.append("</div><h2>Limits</h2><ul>")
    sections.extend(f'<li>{html.escape(limit)}</li>' for limit in summary["limits"])
    sections.extend([
        "</ul><h2>Reproduce and inspect</h2>",
        "<p><code>uv run --with pillow python tools/composer-evidence.py</code> recreates comparisons, raw differences, hashes, and this standalone report from the retained screenshots.</p>",
        "<p><code>bun test tests</code> runs the unit suite. <code>python3 native/composer/test-editor.py</code> runs the UIKit probe. The Exact framework is selected with <code>EXACT=/Volumes/ExternalSSD/T3Projects/exact</code> for contract build, web verification, native build, and iOS verification.</p>",
        "<p>Prove It Works drove the native interaction checks and RPC receipts. Build the Lever drove the rerunnable screenshot comparison script.</p>",
        "<p><a href='verification-summary.json'>Verification summary</a> · <a href='verification-ios.json'>Native verifier report</a> · <a href='verification-web.log'>Web verifier log</a> · <a href='unit-tests.log'>Unit test log</a> · <a href='native-editor-probe.log'>UIKit probe log</a> · <a href='connected-ui-tests.log'>Connected regression log</a> · <a href='visual-comparison.json'>Image comparison hashes</a> · <a href='native-queue-rpc-receipts.json'>Queue RPC receipts</a> · <a href='native-paste-rpc-receipts.json'>Paste upload and deletion receipts</a> · <a href='native-thread-link-paste-receipts.json'>Thread paste receipts</a></p>",
        "</main></html>",
    ])
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(sections) + "\n")
