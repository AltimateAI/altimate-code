# Reconciliation Playbook — Upstream OpenCode v1.4.0 → v1.17.9 into altimate-code

**Scope:** 3254 upstream commits. File-level bridge overlay is done. This document drives the reconciliation: re-applying customizations, repointing imports, deleting stale files, and resolving the API breaks that the overlay cannot fix mechanically.

**Marker discipline (mandatory):** every re-applied customization on an upstream-shared file goes inside `// altimate_change start — …` / `// altimate_change end`. Bug fixes use `upstream_fix:`. Run `bun run script/upstream/analyze.ts --markers --base main --strict` before any commit to upstream-shared files.

---

## 1. Executive summary

The merge is dominated by **two systemic upstream rewrites**, not a long tail of small diffs. Ranked by reconciliation risk:

**R1 — Effect-only API migration (highest risk, widest blast radius).** Upstream removed every imperative/Promise convenience wrapper across `Config`, `Provider`, `LLM`, `Agent`, `Auth`, `MCP`, `ToolRegistry`, `InstanceBootstrap`. Namespaces (`export namespace X {}`) became flat exports + `export * as X from "./x"` barrels, and zod schemas became Effect `Schema`. Our altimate consumer code calls the deleted Promise wrappers (`await Config.get()`, `await Provider.defaultModel()`, `await LLM.stream(...)`, `await MCP.add(...)`). These do not fail at overlay time — they fail at typecheck/runtime. This touches ~10 altimate files and is the bulk of the hand-work.

**R2 — Monorepo split into `@opencode-ai/core` + `@opencode-ai/tui` (highest file-count churn).** The entire `packages/opencode/src/cli/cmd/tui/**` tree moved to `packages/tui/src/**`, and the business/storage/util layer moved to `packages/core/src/**`. Opencode is now a thin V1-bridge consumer. Net effect: ~95 stale TUI files + dozens of stale core/storage files are delete-safe once the new packages land, but **~24 marker-bearing files must have their customizations re-homed first**, and our fork-original TUI files (trace dialog, upgrade indicator, tips, terminal-detection) must relocate into `packages/tui/src/**` to keep building.

**R3 — `Log` and `Flag` have NO drop-in replacement (hard compile breaks).** `util/log.ts` is deleted with no shim; the entire `Log.create({service}).info(...)` model is gone (replaced by Effect `Logging`). 14–16 fork files import it. `flag/flag.ts` moved to `@opencode-ai/core/flag/flag`, became a plain object, and dropped 6 experimental keys our `project-scan.ts` reads. These are the two cleanest "won't compile until fixed" breaks.

**R4 — The `Tool` API rewrite forces a structural rewrite of all 77 altimate/memory tools.** `Tool.define` now takes an `Effect`, `parameters` is an Effect `Schema.Struct`, and `execute` returns an `Effect.Effect<ExecuteResult>`. This is not a marker re-apply — it is a per-tool migration. `tool-lookup.ts` is the worst single case (depends on our erased `ToolRegistry.allInfos()` plus Promise-`init()` plus zod-`parameters`).

**R5 — Storage/event/account rewrites make several of our patches obsolete.** Upstream completed the event-sourcing migration our markers anticipated (`core/src/event.ts` already does `behavior: "immediate"` + unified Bus/sync registration), rebuilt DB on Effect SQL (our `backfillMigrationNames`/transaction-behavior patches target deleted code), and seeded the migration journal itself. Several `delete-obsolete` verdicts fall here — do NOT re-apply.

**Shape of the work:** repoint imports → re-home TUI/core customizations → migrate the Effect-API call sites → rewrite the 77 tools → delete stale files → run marker guard + typecheck. Detailed order in §6.

---

## 2. Breaking API changes (will break altimate code) + concrete fixes

Severity: 🔴 won't compile/run · 🟡 behavioral/type break · 🟢 compatible.

### 2.1 🔴 `Log` — deleted, no shim. Highest blast radius.
- **Was:** `import { Log } from "@/util/log"`; `Log.create({service}).info(...)`, `Log.Default.debug/.warn`.
- **Now:** `util/log.ts` removed. No `Log` namespace anywhere in `@opencode-ai/core` or opencode. Effect `Logging` (`@opencode-ai/core/observability/logging`) is the replacement — a different model (log inside an Effect).
- **Sites (14):** `altimate/enhance-prompt.ts`, `altimate/observability/{trace-consumer,tracing}.ts`, `altimate/review/ai-review.ts`, `altimate/telemetry/index.ts`, `memory/prompt.ts`, `memory/store.ts`(via `@/global` too), `altimate/skill-selector.ts`, `altimate/tools/training-{remove,import,save,list}.ts`, `altimate/fingerprint/index.ts`, `altimate/native/connections/{credential-store,registry}.ts`. Breaking usage: `Log.create(...)` (8 sites), `Log.Default.{debug,warn}` (`tracing.ts:1071,1289`).
- **Fix (recommended):** vendor a fork-local `Log` shim at `packages/opencode/src/altimate/util/log.ts` (wrapped in `altimate_change` markers) that reproduces the old imperative API over `console`/Effect `Logging`, and repoint all 14 imports to it. Lowest-risk, decouples us from upstream churn. Alternative: migrate every call site to Effect `Logging` (higher effort, not worth it for telemetry/observability code).

