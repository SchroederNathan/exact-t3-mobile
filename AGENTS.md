## Project identity

This repository is an active, personal clone of T3 Code's Expo mobile experience built with Exact. It is independent and unofficial. It is not an official T3 Code client and has no endorsement from pingdotgg.

The sibling `t3-exact-ios` checkout is the upstream T3 Code reference. Use it to check server behavior and wire compatibility. Keep this client independent and do not import code from that checkout.

In each fresh checkout or worktree, run `bun run deps` before building. It links `.exact/framework` to the same Exact checkout as the main project (`EXACT` can override it) and installs the frozen dependencies without changing tracked paths.

<!-- exact:begin (exact new writes this block; bun exact.mjs update rewrites it) -->
# exact-t3-mobile: an Exact app

`app.contract` is the view, `app.ts` the data module, `app.test.contract` the tests, `app.json`
the manifest: set `app.name` and `app.id` before building. The app uses Exact at
`../../expo-exact` by path (`EXACT` overrides it).

This file is already in your instructions. Start from the nearest pattern: `bun exact.mjs
pattern` lists them and `pattern <name>` writes one, tested. ../../expo-exact/docs/start-here-site.md (a site) or
../../expo-exact/docs/start-here.md is the only required reading. `bun exact.mjs contract vocab <name>` answers a
name (none: the card); `bun exact.mjs docs <heading words>` a guide's
section. Run `bun exact.mjs verify` when the features work, and `verify ios|android` at the end for a
phone app. When an iPhone app is ready to try, run `bun exact.mjs share` and send its link;
repeat for each change the person should see. `bun exact.mjs help` lists the verbs, including
app.json's `"commands"`.
`bun exact.mjs update` refreshes files. Native verbs (`ios`, `mac`, `linux`, `android`, `windows`)
name their platform in app.json on first use and build in a generated workspace;
`update --without <platform>` stops shipping it.
`bun ../../expo-exact/scripts/exact.mjs setup --check` names what a native build lacks.

Generated, so don't edit: `exact.mjs` and this block.

## Feedback (required)

When a doc was wrong or missing, a workaround was needed, something took several tries or a
command confused you, record it: `bun exact.mjs feedback note "<what happened>"`. It attaches
exact2's commit and the last exit code, never output or code. `bun exact.mjs feedback status` says
whether notes are sent and whether to keep a diary; under `never`, skip all of this.
<!-- exact:end -->
