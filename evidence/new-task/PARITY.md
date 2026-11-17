# New task parity: what still differs

Reference: `ref/` (upstream Expo app, iPhone 17 Pro, light). Ours: `exact/` (this app, simulator parity-newtask-exact, same server data). Side by side: `compare-<nn>.png` (ref left). Positions are ink bands measured on the 3x captures and given in points.

Server state changed between the two captures. The reference was captured before any thread existed; ours after the verification sends. That changes content, not layout:
- Choose project lists acme-web first: it now has the newest thread activity (sort by activity, then update time).
- The branch pickers show one more row, `t3/reply-ok WORKTREE`, the worktree that the worktree-mode send created.

| Screen | Remaining delta |
|---|---|
| 01 Choose project | No project card 124.0-188.3 vs 124.0-188.7; project card 200.7-330.3 vs 201.0-331.3 (under 1 pt). Text columns identical to 0.0 pt. Ref 01 caught the "+" capsule mid-animation; ref 08 shows the settled "+", which ours matches. Subtitles are the same middle-ellipsized strings. |
| 02 Draft | Title lines identical (284.7-303.7, 322.3-341.7). Underline 349.3 vs 349.7, environment line 381.7 vs 382.3 (0.4-0.6 pt). Controls row identical (754.7-766.3); branch control 0.3 pt left. Composer pill top identical (786-787); the shared composer's glass rim is darker (216 vs 239 grey at 786). |
| 03 Environment | Card 132.0-196.3 vs 132.0-197.0 (0.7 pt shorter). Checkmark and disclosure columns identical (319.3-331.7, 362.0-371.7 vs 361.7-371.7). |
| 04 Branch | Card bottom 0.7 pt higher per two-line row. Extra worktree row (state). |
| 05 Draft, worktree | As 02. Worktree badge is the Tabler git-branch glyph at the measured offset. |
| 06 Base branch | Start from remote card identical (132.0-180.7). List as 04. |
| 07 Thread settings | The shared settings sheet. Rows identical. The ref list continues into a "Catalog" section; ours ends at Runtime (sheet content is outside this slice). |
| 08 Choose from draft | As 01. |
| 16/17 After send | The route flips in place to the live thread (no push); by the first capture the reply is there in both. The live thread screen itself (bubble 8 pt lower, "Worked for 3.1s" row, fork glyph) is the existing thread screen, not this slice. |
| 18 Home, unsent | "Unsent" divider identical (175.3-184.7 vs 175.7-185.0). Title and branch line 0.7 pt higher. Ours shows the project monogram tile before the title; the reference was captured while upstream had lost its project list (ref 19 shows "No environments connected"), so its row had no tile. The spec and upstream code (`thread-list-v2-items.tsx`) draw the tile when the project is known. |

Dark mode: `compare-dark-01..04.png` (ref-dark left, `exact-dark/` right). Same layout; our 02 dark capture has text typed in the composer, so the composer shows its expanded two-line form.

Ref 15 is an upstream render error ("undefined is not a function"), so it has no compare sheet; `exact/15-draft-typed.png` shows ours with the prompt typed.

Platform-only differences in every pair: status-bar time, sub-pixel text antialiasing, Liquid Glass shadow sampling.

Extra evidence: `exact/08b-no-project-draft.png` (No project draft: "What should we work on?"), `exact/18b-discard-draft.png` (Discard draft? alert), `exact/17-after-send-worktree.png` (worktree send landed on the live thread).

## Add Project (refs 09-14) and the composer rim

Captured on parity-newtask-exact against the scratch server, light, 3x. Side by side: `compare-09.png` .. `compare-14.png`, dark `compare-dark-09.png`. Positions are ink bands in points.

| Screen | Remaining delta |
|---|---|
| 09 Add project | Every row boundary within 0.3 pt (separators 193.0/193.0 ... 785.0/785.3). Disabled provider hints wrap differently where they hold a URL: upstream breaks after `https://`, Exact keeps the URL as one word. |
| 10 Local folder | Field and button identical (132.0-173.7, 184.0-225.7). Folder rows identical height (43.0); list starts 0.3 pt higher; row text sits 0.4-0.7 pt higher inside the row (text baseline placement). |
| 11 New project | Field, switch and buttons identical. Publish row text 0.3 pt; path preview text 0.7 pt higher. The preview's second line truncates at a word (`mobile-…`) where upstream truncates mid-word (`ddbeb2…`). Keyboard and its empty QuickType bar identical. |
| 12 Git URL | Field identical; "Continue" label 0.3 pt; disabled fill identical (250). |
| 13 GitHub | Field identical; "Lookup repository" label 0.3 pt. |
| 14 Clone destination | Repository card, field and button identical (field 228.3, button 280.3). Section title 0.3 pt, folder rows 0.4 pt higher. |
| Dark 09 | Same layout and colours as light; same URL wrapping delta. |

Fixes made while matching: button labels at 14 pt (upstream `AppText` sets no size, so React Native's default applies); placeholder colour `muted`; New project name field autofocuses (a `blur()` on push had cancelled it); `spellcheck` left on so the QuickType bar shows as upstream; title-and-subtitle rows and the repository card get 0.5 pt more top padding (upstream's text stacks lay out 0.5 pt taller than their line heights sum); clone spinner `#999999` (React Native's iOS default).

Composer (shared by draft and thread): the glass drew a dark rim just outside its bounds (215/227 at 785.3-785.7 pt against upstream's 240/240). The glass now sits in an inner column with `overflow="hidden"`, the shadow on the outer one, as upstream clips its glass. After: 240/238 at the top edge, shadow below within 1-2 grey levels, pill 1 device pixel (0.33 pt) higher. Sheet: `compare-02-composer.png`.

Flow evidence (`exact/`): `10b-local-draft.png` (local-demo draft), `10c-back-home.png` (Back from it lands on Home), `10d-project-exists.png` ("Project already exists" over the acme-web draft), `11b-new-project-typed.png` and `11c-new-project-draft.png` (parity-new-demo, publish off), `13b-github-destination.png` (lookup octocat/Hello-World reaches Clone destination with its card; not cloned), `14b-clone-started.png` (Hello-World cloned before the draft drew, so no banner), `14c-clone-running.png` (a clone through a local 8 s delay proxy: "Cloning Hello-World-slow", Send labelled "Wait for the project clone to finish."), `14d-clone-done-send-ready.png` (2 s later the clone finished, the banner left and Send enabled with text), `14e-clone-cancelled.png` (Cancel: "Cancelled cloning …" with Remove project and Retry, Send still blocked), `14f-after-remove.png` (Remove project returns to Home, "Chats").

Not shown on device: Retry, a failed clone, the app-access alert (the scratch server's GitHub provider was never asked; no clone went to github.com through a provider with app sign-in), the publish switch (left off by rule), and the 15 s timeout messages.