### 2.2 🔴 `Flag` — moved to core, object-ified, 6 keys removed.
- **Was:** `import { Flag } from "@/flag/flag"`; `namespace Flag`.
- **Now:** `@opencode-ai/core/flag/flag`; `export const Flag = {…}` (object with getters). `@/flag/flag` no longer resolves.
- **Sites:** `altimate/tools/project-scan.ts:8`, `altimate/observability/trace-consumer.ts:34`.
- **Removed keys read at `project-scan.ts:864-870`:** `OPENCODE_EXPERIMENTAL`, `OPENCODE_EXPERIMENTAL_PLAN_MODE`, `OPENCODE_EXPERIMENTAL_LSP_TOOL`, `OPENCODE_EXPERIMENTAL_OXFMT`, `OPENCODE_ENABLE_EXA`, `OPENCODE_ENABLE_QUESTION_TOOL` (and `OPENCODE_AUTO_SHARE`). All now `undefined` (silent wrong behavior + TS error).
- **Survives:** `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME` (`trace-consumer.ts:375,377`), `OPENCODE_PERMISSION` (our ADE-bench lever), `OPENCODE_EXPERIMENTAL_FILEWATCHER`.
- **🟡 type change:** `OPENCODE_EXPERIMENTAL_FILEWATCHER` is now an Effect `Config<boolean>`, not a boolean — `if (Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER)` is now always truthy. Resolve via `Config`/`Effect`, not as a bare boolean.
- **Fix:** (1) repoint both imports to `@opencode-ai/core/flag/flag`; (2) replace the 6 removed keys with local guarded env reads (`process.env["OPENCODE_EXPERIMENTAL"]` via a local `truthy()`) inside `altimate_change` markers, or drop the branches; (3) don't import `Flag` as a type.

### 2.3 🔴 `Config.get()` — Promise wrapper removed.
- **Was:** `await Config.get()` / `getGlobal`/`update`/`directories`/`invalidate`.
- **Now:** namespace exposes only `{ Service, Interface, use, layer, defaultLayer, node }`. `get` is `Service` method returning an `Effect`.
- **Sites:** `enhance-prompt.ts:76`, `tools/project-scan.ts:855`, `observability/trace-consumer.ts:85`, `telemetry/index.ts:1296`, `tools/datamate.ts:855`, dbt config readers.
- **Fix:** `Config.use((s) => s.get())` (run through our Effect runtime) or `yield* Config.Service` inside an Effect. Wrap in `altimate_change`.

### 2.4 🔴 `Config.Mcp` type removed.
- **Now:** `import { ConfigMcpV1 } from "@opencode-ai/core/v1/config/mcp"`; use `ConfigMcpV1.Info` (union of `Local`/`Remote`, discriminator `type`, `environment` field — shape-compatible).
- **Sites:** `altimate/tools/mcp-discover.ts:46,132` (`import("../../config/config").Config.Mcp`).
- **Fix:** import `ConfigMcpV1.Info`; our `cfg.type !== "local"` / `cfg.environment` checks remain valid.

### 2.5 🔴 `Provider.defaultModel/getModel/getSmallModel` — now Effect Service methods.
- **Was:** `await Provider.defaultModel()` etc. (Promise wrappers).
- **Now:** Effect `Service` methods. `parseModel`/`defaultModelIDs` remain plain. `ProviderID`/`ModelID` branded types removed (now plain `string`).
- **Sites:** `enhance-prompt.ts:90-93`, `skill-selector.ts:148-149`, `review/ai-review.ts:90-91`.
- **Fix:** `Provider.use((s) => s.getModel(p, m))` / run via runtime. Pass `string` for provider/model ids. Handle `ModelNotFoundError`/`DefaultModelError`.

### 2.6 🔴 `LLM.stream(...)` — now an Effect `Stream`, not awaitable.
- **Was:** `const s = await LLM.stream({...})`; `for await (const _ of s.fullStream)`; `s.text`.
- **Now:** `Service.stream(input: StreamInput): Stream.Stream<LLMEvent, unknown>`. No `.fullStream`/`.text`. Input renamed `StreamRequest`→`StreamInput`; `abort` moved out of `StreamInput`.
- **Sites:** `enhance-prompt.ts:117`, `skill-selector.ts:177`, `review/ai-review.ts:111`.
- **Fix:** obtain `LLM.Service` inside an Effect, call `.stream(input)`, consume with `Stream.runForEach`/`Stream.toAsyncIterable`. Drop `abort: controller.signal` from the call. Events are `LLMEvent` from `@opencode-ai/llm`.

### 2.7 🔴 `MessageV2.User` type — moved + branded fields.
- **Now:** `import { SessionV1 } from "@opencode-ai/core/v1/session"`; annotate `const user: SessionV1.User`. The `MessageV2` namespace keeps only runtime helpers (`toModelMessages`, `parts`, `get`, …), not the schema types.
- **🟡 secondary break:** `SessionV1.User` is an Effect-Schema struct: `time.created` is a branded `Timestamp`, `model.modelID` is `ModelV2.ID`, `providerID` is `ProviderV2.ID` — not plain `string`/`number`. Our literal `{ time: { created: Date.now() }, model: { providerID, modelID: model.id } }` fails typecheck.
- **Sites:** `enhance-prompt.ts:105`, `ai-review.ts:102`, `skill-selector.ts:161`.
- **Fix:** construct via `SessionV1.User.make(...)` or brand the values.

