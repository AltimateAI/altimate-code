// altimate_change start — fork TUI feature: auto-rewrite the prompt with a small model.
//
// Re-homed from the pre-merge inline `altimate_change` blocks in
// packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx (see
// docs/internal/2026-06-23-tui-fork-features-as-plugins-adr.md, re-home plan item 3).
//
// This is an opencode-side, fork-owned plugin: it imports opencode-package code
// (enhancePrompt / isAutoEnhanceEnabled from @/altimate/enhance-prompt) directly — the whole
// point of the ADR — and acts through the TuiPluginApi (api.keymap / api.ui.toast) so upstream
// packages/tui stays untouched.
//
// Trigger: an "Enhance prompt" command registered on the keymap, bound to the `prompt_enhance`
// keybind. On trigger it should read the current prompt input, await enhancePrompt(it), and write
// the result back. The plugin api does NOT expose a way to reach the active/focused prompt input
// ref (see the DEFERRED note at the bottom), so the read/write is deferred and the command
// currently surfaces a toast explaining the missing surface.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { enhancePrompt, isAutoEnhanceEnabled } from "@/altimate/enhance-prompt"

const id = "altimate:prompt-enhance"

// Guard against concurrent enhancement calls from rapid triggers (matches the pre-merge
// `enhancingInProgress` flag on the prompt component).
let enhancingInProgress = false

/**
 * Enhance an arbitrary prompt string with the small model.
 *
 * Returns the enhanced text, or `undefined` when nothing should change (empty input, a call
 * already in flight, or the model returned the original text unchanged). Toast feedback mirrors
 * the pre-merge "prompt.enhance" command.
 *
 * The caller is responsible for reading the current prompt input and writing the result back —
 * the plugin api does not expose the active prompt ref (see DEFERRED note).
 */
async function enhance(api: TuiPluginApi, original: string): Promise<string | undefined> {
  if (!original.trim()) return undefined
  if (enhancingInProgress) return undefined

  enhancingInProgress = true
  api.ui.toast({ message: "Enhancing prompt...", variant: "info", duration: 2000 })
  try {
    const enhanced = await enhancePrompt(original)
    if (enhanced === original) {
      api.ui.toast({ message: "Prompt already looks good", variant: "info", duration: 2000 })
      return undefined
    }
    api.ui.toast({ message: "Prompt enhanced", variant: "success", duration: 2000 })
    return enhanced
  } catch {
    api.ui.toast({ message: "Failed to enhance prompt", variant: "error", duration: 3000 })
    return undefined
  } finally {
    enhancingInProgress = false
  }
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "altimate.prompt.enhance",
        title: "Enhance prompt",
        category: "Prompt",
        run() {
          // DEFERRED: the plugin api exposes no way to read the active prompt input, so we cannot
          // recover the text to enhance here. Surface the gap instead of silently doing nothing.
          // Once an active-prompt accessor exists, this becomes:
          //   const ref = api.<active prompt ref>
          //   const enhanced = await enhance(api, ref.current.input)
          //   if (enhanced !== undefined) ref.set({ ...ref.current, input: enhanced })
          void enhance
          void isAutoEnhanceEnabled
          api.ui.toast({
            variant: "warning",
            message: "Prompt enhance needs an active-prompt accessor on the TUI plugin api (deferred)",
          })
        },
      },
    ],
    // Bind to the fork `prompt_enhance` keybind (the pre-merge command used `keybind: "prompt_enhance"`).
    bindings: api.tuiConfig.keybinds.gather("altimate.prompt.enhance", ["altimate.prompt.enhance"]),
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

// DEFERRED — the read/write/submit half of this feature cannot be mapped to the current plugin api:
//
// MISSING API SURFACE: an accessor on `TuiPluginApi` for the *currently active / focused* prompt
// input ref. The `TuiPromptRef` type (packages/plugin/src/tui.ts, lines 201-209) exposes exactly
// what this feature needs — `current.input` (read), `set(prompt)` (write), `submit()` — but the
// api only ever hands a `TuiPromptRef` to a slot's own `ref` callback (the `home_prompt` /
// `session_prompt` slots, TuiHostSlotMap lines 459-469). Those prompt slots are rendered by the
// upstream host (packages/tui/src/routes/home.tsx and routes/session/index.tsx via the internal
// `usePromptRef` context, packages/tui/src/context/prompt.tsx) — a plugin cannot reach that ref.
// There is no `api.prompt.active` / `api.prompt.current()` / `api.ui.Prompt`-instance handle.
//
// Consequently the two read/write paths from the pre-merge source are NOT ported:
//   1. The "prompt.enhance" command body — read `store.prompt.input`, `enhancePrompt(it)`, then
//      `input.setText(enhanced)` (needs read + write of the active prompt).
//   2. The auto-enhance-before-submit path (`isAutoEnhanceEnabled()` gating + rewrite inside the
//      submit handler) and the enhance hint footer — both live inside the upstream prompt
//      component's submit/render and have no plugin-api hook (no pre-submit interceptor, no
//      prompt-hint slot for the focused prompt).
//
// The `enhance()` helper + `isAutoEnhanceEnabled` import are kept ready: once the api exposes the
// active prompt ref (e.g. `api.prompt.active(): TuiPromptRef | undefined`) the command body and an
// `isAutoEnhanceEnabled()`-gated pre-submit hook can be wired with no further opencode-side work.
// altimate_change end
