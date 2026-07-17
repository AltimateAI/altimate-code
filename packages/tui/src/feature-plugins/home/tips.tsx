import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { Tips } from "./tips-view"
import { useBindings } from "../../keymap"

const id = "internal:home-tips"

// altimate_change start — upstream_fix: thread first-run flag through home tips slot
function View(props: { api: TuiPluginApi; hidden: boolean; show: boolean; connected: boolean; isFirstTime: boolean }) {
  // altimate_change end
  useBindings(() => ({
    commands: [
      {
        name: "tips.toggle",
        title: props.hidden ? "Show tips" : "Hide tips",
        category: "System",
        namespace: "palette",
        run() {
          props.api.kv.set("tips_hidden", !props.api.kv.get("tips_hidden", false))
          props.api.ui.dialog.clear()
        },
      },
    ],
    bindings: props.api.tuiConfig.keybinds.get("tips.toggle"),
  }))

  return (
    <box width="100%" maxWidth={75} alignItems="center" paddingTop={3} flexShrink={1}>
      <Show when={props.show}>
        {/* altimate_change start — upstream_fix: render beginner tips for first-run users */}
        <Tips api={props.api} connected={props.connected} isFirstTime={props.isFirstTime} />
        {/* altimate_change end */}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_bottom() {
        const hidden = createMemo(() => api.kv.get("tips_hidden", false))
        // altimate_change start — upstream_fix: wait for synced session count before first-run onboarding
        const first = createMemo(() => api.state.ready && api.state.session.count() === 0)
        // altimate_change end
        // altimate_change — treat undefined cost as "not paid" (upstream `!== 0` was
        // true for undefined, mislabeling OpenCode as connected without a Zen key).
        const connected = createMemo(() =>
          api.state.provider.some(
            (item) =>
              item.id !== "opencode" ||
              Object.values(item.models).some((model) => model.cost?.input != null && model.cost.input !== 0),
          ),
        )
        // altimate_change start — upstream_fix: restore first-run onboarding state
        const isFirstTime = createMemo(() => first() && !connected())
        // altimate_change end
        const show = createMemo(() => (!first() || !connected()) && !hidden())
        // altimate_change start — upstream_fix: pass first-run flag to the tips View
        return (
          <View
            api={api}
            hidden={hidden()}
            show={show()}
            connected={connected()}
            isFirstTime={isFirstTime()}
          />
        )
        // altimate_change end
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