### 2.8 🔴 `MCP.add/status/tools/...` — Effect Service methods.
- **Now:** `MCP.use((s) => s.add(name, cfg))`; `add` takes `ConfigMCPV1.Info` (was `Config.Mcp`) and returns an `Effect`. Bus events moved zod→Effect `Schema` and `BusEvent.define`→`EventV2.define`.
- **Sites:** `altimate/tools/datamate.ts:176,179,192,301,347`.
- **Fix:** route through `MCP.use(...)`; rebuild `mcpConfig` to `ConfigMCPV1.Info` shape.

### 2.9 🔴 `Installation.VERSION` removed.
- **Now:** `import { InstallationVersion } from "@opencode-ai/core/installation/version"` (also `InstallationChannel`). `@/installation` still resolves but `Installation.VERSION` is `undefined`.
- **Sites:** `tools/feedback-submit.ts:81`, `telemetry/index.ts:1228,1257`.
- **Fix:** use `InstallationVersion` directly.

### 2.10 🔴 `@/global` import path moved.
- **Now:** `@opencode-ai/core/global` (`Global.Path.*` preserved there).
- **Sites:** `memory/store.ts:5`.
- **Fix:** repoint import.

### 2.11 🔴 `Server.Default().fetch(...)` — return shape changed.
- **Now:** `Server.Default()` returns `{ app }` (no top-level `fetch`). `Server.url` is `URL | undefined`.
- **Sites:** `altimate/observability/trace-consumer.ts:374`.
- **Fix:** `Server.Default().app.fetch(request)`. Audit `Server.url` for the `undefined` case.

### 2.12 🔴 `Tool` API — structural rewrite of all 77 tools.
- `import { Tool }` → `import * as Tool`; `parameters: z.object({...})` → `export const Parameters = Schema.Struct({...})`; `async execute(args, ctx) { return {...} }` → `execute: (args, ctx) => Effect.gen(...)` returning `ExecuteResult`; `Tool.define(id, obj)` → `Tool.define(id, Effect.Effect<Init>)` (now needs `Truncate.Service` + `Agent.Service` in env).
- **Extra breakage beyond boilerplate:**
  - `data-diff.ts:89`, `sql-execute.ts:32` — `await ctx.ask(...)` → `yield* ctx.ask(...)` (now an `Effect`); payload type-checked against `PermissionV1.Request` (`@opencode-ai/core/v1/permission`).
  - `tool-lookup.ts` — depends on our erased `ToolRegistry.allInfos()` (must be re-implemented against the new module-level registry), on `info.init()` being a Promise (now an `Effect`), and on `tool.parameters` being a zod schema (now a `Schema`). Replace `describeZodSchema(tool.parameters)` with a `Schema`/`jsonSchema`-based describer (`Def.jsonSchema?: JSONSchema7` is the natural replacement). Full rewrite, not a marker re-apply.
- **Overlay hygiene:** when `tool/{task,skill,plan,registry}.ts` overlay, do NOT re-introduce removed imports `TaskDescription`, `SkillDescription`, `PlanEnterTool`, `Tool.defineEffect`. Match the v1.17.9 import list (`{ TaskTool }`, `{ SkillTool }`, `{ PlanExitTool }`).

### 2.13 🟢 Verified compatible (no action)
- `Filesystem` (`@/util/filesystem`): namespace unwrapped to bare exports + `export * as Filesystem` — `Filesystem.exists/readText/writeJson/isDir` preserved (our 2 sites safe). Watch: `mimeType` is now async; `readJson<T=unknown>` is stricter. Only audit if we add new calls.
- `error`/`token`/`locale` (`@/util/*`): re-export shims keep paths working.
- `@/session/schema`: `MessageID`/`SessionID`/`PartID` still exported; `.descending()`/`.ascending()` preserved. `.make()`/`.zod()` statics removed (no fork use). `withStatics` moved to `@opencode-ai/core/schema` (only matters for `@/util/schema` importers).
- `@/auth`: barrel + `OAUTH_DUMMY_KEY` + `Auth.Oauth`/`Auth.Info` types preserved; our plugin files only use the type + `OAUTH_DUMMY_KEY`. `Auth.get/set/all/remove` statics removed (no fork callers).
- `@opencode-ai/plugin`: `Hooks`/`PluginInput` preserved (additive `workspace` fields).
- `@opencode-ai/sdk/v2`: `createOpencodeClient` unchanged.
- `Agent.Info` type still exported (our `const agent: Agent.Info = {…}` typechecks).

---

## 3. Restructure / relocations

### 3.1 TUI extraction: `packages/opencode/src/cli/cmd/tui/**` → `packages/tui/src/**`
Drop the `cli/cmd/tui/` prefix; the new prefix is `packages/tui/src/`. Notable non-trivial moves:

