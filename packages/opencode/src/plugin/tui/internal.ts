import { createBuiltinPlugins, type BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import type { RuntimeFlags } from "@/effect/runtime-flags"
// altimate_change start — register fork TUI features as host plugins (see ./altimate + ADR)
import { altimateTuiPlugins } from "./altimate"
// altimate_change end

export type InternalTuiPlugin = BuiltinTuiPlugin

export function internalTuiPlugins(flags: Pick<RuntimeFlags.Info, "experimentalEventSystem">): InternalTuiPlugin[] {
  return [
    ...createBuiltinPlugins({
      experimentalEventSystem: flags.experimentalEventSystem,
    }),
    // altimate_change start — fork TUI features (kept opencode-side; upstream packages/tui untouched)
    ...altimateTuiPlugins({ experimentalEventSystem: flags.experimentalEventSystem }),
    // altimate_change end
  ]
}
