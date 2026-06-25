# TUI upstream v1.17.9 diff audit

Audit target: committed `HEAD` `29993986f601e578803a1e5a2e017b2f16b66a47` against upstream tag `v1.17.9` `5c23e88419c4743b9be42cea132f2fb1e6cb63ff`.

Scope: `packages/tui/src`.

Result:

- Differing files from `git diff --name-only v1.17.9 HEAD -- packages/tui/src`: 60.
- Missing files from `v1.17.9` under `packages/tui/src`: 0.
- Stale files missing an upstream v1.17.9 TUI change: 0.
- Missing upstream TUI behaviors/components/keybinds/commands/features found: 0.
- Client/server TUI path mismatches found: 0.

Notes:

- This audit compares committed `HEAD`, not unrelated unstaged worktree edits.
- `HEAD` has 8 extra TUI files relative to `v1.17.9`: five vendored attention audio assets, two upgrade-indicator files, and `terminal-detection.ts`.
- The actual upstream TUI delta from `v1.17.8` to `v1.17.9` touched only three TUI files: `component/dialog-console-org.tsx`, `context/sync.tsx`, and `routes/session/index.tsx`. All of those upstream changes are present in `HEAD`.

## Upstream v1.17.9 Release Delta

These are the actual upstream TUI changes introduced between `v1.17.8` and `v1.17.9`, checked independently from the 60-file fork diff.

- `packages/tui/src/component/dialog-console-org.tsx`: `HEAD` is identical to `v1.17.9`. The upstream inline console-org load-error behavior is present: `loadError` catch path at `packages/tui/src/component/dialog-console-org.tsx:30`, disabled filter/locked dialog at `packages/tui/src/component/dialog-console-org.tsx:121`, and inline "Could not load orgs" view at `packages/tui/src/component/dialog-console-org.tsx:127`.
- `packages/tui/src/context/sync.tsx`: upstream background-subagent capability state is present: store type at `packages/tui/src/context/sync.tsx:71`, default at `packages/tui/src/context/sync.tsx:116`, bootstrap request at `packages/tui/src/context/sync.tsx:560`, and assignment at `packages/tui/src/context/sync.tsx:609`. Fork-only additions are YOLO and streaming paths at `packages/tui/src/context/sync.tsx:155`, `packages/tui/src/context/sync.tsx:230`, `packages/tui/src/context/sync.tsx:363`, and `packages/tui/src/context/sync.tsx:469`.
- `packages/tui/src/routes/session/index.tsx`: upstream inline tool spacing / background shortcut gating is present: `alwaysSeparate` at `packages/tui/src/routes/session/index.tsx:97`, foreground task capability gate at `packages/tui/src/routes/session/index.tsx:212`, background shortcut gate at `packages/tui/src/routes/session/index.tsx:1523`, inline-row separation at `packages/tui/src/routes/session/index.tsx:1970`, block tool separation at `packages/tui/src/routes/session/index.tsx:2037`, and subagent `separate={true}` at `packages/tui/src/routes/session/index.tsx:2324`. Fork-only additions are smooth streaming, canonical `builder`, and calm-mode width caps at `packages/tui/src/routes/session/index.tsx:84`, `packages/tui/src/routes/session/index.tsx:326`, `packages/tui/src/routes/session/index.tsx:421`, and `packages/tui/src/routes/session/index.tsx:1703`.

## Per-File Verdicts