| Old (`…/cmd/tui/`) | New |
|---|---|
| `app.tsx` | `packages/tui/src/app.tsx` (+ new entry `index.tsx`); launcher glue → `packages/opencode/src/cli/cmd/tui.ts` |
| `worker.ts` | `packages/opencode/src/cli/tui/worker.ts` (opencode-side, NOT the tui pkg) |
| `attach.ts` | promoted to `packages/opencode/src/cli/cmd/attach.ts` |
| `thread.ts` | removed; logic → `cli/cmd/tui.ts` (`TuiThreadCommand`, `command:'$0 [project]'`) |
| `event.ts` | `packages/tui/src/context/event.ts` |
| `win32.ts` | `packages/tui/src/terminal-win32.ts` |
| `component/border.tsx` | `packages/tui/src/ui/border.ts` (moved to ui/, .tsx→.ts) |
| `component/dialog-command.tsx` | removed → `component/command-palette.tsx` + `keymap.tsx` |
| `component/textarea-keybindings.ts`, `context/plugin-keybinds.ts` | removed (folded into keymap engine) |
| `component/prompt/part.ts`, `component/prompt/stash.tsx` | `packages/tui/src/prompt/part.ts`, `prompt/stash.tsx` |
| `context/keybind.tsx` | `packages/tui/src/config/keybind.ts` (.tsx→.ts) |
| `context/tui-config.tsx` | `packages/tui/src/config/index.tsx` |
| `context/theme/*.json` | `packages/tui/src/theme/assets/*.json` |
| `util/editor.ts`, `util/clipboard.ts` | `packages/tui/src/editor.ts`, `src/clipboard.ts` (out of util/) |
| `util/terminal.ts` | removed (absorbed into `terminal-win32.ts`) |
| `component/workspace/dialog-session-list.tsx` | removed (superseded by `dialog-workspace-*` family) |

All other `component/*`, `context/*`, `routes/*`, `ui/*`, `util/{model,provider-origin,scroll,selection,signal,transcript}.ts` map 1:1 to `packages/tui/src/…` with the prefix dropped.

### 3.2 Core/server/llm/storage extraction → `@opencode-ai/core`, `@opencode-ai/server`, `@opencode-ai/llm`
opencode is now a thin V1-bridge consumer (`workspace:*` deps on core/llm/server/tui/http-recorder; the old `@opencode-ai/util` dep dropped; `packages/util/**` is gone). Key moves:

| Old (`opencode/src/`) | New |
|---|---|
| `filesystem/**`, `global/index.ts`, `npm/index.ts`, `pty/**`, `shell/shell.ts`, `flag/flag.ts` | `core/src/{filesystem,global,npm,pty,shell,flag/flag}` |
| `file/{ignore,protected,watcher}.ts` | `core/src/filesystem/{ignore,protected,watcher}.ts` |
| `file/ripgrep.ts` | `core/src/ripgrep.ts` |
| `util/{abort,color,context,effect-zod,log,…}.ts` (moved subset) | `core/src/util/*` (`log.ts` deleted, no successor) |
| `storage/{db,db.bun,db.node,schema.sql,json-migration}.ts` | `core/src/database/{database,sqlite.bun,sqlite.node,schema.sql,migration}.ts` (`json-migration` dropped) |
| `account/account.sql.ts` | `core/src/account/sql.ts` |
| `{control-plane/workspace,project/project,session/session,share/share}.sql.ts` | `core/src/{control-plane/workspace,project/sql,session/sql,share/sql}` |
| `sync/event.sql.ts` | `core/src/event/sql.ts` (sync→event rename) |
| `server/{router,middleware,error,instance,proxy}.ts` + `server/routes/*.ts` | `server/routes/instance/httpapi/{groups,handlers,middleware}/*` (Hono→Effect HttpApi); contract in `@opencode-ai/server` |
| `provider/{models,schema}.ts`, `provider/sdk/copilot/**` | `core/src/{models-dev,provider,model}.ts`, `@opencode-ai/llm` |
| `bus/index.ts`, `bus/bus-event.ts`, `sync/index.ts` | folded into `core/src/event.ts` (only `bus/global.ts` `GlobalBus` remains) |

**Survivors in place:** `storage/{storage,schema}.ts`, `server/server.ts`, `sync/{schema.ts,README.md}`, `session/validators/{registry,types}.ts` (altimate-only). Migration folder `packages/opencode/migration/20260511173437_session-metadata/` still ships upstream — keep it; delete only the 10 pre-session-metadata Drizzle folders.

### 3.3 Config-cli-misc smaller moves
- `installation/meta.ts` → `core/src/installation/version.ts` (`InstallationVersion`/`InstallationChannel`).
- `project/instance.ts` → split: `instance-context.ts` (`containsPath`/boundary), `instance-store.ts`, `instance-layer.ts`, `instance-runtime.ts`; the realpath logic landed in `core/src/location-mutation.ts`.
- `project/state.ts`, `project/schema.ts`, `project/project.sql.ts` — removed (folded into instance-store / `project.ts` / control-plane store).
- `config/{tui-schema,console-state}.ts` — removed (TUI schema → `@opencode-ai/tui/config`; console moved out of `config/`).
- `acp/types.ts`, `acp/README.md` — removed (types distributed across new per-concern `acp/*.ts`).

### 3.4 Consolidated DELETE list (stale, NO markers — safe once new packages land)
Delete these after the new packages are in place and the marker-bearing files in §4 are migrated:

