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
// keybind. On trigger it reads the active prompt input via `api.prompt.active()` (the fork
// plugin-api extension), awaits enhancePrompt(it), and writes the result back via ref.set().
// Auto-enhance-before-submit is restored in packages/tui/src/component/prompt/index.tsx by calling
// the fork server endpoint `/altimate/prompt/enhance` before pasted-text expansion.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { enhancePrompt } from "@/altimate/enhance-prompt"

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
 * The caller is responsible for reading the current prompt input and writing the result back.
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
        async run() {
          const ref = api.prompt.active()
          if (!ref) {
            api.ui.toast({ variant: "warning", message: "No active prompt to enhance", duration: 2000 })
            return
          }
          const enhanced = await enhance(api, ref.current.input)
          if (enhanced !== undefined) ref.set({ ...ref.current, input: enhanced })
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

// Auto-enhance-before-submit is intentionally handled at the TUI submit/server endpoint seam rather
// than as a plugin hook: packages/tui remains generic, and fork-owned config/LLM code stays in
// packages/opencode.
// altimate_change end