| File | Verdict | Evidence |
| --- | --- | --- |
| `packages/tui/src/app.tsx` | has-upstream-changes | Upstream command/dialog structure is retained; fork edits are marked helper import and startup theme detection at `packages/tui/src/app.tsx:85` and `packages/tui/src/app.tsx:235`, plugin prompt ref at `packages/tui/src/app.tsx:397`, branding/docs/update text at `packages/tui/src/app.tsx:452`, `packages/tui/src/app.tsx:808`, and `packages/tui/src/app.tsx:1051`. |
| `packages/tui/src/assets/audio/bip-bop-01.mp3` | has-upstream-changes | Fork-only added binary. It vendors the upstream attention sound locally because the fork does not ship `@opencode-ai/ui`; imported at `packages/tui/src/attention.ts:17` and `packages/tui/src/attention.ts:21`. |
| `packages/tui/src/assets/audio/bip-bop-03.mp3` | has-upstream-changes | Fork-only added binary. It vendors the upstream question sound locally; imported at `packages/tui/src/attention.ts:18`. |
| `packages/tui/src/assets/audio/nope-03.mp3` | has-upstream-changes | Fork-only added binary. It vendors the upstream error sound locally; imported at `packages/tui/src/attention.ts:20`. |
| `packages/tui/src/assets/audio/staplebops-06.mp3` | has-upstream-changes | Fork-only added binary. It vendors the upstream permission sound locally; imported at `packages/tui/src/attention.ts:19`. |
| `packages/tui/src/assets/audio/yup-01.mp3` | has-upstream-changes | Fork-only added binary. It vendors the upstream subagent-done sound locally; imported at `packages/tui/src/attention.ts:22`. |
| `packages/tui/src/attention.ts` | has-upstream-changes | Upstream attention behavior is retained; fork changes are local audio imports at `packages/tui/src/attention.ts:17` and sound-pack branding at `packages/tui/src/attention.ts:50`. |
| `packages/tui/src/component/dialog-provider.tsx` | has-upstream-changes | Upstream provider dialog/auth flow is retained. Differences are fork branding/URLs for Zen/Go at `packages/tui/src/component/dialog-provider.tsx:374`, `packages/tui/src/component/dialog-provider.tsx:378`, `packages/tui/src/component/dialog-provider.tsx:385`, and `packages/tui/src/component/dialog-provider.tsx:389`. |
| `packages/tui/src/component/dialog-retry-action.tsx` | has-upstream-changes | Upstream retry-action dialog is retained. Difference is fork Go URL at `packages/tui/src/component/dialog-retry-action.tsx:10`. |
| `packages/tui/src/component/dialog-status.tsx` | has-upstream-changes | Upstream status dialog is retained. Difference is branded MCP auth hint at `packages/tui/src/component/dialog-status.tsx:83`. |
| `packages/tui/src/component/error-component.tsx` | has-upstream-changes | Upstream fatal error component is retained. Fork changes are bug-report repo URL and title prefix at `packages/tui/src/component/error-component.tsx:21` and `packages/tui/src/component/error-component.tsx:36`. |
| `packages/tui/src/component/logo.tsx` | has-upstream-changes | Upstream logo component is retained. Fork intentionally restores brand-colored rendering at `packages/tui/src/component/logo.tsx:859`. |
| `packages/tui/src/component/upgrade-indicator-utils.ts` | has-upstream-changes | Fork-only added component re-homed from the old TUI entrypoint during the v1.17.9 TUI extraction; see marker at `packages/tui/src/component/upgrade-indicator-utils.ts:1`. No upstream counterpart is missing. |
| `packages/tui/src/component/upgrade-indicator.tsx` | has-upstream-changes | Fork-only added component re-homed from the old TUI entrypoint; see marker at `packages/tui/src/component/upgrade-indicator.tsx:1`, and footer command text at `packages/tui/src/component/upgrade-indicator.tsx:26`. No upstream counterpart is missing. |
| `packages/tui/src/context/route.tsx` | has-upstream-changes | Upstream route provider is retained. Fork restores navigation debug logging at `packages/tui/src/context/route.tsx:38`. |
| `packages/tui/src/context/sdk.tsx` | has-upstream-changes | Upstream SDK/event batching is retained. Fork adds smooth-streaming delta pre-merge at `packages/tui/src/context/sdk.tsx:61`; typed SDK client creation remains at `packages/tui/src/context/sdk.tsx:23`. |
| `packages/tui/src/context/sync.tsx` | has-upstream-changes | Upstream v1.17.9 capability sync is present at `packages/tui/src/context/sync.tsx:71`, `packages/tui/src/context/sync.tsx:560`, and `packages/tui/src/context/sync.tsx:609`. Fork-only YOLO/line-streaming/smooth-streaming edits are marked at `packages/tui/src/context/sync.tsx:34`, `packages/tui/src/context/sync.tsx:155`, `packages/tui/src/context/sync.tsx:230`, and `packages/tui/src/context/sync.tsx:469`. |
| `packages/tui/src/feature-plugins/home/tips-view.tsx` | has-upstream-changes | Upstream tips and shortcut wiring are retained. Differences are fork rebrands and data-engineering tips at `packages/tui/src/feature-plugins/home/tips-view.tsx:170`, `packages/tui/src/feature-plugins/home/tips-view.tsx:236`, `packages/tui/src/feature-plugins/home/tips-view.tsx:241`, `packages/tui/src/feature-plugins/home/tips-view.tsx:277`, and `packages/tui/src/feature-plugins/home/tips-view.tsx:283`. |
| `packages/tui/src/feature-plugins/sidebar/footer.tsx` | has-upstream-changes | Upstream sidebar footer plugin is retained. Difference is getting-started branding at `packages/tui/src/feature-plugins/sidebar/footer.tsx:56`. |
| `packages/tui/src/parsers-config.ts` | has-upstream-changes | Upstream parser config is retained. Differences are forked tree-sitter URLs for Vue and Clojure at `packages/tui/src/parsers-config.ts:171` and `packages/tui/src/parsers-config.ts:257`. |
| `packages/tui/src/plugin/adapters.tsx` | has-upstream-changes | Upstream plugin adapter surface is retained. Fork adds active prompt ref access for prompt-enhance plugins at `packages/tui/src/plugin/adapters.tsx:40` and `packages/tui/src/plugin/adapters.tsx:210`. |
| `packages/tui/src/routes/session/footer.tsx` | has-upstream-changes | Upstream session footer status/LSP/MCP behavior is retained. Fork adds YOLO indicator and upgrade indicator at `packages/tui/src/routes/session/footer.tsx:8`, `packages/tui/src/routes/session/footer.tsx:11`, `packages/tui/src/routes/session/footer.tsx:69`, and `packages/tui/src/routes/session/footer.tsx:101`. |
| `packages/tui/src/routes/session/index.tsx` | has-upstream-changes | Upstream v1.17.9 session-view changes are present: `alwaysSeparate` at `packages/tui/src/routes/session/index.tsx:97`, capability-gated foreground tasks at `packages/tui/src/routes/session/index.tsx:212`, background shortcut gate at `packages/tui/src/routes/session/index.tsx:1523`, and row separation at `packages/tui/src/routes/session/index.tsx:1970`. Fork edits are smooth streaming/canonical builder/calm mode at `packages/tui/src/routes/session/index.tsx:84`, `packages/tui/src/routes/session/index.tsx:326`, `packages/tui/src/routes/session/index.tsx:421`, and `packages/tui/src/routes/session/index.tsx:1703`. |
| `packages/tui/src/routes/session/permission.tsx` | has-upstream-changes | Upstream permission dialog/reject flow is retained. Differences are fork branding at `packages/tui/src/routes/session/permission.tsx:144`, `packages/tui/src/routes/session/permission.tsx:148`, and `packages/tui/src/routes/session/permission.tsx:488`. |
| `packages/tui/src/routes/session/sidebar.tsx` | has-upstream-changes | Upstream sidebar slots/workspace details are retained. Difference is fork sidebar branding at `packages/tui/src/routes/session/sidebar.tsx:91`. |
| `packages/tui/src/terminal-detection.ts` | has-upstream-changes | Fork-only added helper extracted from `app.tsx` for startup theme detection; see marker at `packages/tui/src/terminal-detection.ts:1`. No upstream counterpart is missing. |
| `packages/tui/src/theme/assets/aura.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/aura.json:2`. |
| `packages/tui/src/theme/assets/ayu.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/ayu.json:2`. |
| `packages/tui/src/theme/assets/carbonfox.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/carbonfox.json:2`. |
| `packages/tui/src/theme/assets/catppuccin-frappe.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/catppuccin-frappe.json:2`. |
| `packages/tui/src/theme/assets/catppuccin-macchiato.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/catppuccin-macchiato.json:2`. |
| `packages/tui/src/theme/assets/catppuccin.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/catppuccin.json:2`. |
| `packages/tui/src/theme/assets/cobalt2.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/cobalt2.json:2`. |
| `packages/tui/src/theme/assets/cursor.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/cursor.json:2`. |
| `packages/tui/src/theme/assets/dracula.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/dracula.json:2`. |
| `packages/tui/src/theme/assets/everforest.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/everforest.json:2`. |
| `packages/tui/src/theme/assets/flexoki.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/flexoki.json:2`. |
| `packages/tui/src/theme/assets/github.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/github.json:2`. |
| `packages/tui/src/theme/assets/gruvbox.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/gruvbox.json:2`. |
| `packages/tui/src/theme/assets/kanagawa.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/kanagawa.json:2`. |
| `packages/tui/src/theme/assets/lucent-orng.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/lucent-orng.json:2`. |
| `packages/tui/src/theme/assets/material.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/material.json:2`. |
| `packages/tui/src/theme/assets/matrix.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/matrix.json:2`. |
| `packages/tui/src/theme/assets/mercury.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/mercury.json:2`. |
| `packages/tui/src/theme/assets/monokai.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/monokai.json:2`. |
| `packages/tui/src/theme/assets/nightowl.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/nightowl.json:2`. |
| `packages/tui/src/theme/assets/nord.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/nord.json:2`. |
| `packages/tui/src/theme/assets/one-dark.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/one-dark.json:2`. |
| `packages/tui/src/theme/assets/opencode.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/opencode.json:2`. |
| `packages/tui/src/theme/assets/orng.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/orng.json:2`. |
| `packages/tui/src/theme/assets/osaka-jade.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/osaka-jade.json:2`. |
| `packages/tui/src/theme/assets/palenight.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/palenight.json:2`. |
| `packages/tui/src/theme/assets/rosepine.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/rosepine.json:2`. |
| `packages/tui/src/theme/assets/solarized.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/solarized.json:2`. |
| `packages/tui/src/theme/assets/synthwave84.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/synthwave84.json:2`. |
| `packages/tui/src/theme/assets/tokyonight.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/tokyonight.json:2`. |
| `packages/tui/src/theme/assets/vercel.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/vercel.json:2`. |
| `packages/tui/src/theme/assets/vesper.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/vesper.json:2`. |
| `packages/tui/src/theme/assets/zenburn.json` | has-upstream-changes | Upstream theme content is retained; only `$schema` is rebranded at `packages/tui/src/theme/assets/zenburn.json:2`. |
| `packages/tui/src/theme/index.ts` | has-upstream-changes | Upstream theme resolver/syntax rules are retained. Fork fixes light foreground fallback and code-block contrast at `packages/tui/src/theme/index.ts:362`, `packages/tui/src/theme/index.ts:881`, and `packages/tui/src/theme/index.ts:891`. |

