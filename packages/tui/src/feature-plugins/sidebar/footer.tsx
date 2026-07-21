import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
// altimate_change — community/docs links: plain copyable text, underlined for
// affordance; clicking the line opens the browser. (OSC-8 word-links are not
// supported by the current @opentui/solid JSX layer — raw TextChunk children crash.)
import open from "open"

const id = "internal:sidebar-footer"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  // altimate_change — light dotted divider between sidebar sections
  const Dotted = () => <text fg={theme().border}>┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄</text>

  return (
    <box gap={1}>
      {/* altimate_change start — reference/help anchored to the bottom of the panel
          (runtime status stays up top in the scroll area). JTBD first, then
          community/docs. Replaces the stale "Getting started" box. */}
      {/* white divider marking the start of the help section */}
      <text fg={theme().text}>┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄</text>
      <box>
        <text fg={theme().text}>
          <b>HERE'S WHAT YOU CAN DO</b>
        </text>
        <text fg={theme().textMuted}>• Build &amp; ship dbt pipelines</text>
        <text fg={theme().textMuted}>• Migrate legacy SQL to dbt</text>
        <text fg={theme().textMuted}>• Optimize warehouse cost &amp; speed</text>
        <text fg={theme().textMuted}>• Debug &amp; monitor your warehouse</text>
        <text fg={theme().textMuted}>• Govern data: lineage, PII, tests</text>
      </box>
      <Dotted />
      <box>
        <text fg={theme().textMuted} wrapMode="word" width="100%">
          Ideas or issues? Join the community.
        </text>
        <text
          wrapMode="word"
          width="100%"
          onMouseUp={() => open("https://altimate.studio/join-agentic-data-engineering-slack").catch(() => {})}
        >
          <span style={{ fg: theme().textMuted }}>Community · </span>
          <span style={{ fg: theme().accent, underline: true }}>altimate.studio/join-agentic-data-engineering-slack</span>
        </text>
        <text wrapMode="word" width="100%" onMouseUp={() => open("https://help.altimate.ai/code/").catch(() => {})}>
          <span style={{ fg: theme().textMuted }}>Docs · </span>
          <span style={{ fg: theme().accent, underline: true }}>help.altimate.ai/code</span>
        </text>
      </box>
      {/* altimate_change end */}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_footer() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