- **TUI:** the entire `packages/opencode/src/cli/cmd/tui/**` tree **except** the marker-bearing/fork-original files in §4. ~95 unmarked files (all `ui/*`, unmarked `component/*`, `component/prompt/*`, unmarked `context/*` + `context/theme/*.json`, unmarked `routes/*`, unmarked `util/*`, plus `event.ts`, `win32.ts`, `textarea-keybindings.ts`, `context/plugin-keybinds.ts`, `context/tui-config.tsx`, `util/terminal.ts`, `component/workspace/dialog-session-list.tsx`).
- **Core/storage:** `src/filesystem/**`, `global/**`, `npm/**`, `pty/**`, `shell/**`, `flag/**`, `file/**`; `storage/{db.bun,db.node,db,schema.sql,json-migration}.ts`; `account/account.sql.ts`; `{control-plane/workspace,project/project,session/session,share/share}.sql.ts`; `server/{router,middleware,error,instance,proxy}.ts` + `server/routes/*.ts`; `provider/{models,schema}.ts` + `provider/sdk/copilot/**`; `util/{abort,color,context,effect-zod,log,…}.ts` (moved subset); `drizzle.config.ts`; `packages/util/**`; the 10 pre-session-metadata Drizzle migration folders.
- **Config-misc:** `config/console-state.ts`, `config/tui-schema.ts`, `installation/meta.ts`, `project/schema.ts`, `project/project.sql.ts`, `acp/types.ts`.

### 3.5 Files marked `delete-obsolete` (host code rewritten upstream — DO NOT re-apply the customization)
- `src/bus/bus-event.ts` — BusEvent registry replaced by plain EventEmitter; idempotent-define no longer applies.
- `src/control-plane/workspace-router-middleware.ts` — routing rebuilt in `server/routes/instance/httpapi/middleware/workspace-routing.ts`; `Adaptor.fetch→target()` regression gone.
- `src/file/index.ts` — `File` namespace + Ripgrep loop gone; enumeration owned by native `@ff-labs/fff`.
- `src/file/time.ts` — `FileTime` service deleted; staleness now via `Watcher`.
- `src/project/state.ts` — `State` registry has no consumers; per-instance caching moved to `effect/instance-state.ts` / `instance-store.ts`.
- `src/provider/models.ts` — rearchitected to `core/src/models-dev.ts`; the `setTimeout(...,0)` circular-dep hack is structurally moot (see §5).
- `src/session/projectors.ts` — depends on removed `SyncEvent.project`; projection now `core/src/session/projector.ts` + `server/projectors.ts`.
- `src/storage/db.ts` — `Database` namespace replaced by `EffectDrizzleSqlite`; `backfillMigrationNames` + transaction-behavior patches target deleted code (journal seeding now in `core/src/database/migration.ts`; `immediate` handled in `core/src/event.ts`).
- `src/sync/index.ts` — `SyncEvent` runtime removed; `core/src/event.ts` already does unified define + `{behavior:"immediate"}`.
- `test/skill/release-v0.7.2-adversarial.test.ts`, `test/upstream/v140-merge-adversarial.test.ts` — version-pinned to old releases/the prior merge; supersede with current-cut guards.

---

## 4. Customization migrations (re-home `altimate_change` before deleting old file)

Grouped by target. Re-apply the marked diff at the new path inside `altimate_change` markers, then delete the old file.