No file received a `STALE-missing-X` verdict.

## Feature/Behavior Parity

No missing upstream TUI behavior/component/keybind/command was found.

Checks performed:

- All `v1.17.9` files under `packages/tui/src` exist in `HEAD`.
- No exported TUI function or exported TUI const from `v1.17.9` is absent in `HEAD`.
- No command/keybind/slash-command identifier from `v1.17.9` is absent in `HEAD`. The only missing string literals in the focused command/keymap comparison are intentional fork rebrands: `"OpenCode"` and `"https://opencode.ai/docs"`.
- Global command palette/app commands are present in `packages/tui/src/app.tsx`: sessions at `packages/tui/src/app.tsx:566`, models at `packages/tui/src/app.tsx:625`, agents at `packages/tui/src/app.tsx:673`, MCP at `packages/tui/src/app.tsx:682`, provider connect at `packages/tui/src/app.tsx:734`, org switch at `packages/tui/src/app.tsx:746`, status at `packages/tui/src/app.tsx:759`, themes at `packages/tui/src/app.tsx:768`, help at `packages/tui/src/app.tsx:796`, and docs at `packages/tui/src/app.tsx:805`.
- Session commands are present in `packages/tui/src/routes/session/index.tsx`: share/rename/timeline/fork/compact/unshare/undo/redo at `packages/tui/src/routes/session/index.tsx:470`, `packages/tui/src/routes/session/index.tsx:510`, `packages/tui/src/routes/session/index.tsx:521`, `packages/tui/src/routes/session/index.tsx:543`, `packages/tui/src/routes/session/index.tsx:565`, `packages/tui/src/routes/session/index.tsx:591`, `packages/tui/src/routes/session/index.tsx:614`, and `packages/tui/src/routes/session/index.tsx:651`; background/child navigation at `packages/tui/src/routes/session/index.tsx:1029`, `packages/tui/src/routes/session/index.tsx:1043`, `packages/tui/src/routes/session/index.tsx:1053`, `packages/tui/src/routes/session/index.tsx:1070`, and `packages/tui/src/routes/session/index.tsx:1081`.
- Dialog/component files for command palette, provider/model pickers, session list, status, theme list, variant list, workspace dialogs, timeline, and session sidebar are all present. Files that are not in the 60-file diff are byte-identical to `v1.17.9`.
- `v1.17.9` has no separate TUI trace-viewer component under `packages/tui/src`; `trace` hits in that tree are logo animation internals, not a dropped viewer. The CLI trace viewer is outside the requested TUI tree.

