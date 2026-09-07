// altimate_change start — fork TUI features as host-registered plugins.
//
// Per ADR docs/internal/2026-06-23-tui-fork-features-as-plugins-adr.md: fork TUI features live
// here (opencode-side, fork-owned) — NOT as edits inside upstream packages/tui files — so they
// (1) keep access to opencode-package code (AltimateApi, enhance-prompt, observability) and
// (2) leave upstream packages/tui untouched for clean future merges. Each feature is a
// `BuiltinTuiPlugin` ({ id, tui }) that renders/acts through the TuiPluginApi
// (slots / command / keymap / dialog / client). This aggregator is appended to the builtin
// plugin list in ../internal.ts.
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@opencode-ai/core/flag/flag"
import ProviderCredentials from "./provider-credentials"
import PromptEnhance from "./prompt-enhance"
import SkillOps from "./skill-ops"
import TraceViewer from "./trace-viewer"
import Workspace from "./workspace"
import WorkspaceSidebar from "./workspace-sidebar"

// Feature plugins are registered here as they are ported from the pre-merge sources on `main`
// (see the ADR re-home plan). Each lives in its own file under this directory and default-exports
// a BuiltinTuiPlugin:
//   import ProviderCredentials from "./provider-credentials"
//   import SkillOps from "./skill-ops"
//   import PromptEnhance from "./prompt-enhance"
//   import TraceViewer from "./trace-viewer"
//   import Workspace from "./workspace"
export function altimateTuiPlugins(_flags: Pick<RuntimeFlags.Info, "experimentalEventSystem">): BuiltinTuiPlugin[] {
  const base = [ProviderCredentials, PromptEnhance, SkillOps, TraceViewer]
  // Workspace TUI plugin + right-pane sidebar tile are pilot-gated: only
  // registered for users who opted into ALTIMATE_WORKSPACE. Otherwise the
  // post-scan dialog, the altimate.workspace.link palette command, and the
  // sidebar's 30s poll would ship to 100% of users regardless of the flag
  // setting. (M1 in the consensus review.)
  return Flag.ALTIMATE_WORKSPACE ? [...base, Workspace, WorkspaceSidebar] : base
}
// altimate_change end