### → `packages/tui/src/**` (TUI extraction)
| Old `…/cmd/tui/` | New path | Customization (blocks) |
|---|---|---|
| `app.tsx` (14) | `cli/cmd/tui.ts` + `packages/tui/src/app.tsx` (split) | trace viewer server, session-trace history cmd, open-trace-in-browser, variant_list keybind (#21185), COLORFGBG eager check (#704), disableStdoutInterception fix, altimate docs URL, upgrade branding |
| `context/sync.tsx` (9) | `packages/tui/src/context/sync.tsx` | yolo auto-approve, line-streaming buffer/flush, smooth-streaming direct-path update |
| `component/dialog-skill.tsx` (9) | `packages/tui/src/component/dialog-skill.tsx` | domain categorization, inline skill ops, create/install sub-dialogs, toasts, refetch — heavy rewrite |
| `component/dialog-provider.tsx` (7) | `packages/tui/src/component/dialog-provider.tsx` | altimate-backend credential write via `AltimateApi`, validation-error signal, custom placeholder/format |
| `routes/session/index.tsx` (7) | `packages/tui/src/routes/session/index.tsx` | gate setWorkspace on workspaceID change, `builder` agent name, smooth-streaming scroll/memoize, calm-mode width cap, light-theme md fg |
| `routes/home.tsx` (5) | `packages/tui/src/routes/home.tsx` | upgrade-indicator placement, first-time onboarding hint, beginner-tips flag, race-fix |
| `component/prompt/index.tsx` (5) | `packages/tui/src/component/prompt/index.tsx` | enhance command + import, skills-dialog keybind, auto-enhance before paste-expand, enhance hint |
| `routes/session/footer.tsx` (4) | `packages/tui/src/routes/session/footer.tsx` | yolo indicator + upgrade indicator |
| `context/theme.tsx` (3) | `packages/tui/src/context/theme.tsx` | light-mode fg fallback (#704), code-block bg, inline-code contrast |
| `routes/session/sidebar.tsx` (3) | `packages/tui/src/routes/session/sidebar.tsx` | trace section + branding |
| `context/sdk.tsx` (2) | `packages/tui/src/context/sdk.tsx` | smooth-streaming delta pre-merge |
| `context/route.tsx` (2) | `packages/tui/src/context/route.tsx` | upstream_fix: navigate debug-log restore (verify still needed) |
| `component/dialog-mcp.tsx` (1) | `packages/tui/src/component/dialog-mcp.tsx` | upstream_fix: structured logger (verify; v1.17.9 may already do this) |
| `component/error-component.tsx` (1) | `packages/tui/src/component/error-component.tsx` | upstream_fix: fatal-error prefix branding |
| `component/logo.tsx` (1) | `packages/tui/src/component/logo.tsx` | theme-color fix (verify against new tokens) |
| `component/dialog-status.tsx` (1) | `packages/tui/src/component/dialog-status.tsx` | upstream_fix: branding fix (verify) |
| `component/dialog-workspace-list.tsx` (1) | `packages/tui/src/component/dialog-workspace-list.tsx` | upstream_fix: structured logger (verify) |
| `util/clipboard.ts` (1) | `packages/tui/src/clipboard.ts` | upstream_fix: structured logger (v1.17.9 already avoids console.log — likely droppable) |
| `attach.ts` (2) | `cli/cmd/attach.ts` | branding + basic-auth username must match server |
| `thread.ts` (3) | `cli/cmd/tui.ts` (`TuiThreadCommand`) | branding ('start altimate-code tui') + internal worker URL |
| `worker.ts` (8) | `cli/tui/worker.ts` | TraceConsumer wiring, per-session shared consumer, clear stale per-stream state, load tracing config first, flush on shutdown, workspaceID idempotency guard — reconcile vs new Effect worker |
| `context/theme/*.json` (brand markers) | `packages/tui/src/theme/assets/*.json` | brand-color overrides (cursor, rosepine, kanagawa, ayu, …) |
| `component/tips.tsx` (3) | `packages/tui/src/feature-plugins/home/tips.tsx` | DE/beginner/training tips (note: moved to feature-plugins/home) |

**Fork-original TUI files (no upstream merge — relocate to keep wired into the new package):**
- `component/dialog-trace-list.tsx` (4) → `packages/tui/src/component/dialog-trace-list.tsx`
- `component/upgrade-indicator.tsx` (1) + `component/upgrade-indicator-utils.ts` → `packages/tui/src/component/`
- `util/terminal-detection.ts` (1) → `packages/tui/src/util/terminal-detection.ts`
- `context/theme/altimate-code.json` → `packages/tui/src/theme/assets/` (non-conflicting asset name)

### → `packages/core/src/**`
| Old | New | Customization |
|---|---|---|
| `flag/flag.ts` | `core/src/flag/flag.ts` | dual `ALTIMATE_CLI_*`/`OPENCODE_*` env, Memory opt-out, session auto-extract, yolo, calm, training opt-out, declared flags |
| `global/index.ts` | `core/src/global.ts` (line ~10 `const app`) | brand `"altimate-code"` (was `"opencode"`) |
| `file/protected.ts` | `core/src/filesystem/protected.ts` | `SENSITIVE_DIRS`/`SENSITIVE_FILES` deny-list + `isSensitiveWrite()` + scanner-evasion string assembly (upstream has only `names()/paths()`) |
| `provider/schema.ts` | `core/src/provider.ts` (`ProviderV2.ID`) | add `snowflake-cortex` + `databricks` to well-known list |
| `pty/index.ts` | `core/src/pty.ts` (~line 200) | prepend `ALTIMATE_BIN_DIR` + project/worktree/global `.opencode/tools` to PATH |
| `tool/bash.ts` | `core/src/tool/bash.ts` (spawn path, TODO line ~84) | PATH-prepend + strip `ALTIMATE_NON_INTERACTIVE` from child env (#937) — adapt to Effect harness |
| `session/index.ts` | `core/src/session/runner/publish-llm-event.ts` | clamp input tokens ≥0; inputTotal incl. cached (verify: upstream already clamps via `safe()`; re-derive from `{input,cache:{read,write}}` if telemetry needs it) |
| `project/instance.ts` | `core/src/location-mutation.ts` (line ~83) | security: realpath-before-boundary symlink-escape block (upstream already `fs.realPath(...)` — verify equivalence, may be droppable) |
| `test/pty/pty-session.test.ts` | `core/test/pty/pty-session.test.ts` | flaky-timeout (10s) + `{timeout:15000,retry:2}` |
| `test/tool/bash.test.ts` | `core/test/tool-bash.test.ts` | PATH-injection describe block (adapt to Effect harness) |

### → opencode-side httpapi rewrite (`server/routes/instance/httpapi/**`)
| Old | New | Customization |
|---|---|---|
| `server/routes/global.ts` | `httpapi/groups/global.ts` | upstream_fix: rebrand 'Upgrade opencode' → 'Upgrade Altimate Code' |
| `server/routes/permission.ts` | `httpapi/handlers/permission.ts` | upstream_fix: wire to Effect Permission service (largely upstreamed — verify) |
| `server/routes/provider.ts` | `httpapi/handlers/provider.ts` | surface unauthenticated custom providers (Snowflake Cortex) via `Provider.all()` — re-add branch |
| `server/routes/session.ts` | `httpapi/groups/session.ts` + `handlers/session.ts` | optional `messageID` on diff query (the `PermissionNext` half is `drop-accept-upstream`, see §5) |
| `server/instance.ts` | `server/shared/ui.ts` | upstream_fix: null-safe embedded-UI fallback → proxy `app.altimate.ai`; `DEFAULT_CSP` (largely upstreamed — verify proxy target + CSP, marker mostly droppable). Also re-home the altimate routes/`app.altimate.ai` proxy blocks into the httpapi group structure. |

### → opencode-side (other)
| Old | New | Customization |
|---|---|---|
| `account/index.ts` | `account/account.ts` | re-add the async `config(accountID, orgID)` Promise facade consumed by `config/config.ts` (`core/src/account.ts` has no `config()` export) |
| `plugin/codex.ts` | `plugin/openai/codex.ts` | KEEP: 3-attempt OAuth retry (4xx/5xx-aware) + 30s skew buffer (note new `issuer` param); DROP escapeHtml marker (now upstream) |
| `plugin/copilot.ts` | `plugin/github-copilot/copilot.ts` | User-Agent brand at 4 sites (use new `InstallationVersion` symbol). NOTE: `plugin/copilot.ts` is a fork-local duplicate with no upstream counterpart — verify it isn't dead and consider deleting it wholesale instead of carrying. |
| `config/migrate-tui-config.ts` | `config/tui-migrate.ts` | move the altimate.ai schema-URL change into the live `tui-migrate.ts`; drop the dead duplicate |
| `skill/skill.ts` | `skill/index.ts` | migrate embedded-builtin-skills, auto-load (Always-Apply), `builtin:` protocol into canonical upstream `skill/index.ts`; retire `skill.ts` |
| `util/instance-state.ts` | `effect/instance-state.ts` | retire our bridge copy; upstream `effect/instance-state.ts:38` already has the `registerDisposer` wiring — verify equivalence |

---

## 5. `upstream_fix` decisions

**Totals: 24 re-evaluated markers → KEEP (genuine bug, still unfixed): 7 · KEEP-BRANDING (mislabeled, permanent): 13 · DROP (accept upstream): 2 · KEEP but RETAG (not actually an upstream fix): 1 (also counted under KEEP).**

### DROP — accept upstream (2)
- **`provider/models.ts:155-168`** — `setTimeout(...,0)` circular-dep defer. Host file gone; `core/src/models-dev.ts` makes `USER_AGENT` an eager const and runs refresh in an Effect fiber. The hazard is structurally gone. Nothing to carry.
- **`server/routes/session.ts:18-22`** — `PermissionNext` import bridging a split-brain. v1.17.9 unified into a single `Permission.Service`; no `permission/next.ts`, zero `PermissionNext` refs. Host file moved to `httpapi/handlers/permission.ts`. Accept the unified architecture. (The unrelated optional-`messageID` change on the same route is a separate `migrate`, see §4.)

### KEEP — genuine bug still unfixed upstream (7)
- **`util/locale.ts:57-60`** — `duration()` days/hours math swapped upstream (`hours = floor(input/3600000)`, `days` always 0). Re-apply our fix at the new home `packages/tui/src/util/locale.ts` (opencode copy is now a re-export).
- **`util/filesystem.ts:72-74`** and **`:83-85`** — `write()` (primary + ENOENT/mkdir retry branch) still lacks `await chmod(p, mode)` after `writeFile`; umask-affects-mode bug persists. `chmod` already imported. Re-apply both (namespace wrapper dropped upstream — structure shifted, bug remains).
- **`plugin/codex.ts:133-167`** — 3-attempt OAuth refresh retry (4xx/5xx-aware); upstream `plugin/openai/codex.ts:124` is still a single fetch. Re-apply over moved file (new `issuer` param).
- **`plugin/codex.ts:449-455`** — 30s token-skew buffer; upstream still bare `expires < Date.now()`. Re-apply over moved file.
- **`provider/error.ts:31-45`** — `model_not_found` 404 retry carve-out; upstream still forces all 404s retryable. Keep.
- **`provider/error.ts:79-101`** — `message()` typeof-string chain; upstream still has the short-circuit-on-truthy-parent bug (`body.message || body.error || body.error?.message`). Keep.
- **`provider/error.ts:188-212`** — `parseStreamError` generic fallback for non-OpenAI shapes; upstream has no generic path (added 2 new switch cases — note on re-apply). Keep.

### KEEP-BRANDING — mislabeled `upstream_fix`, permanent fork brand (13)
All are brand strings/paths upstream will never converge on; never accept upstream:
- `plugin/install.ts:337-351` (×2 entries) — `.opencode/` → `.altimate-code/` install dir with fallback.
- `plugin/install.ts:355-360` (×2 entries) — server config filename `opencode.json` → `altimate-code.json` (preserve the widened `patchName` return union on re-apply).
- `plugin/github-copilot/copilot.ts:54-56, 137-139, 215-217, 247-249` (4) — User-Agent brand. **Hazard:** upstream renamed `Installation.VERSION` → `InstallationVersion` (from `@opencode-ai/core/installation/version`) — the brand line must use the new symbol or it won't compile.
- `plugin/copilot.ts:125-127, 205-207, 237-239` (3) — User-Agent brand on the fork-local duplicate (no upstream counterpart; verify it isn't dead and consider deleting).
- `provider/provider.ts:589-591` (1) — GitLab AI gateway User-Agent brand (upstream `provider.ts:608` still `opencode/...`).

### KEEP + RETAG (1)
- **`skill/followups.ts:156-162`** — entire file is altimate-authored; the inner `upstream_fix` (prototype-pollution `Object.hasOwn` guard + `Object.freeze`) is real defensive code but there is no upstream to compare to. Keep the code; retag the inner block as a plain `altimate_change` (it is not an upstream bug fix).

---

## 6. Ordered action checklist (most-blocking first)

The goal is a green typecheck/build. Do these in order; each phase unblocks the next.

**Phase 0 — land the new packages.** Ensure `packages/tui`, `packages/core`, `packages/server`, `packages/llm`, `packages/http-recorder`, `packages/effect-drizzle-sqlite`, `packages/effect-sqlite-node` are present and `opencode/package.json` has the `workspace:*` deps (and the `@opencode-ai/util` dep is dropped). Nothing below compiles until these resolve.

**Phase 1 — repoint dead import paths (cheap, unblocks typecheck of many files).**
1. `@/flag/flag` → `@opencode-ai/core/flag/flag` (`project-scan.ts:8`, `trace-consumer.ts:34`).
2. `@/global` → `@opencode-ai/core/global` (`memory/store.ts:5`).
3. `Installation.VERSION` → `InstallationVersion` from `@opencode-ai/core/installation/version` (`feedback-submit.ts:81`, `telemetry/index.ts:1228,1257`).
4. `Config.Mcp` → `ConfigMcpV1.Info` from `@opencode-ai/core/v1/config/mcp` (`mcp-discover.ts:46,132`).
5. `MessageV2.User` → `SessionV1.User` from `@opencode-ai/core/v1/session` (3 files).

**Phase 2 — `Log` shim (unblocks ~14 files at once).** Vendor `altimate/util/log.ts` reproducing the old `Log.create`/`Log.Default` API; repoint all 14 imports. Without this, most altimate files won't compile.

**Phase 3 — Flag member fixes.** Replace the 6 removed keys at `project-scan.ts:864-870` with guarded `process.env` reads (or drop). Treat `OPENCODE_EXPERIMENTAL_FILEWATCHER` as `Config<boolean>`.

**Phase 4 — Effect-API call-site migrations (the core of R1).** Rewrite to run through Effect runtime:
- `Config.get()` (6 sites) → `Config.use((s)=>s.get())`.
- `Provider.defaultModel/getModel/getSmallModel` (3 files) → `Provider.use(...)`; ids as `string`.
- `LLM.stream(...)` (3 files) → `LLM.Service.stream` → `Stream` consumption; drop `abort` from input; `.fullStream`/`.text` gone.
- `MCP.add/status/tools` (`datamate.ts`) → `MCP.use(...)`; `ConfigMCPV1.Info` shape.
- `Server.Default().fetch` → `.app.fetch` (`trace-consumer.ts:374`).
- `SessionV1.User` literals → `.make(...)` for branded fields.

**Phase 5 — Tool API rewrite (R4, largest single effort).** Migrate all 77 altimate/memory tools to `import * as Tool` + `Parameters = Schema.Struct` + `execute => Effect.gen` returning `ExecuteResult`. Then the two extra cases: `data-diff.ts:89` / `sql-execute.ts:32` (`await ctx.ask` → `yield* ctx.ask`, `PermissionV1.Request`), and a full rewrite of `tool-lookup.ts` (re-implement `ToolRegistry.allInfos()`; `info.init()` is now an Effect; replace `describeZodSchema` with a `Schema`/`jsonSchema` describer).

**Phase 6 — re-home TUI customizations into `packages/tui/src/**`** (§4 TUI table + fork-original relocations). Build the tui package green.

**Phase 7 — re-home core/opencode customizations** (§4 core + httpapi + other tables): `flag`, `global`, `protected`, `provider` well-known list, `pty`/`bash` PATH, `account.config()` facade, copilot/codex/provider branding + retries, `skill/index.ts` consolidation, `migrate-tui-config`→`tui-migrate`, retire `util/instance-state.ts`.

**Phase 8 — apply `upstream_fix` verdicts (§5):** re-apply the 7 KEEP bug fixes at their new homes; re-apply the 13 KEEP-BRANDING (mind the `InstallationVersion` symbol rename on copilot UA); DROP the 2 (`models.ts` defer, session `PermissionNext`); retag `skill/followups.ts` inner block.

**Phase 9 — delete stale files (§3.4 + §3.5).** Only after Phases 6–8 confirm every customization is re-homed. Delete the unmarked TUI/core/storage/config files, the `delete-obsolete` markered files, and the version-pinned stale tests.

**Phase 10 — verify.**
- `bun run script/upstream/analyze.ts --markers --base main --strict` (zero unwrapped customizations).
- `bun run script/upstream/analyze.ts --audit-fixes` (confirm the carried `upstream_fix` set matches §5).
- Typecheck + build green across `packages/{opencode,core,tui,server,llm}`.
- Run the fork-only guards: `test/branding/*`, `test/upstream/altimate-features.test.ts`, `test/altimate/**`, and re-homed `core/test/{pty/pty-session,tool-bash}.test.ts`.
- `/consensus:code-review` before committing (per project workflow).

**Standalone (no action needed):** all `keep-standalone` files (the entire `src/altimate/**`, `memory/**`, `session/validators/**`, `skill/followups.ts`, `provider/family.ts`, `mcp/{config,discover}.ts`, `telemetry/index.ts` shim, `cli/cmd/{check,gitlab,skill,trace,…}.ts`, `cli/welcome.ts`, `packages/drivers/**`, `script/upstream/**`, all `test/altimate/**` and branding/upstream guard tests) are fork-original with no upstream counterpart — leave in place. Their "deleted upstream" flag is a false positive from the overlay diff.