## Client/Server Path Mismatches

No TUI client/server path mismatch was found.

Relevant paths checked:

- TUI creates its SDK client through `createOpencodeClient` at `packages/tui/src/context/sdk.tsx:23`.
- TUI bootstrap provider/config/auth calls use the non-`/api` SDK surface: `sdk.client.config.providers` and `sdk.client.provider.list` at `packages/tui/src/context/sync.tsx:558` and `packages/tui/src/context/sync.tsx:559`; generated SDK paths are `/provider` and `/provider/auth` at `packages/sdk/js/src/v2/gen/sdk.gen.ts:3300` and `packages/sdk/js/src/v2/gen/sdk.gen.ts:3330`.
- TUI v2 data context uses `sdk.client.v2.provider.list` at `packages/tui/src/context/data.tsx:549`; generated SDK path is `/api/provider` at `packages/sdk/js/src/v2/gen/sdk.gen.ts:5524`.
- The server intentionally serves both surfaces. Legacy Hono routes mount `/provider`, `/permission`, `/config`, etc. in `packages/opencode/src/server/server.ts:171` through `packages/opencode/src/server/server.ts:281`. The `/api/*` bridge is mounted before the legacy/UI catch-all at `packages/opencode/src/server/server.ts:168` and `packages/opencode/src/server/server.ts:169`, so `/api/provider` is not accidentally proxied or dropped.

Conclusion: the TUI is not stale on `/api/provider` vs `/provider`; the fork currently has both route surfaces and the TUI uses the matching SDK client for each.

