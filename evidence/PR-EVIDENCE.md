# File browser previewer evidence

Branch: `exact-file-browser-previewer`  
Feature commit: `86d6203` (`feat(ios): complete project file browser navigation`)

## Delivered behavior

- Files inspector requests one directory at a time through `projects.listEntries`.
- Directory entries are sorted before files with numeric, case-insensitive ordering.
- Tapping a directory changes the inspector path and re-runs the request with that path.
- The inspector header exposes a parent-folder button for nested paths.
- Tapping a file pushes `linkedFile` and renders numbered, virtualized source lines.
- The inspector task key includes the current path, preventing stale nested-directory results.

## Verification

- `bun test tests`: **231 pass, 0 fail**.
- Standard iPhone native verify: `bun exact.mjs verify ios --sim 'PR tests isolated standard' --shots evidence/verify-standard --json` — **exit 0**; screenshots and JSON receipt are in `evidence/verify-standard/` and `evidence/verify-standard.json`.
- Native iOS build: `bun exact.mjs ios --run --sim 'PR tests isolated standard'` — build/install completed.
- Fixture-backed standard iPhone flow: paired `tools/test-fixture.ts --serve --markdown`, opened Alpha thread, Files, `src`, `src/deep`, and `needle.ts`; captured root and source preview screenshots plus a 236-second MP4 recording.
- Duo simulator: app opened on `PR tests isolated Duo`; captured the Duo add-environment/layout screenshot at `evidence/device-duo/add-environment.png`. The earlier Duo verify completed its screen checks but reported two pre-existing split-layout/navigation assertions in the home regression suite; those are unrelated to the file browser path.

## Artifacts

- [HTML parity review](./file-browser-side-by-side.html)
- [Standard iPhone recording](./device-standard/file-browser-standard.mp4)
- [Standard Files root screenshot](./device-standard/files-root.png)
- [Standard source preview screenshot](./device-standard/file-preview-needle.png)
- [Duo layout screenshot](./device-duo/add-environment.png)
- [Standard verify receipt](./verify-standard.json)
