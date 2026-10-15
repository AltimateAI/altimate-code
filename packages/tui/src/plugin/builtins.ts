import HomeFooter from "../feature-plugins/home/footer"
import PromptBtw from "../feature-plugins/prompt/btw"
import PromptFooter from "../feature-plugins/prompt/footer"
import SidebarContext from "../feature-plugins/sidebar/context"
import SidebarFooter from "../feature-plugins/sidebar/footer"
import SidebarMcp from "../feature-plugins/sidebar/mcp"
import DiffViewer from "../feature-plugins/system/diff-viewer"
import Notifications from "../feature-plugins/system/notifications"
import Plugins from "../feature-plugins/system/plugins"
import Storybook from "../feature-plugins/system/storybook"
import Stats from "../feature-plugins/system/stats"
import Latex from "@opencode/latex/plugin"
import Merman from "@opencode/merman/plugin"
// altimate: ALT-F02
import { HostContributions } from "@opencode/plugin/host-contributions"
import { HostPluginError } from "./host-error"

export const builtins = [
  HomeFooter,
  PromptFooter,
  PromptBtw,
  SidebarContext,
  SidebarMcp,
  SidebarFooter,
  Notifications,
  Plugins,
  Stats,
  Merman,
  Latex,
  // The storybook is a development tool; keep its route and palette commands out of
  // normal launches and register it only for OPENCODE_STORY runs.
  ...(process.env.OPENCODE_STORY ? [Storybook] : []),
  DiffViewer,
]

// altimate: ALT-F02
export async function loadBuiltins() {
  return [
    ...builtins.map((plugin) => ({ plugin, protected: false })),
    ...(await Promise.all(
      HostContributions.tui.map(async (entry) => {
        const plugin = (
          await entry.plugin().catch((error) => {
            if (entry.protected)
              throw new HostPluginError(`Protected host TUI plugin "${entry.id}" failed to load: ${error}`)
            throw error
          })
        ).default
        if (plugin.id !== entry.id) throw new HostPluginError(`Host TUI plugin ID mismatch: ${entry.id} / ${plugin.id}`)
        return { plugin, protected: entry.protected }
      }),
    )),
  ]
}
