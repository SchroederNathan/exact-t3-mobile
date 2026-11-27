# Expo parity verification · November 26, 2026

The integration branch is `afk/2026-11-26`. The application tested here is `dd21e48`, from baseline `bbfab4b`. Expo was used as a reference, not imported into this client. These results are **not** a native pixel-equivalence sign-off.

## What changed

| Area | Implemented and exercised |
| --- | --- |
| Home | Working, pinned, snoozed and settled sections; pin order and Undo; custom snooze, wake and settlement; title updates and message search. |
| Settings and Usage | Keyboard Return preference; review before pairing; per-environment usage charts and provider limits. |
| PR list | Scoped reads, pagination, sorting, facet search, filters and saved preferences. The fixture includes colliding repository/PR coordinates on different hosts. |
| PR overview | Repository subtitle, provider link actions, measured/collapsible Markdown description, file picker, filters and viewed state. |
| PR review | Timeline filters, commit-scoped changes, paginated discussions, replies and resolution with fresh write permission checks. Diff options preserve exact clipboard text and support horizontal scrolling without wrapping. |

## Gates and limits

| Check | Observed result |
| --- | --- |
| `bun test tests` | 405 passed, 0 failed; 2,709 assertions across 51 files on the final application revision. |
| `bun exact.mjs verify web` | 13 journeys passed; no horizontal spill on 22 screens at the largest text setting. **Nonzero overall**: 386 findings, including 350 fixed-sizing flags, 13 one-scheme colors and 5 same-action state reads. |
| Connected web fixtures | PRs 1/1, thread time/actions 8/8, message search 1/1, usage 1/1, composer 2/2. These are fixture scenarios, not a count of individual assertions. |
| Full Home fixture | **6 passed, 1 failed, 3 iOS-only skipped.** A held send now resolves across thread navigation and preserves other/newer drafts. The checkpoint waiting for two simultaneous ready environments still times out. Web `loadCatalog` opens only one environment; the native connection manager is separate. |
| Chromium toolbar | 320, 393 and 900px width × 16, 32 and 53px root font size. At size 16 the diff toolbar shrank from 121 to 45px including the border; Back went from 32×36 to 44×44. Also checked subtitle, copy payload, share with/without support, and return to the same PR. |
| iOS simulator build | `prepare-ios` and `ios --no-install --json` produced an ad-hoc-signed simulator `.app`; `codesign --verify --deep --strict` passed. Not installed or exercised. |
| Expo cloud simulator | Two sessions started and stopped. The pinned `agent-device` 0.21.36 could not perform native interactions: `Remote daemon RPC protocol is incompatible`. No paired native screenshots, timing comparisons, or native accessibility-tree verification for this build. |

**Captured evidence:** [393px toolbar before](./expo-parity-2026-11-26/diff-header-before.png), [393px toolbar after](./expo-parity-2026-11-26/diff-header-after.png), [all nine final geometry samples](./expo-parity-2026-11-26/diff-header-metrics.jsonl). Both images are of the Exact web client, not of Expo or iOS.

**Socket regression:** On `197adb1`, Chromium recorded a new shell subscription when opening Alpha, and that socket closed before the fixture could acknowledge Alpha's message (`409`, zero releases). On `dd21e48`, the same navigation recorded one shell subscription with thread subscriptions Alpha → Beta → Alpha. The fixture released exactly one message (`200`); Beta retained its draft while Alpha cleared. Neither replayed screenshots nor an increased test timeout account for this change.

## Reproduce

Use a local Exact checkout and synthetic data only. Run one fixture at a time in a checkout; don't edit app sources during a native build.

```sh
bun test tests
bun exact.mjs verify web
bun tools/test-fixture.ts web --pulls
bun tools/test-fixture.ts web --thread-time
bun tools/test-fixture.ts web --thread-search
bun tools/test-fixture.ts web --usage
bun tools/test-fixture.ts web --composer
bun tools/test-fixture.ts web
```

For the toolbar geometry probe, start two processes in separate terminals. Use a free loopback port for the preview:

```sh
bun tools/test-fixture.ts --serve --pulls > /tmp/t3-toolbar-fixture.json
```

```sh
bun exact.mjs web-build --out target/web-dist
bun exact.mjs serve target/web-dist --port 54188
```

With `EXACT` set to the absolute framework checkout containing `playwright-core`, run:

```sh
node tools/check-pull-toolbar.mjs http://127.0.0.1:54188 /tmp/t3-toolbar-fixture.json /tmp/t3-toolbar-shots
```

Set `CHROMIUM_EXECUTABLE` if the matching Chromium binary is installed outside Playwright's default location. The last argument is optional. The probe prints nine geometry records, fails on overlapping controls or an undersized target, and uses fake clipboard and share handlers. Stop the fixture and preview when finished.

## Next acceptance gates

1. Restore compatibility between the approved cloud driver and remote daemon. Use the same device model, OS, display scale, text size, locale, appearance and fixture time for both apps. Capture keyboard opening, navigation, menus and tab reselection in motion, not just their resting frames. Old screenshots in other evidence directories belong to different builds.
2. Implement independent web subscriptions for each enabled environment. Verify both sockets remain distinct during filtering and that disabling or re-enabling one environment does not interrupt the other. Keep the now-passing same-environment draft and acknowledgment scenario as a regression gate.
3. Compare the remaining PR reviewer, review-submission and guide flows against Expo. Do not expose write actions merely because the viewer can read a PR.
