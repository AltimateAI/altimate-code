# ADR: Fork TUI features as host-registered plugins (v1.17.9 merge)

**Date:** 2026-06-23
**Status:** Accepted
**Context:** upstream merge `upstream/merge-v1.17.9` (OpenCode v1.4.0 → v1.17.9)

## Problem

Upstream v1.17.0 extracted the TUI from `packages/opencode/src/cli/cmd/tui/**` into a
standalone package `packages/tui` (`@opencode-ai/tui`) that depends only on
`@opencode-ai/core | plugin | sdk` — **not** on the `opencode` package. Several fork TUI
**features** depend on opencode-package code that is therefore unreachable from `packages/tui`:

| Feature | Opencode-side dependency |
|---|---|
| dialog-provider (altimate-backend credential flow) | `AltimateApi` (`altimate/api/client.ts`) |
| dialog-skill (inline skill create/install/test) | `skill-helpers` (`cli/cmd/skill-helpers.ts`) |
| prompt enhance (auto-rewrite before send) | `enhance-prompt.ts` (Provider/LLM/Agent/Config) |
| trace viewer (server + session-trace history + open-in-browser) | `altimate/observability/**` |

The naive fixes both have serious downsides:
- **Move shared code into `@opencode-ai/core`** — drags Provider/LLM/Agent/observability/HTTP
  clients down into core, risks cycles, and bloats the shared package. And the feature UI still
  has to be re-applied as `altimate_change` edits inside upstream `packages/tui` files → every
  future merge re-conflicts on them.
- **Inline `altimate_change` edits in `packages/tui`** — maximal future-merge cost; the whole
  reason this merge was expensive is fork edits scattered through upstream files.

## Decision

**Fork TUI features are implemented as host-registered `TuiPlugin`s living in opencode-side,
fork-owned files — NOT as edits to upstream `packages/tui` files.**

The mechanism already exists and is the intended extension path:

- `packages/tui` renders builtin + host-supplied plugins. Each plugin is a `TuiPlugin`
  (`async (api: TuiPluginApi) => { api.slots.register(...) / api.command... / api.keymap... }`).
- The **host (opencode) composes the plugin list** in
  `packages/opencode/src/plugin/tui/internal.ts` (`internalTuiPlugins()` →
  `createBuiltinPlugins()`), passed into the TUI via `cli/cmd/tui.ts` `pluginHost`.
- `TuiPluginApi` exposes everything a feature needs without touching tui internals:
  `slots.register`, `command`, `keymap`, `dialog` (push dialogs), `navigate`, `toast`,
  `state`, `theme`, and `client: OpencodeClient` (the SDK).

Because fork plugins are authored in **opencode-side** files, they freely `import { AltimateApi }`,
`enhancePrompt`, observability, etc. — the dependency direction (opencode → tui) already works.
Upstream `packages/tui/**` files stay byte-for-byte upstream.

### Wiring

Fork plugins live under `packages/opencode/src/plugin/tui/altimate/`, aggregated by
`altimateTuiPlugins(flags)`, appended to the builtin list in `internal.ts` inside
`altimate_change` markers (the only fork edit, in an already-fork-thin file).

### What stays inline (unavoidable, accepted)

Pure branding strings/colors and deep behavioral hooks that are NOT slot/command/dialog-shaped
**cannot** be plugins and remain as small `altimate_change`-marked edits in `packages/tui`,
gated on flags where behavioral:
- branding: logo colors, "Altimate Code" strings, docs URL, theme contrast values.
- behavioral: `sync.tsx` smooth/line-streaming + yolo, `session/index.tsx` scroll/width-cap.

These are intentionally the *minimal* inline surface. Everything feature-shaped is a plugin.

## Consequences

- **Future merges easy:** upstream `packages/tui` files carry no feature code; merges of that
  package are clean. Fork TUI surface = a fork-owned plugin directory + a handful of small marked
  branding/behavioral edits.
- **No feature loss:** every feature has a concrete home (plugin or marked edit). Deferred
  features (dialogs, enhance, trace) are re-homed as plugins; their pre-merge sources are on
  `main` (`git show main:packages/opencode/src/cli/cmd/tui/...`).
- **No core bloat / no cycles:** opencode-side deps stay opencode-side.
- **Cost:** dialogs/enhance/trace are re-authored against the plugin API (`api.dialog`,
  `api.command`, `api.client`) rather than transplanted — a one-time port, tracked per feature.

## Re-home plan (per feature → plugin)

1. **provider-credentials** — `api.command` + `api.dialog` to collect the key; opencode-side
   `AltimateApi.{parseAltimateKey,validateCredentials,saveCredentials}` for the write. Source:
   `main:.../tui/component/dialog-provider.tsx`.
2. **skill-ops** — `api.dialog` skill list + create/install/test actions; opencode-side
   `skill-helpers.detectToolReferences`. Port keybinds to `api.keymap`. Source:
   `main:.../tui/component/dialog-skill.tsx`.
3. **prompt-enhance** — `api.command`/`api.keymap` "enhance" bound on the prompt; opencode-side
   `enhancePrompt`/`isAutoEnhanceEnabled`. Source: `main:.../tui/component/prompt/index.tsx`.
4. **trace-viewer** — `api.command` "view traces" + `api.slots` sidebar trace section; opencode
   `altimate/observability` for the data + the existing trace viewer server. Source:
   `main:.../tui/app.tsx` (blocks 35/42/69/95/301/315/738) + `dialog-trace-list.tsx`.
