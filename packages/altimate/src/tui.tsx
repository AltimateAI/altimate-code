import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { createResource, For, Match, onCleanup, Show, Switch } from "solid-js"
import { AltimateRpc } from "./rpc"

export function WarehousePanel(props: { context: Plugin.Context; panel: PanelInput }) {
  const context = props.context
  const rpc = context.client.rpc(AltimateRpc)
  const [data, { refetch }] = createResource(
    () => props.panel.sessionID,
    async (sessionID) => {
      const location =
        context.data.session.get(sessionID)?.location ?? context.location ?? context.data.location.default()
      const [warehouses, result] = await Promise.all([
        rpc.listWarehouses({}, { location }),
        rpc.lastResult({ sessionID }, { location }),
      ])
      return { warehouses, result }
    },
  )
  onCleanup(
    context.data.on("session.tool.success", (event) => {
      if (event.data.sessionID === props.panel.sessionID) void refetch()
    }),
  )
  context.keymap.layer(() => ({
    commands: [
      { id: "altimate.warehouse.refresh", title: "Refresh warehouses", bind: "r", run: () => void refetch() },
      {
        id: "altimate.warehouse.fullscreen",
        title: "Toggle full screen",
        bind: "f",
        run: props.panel.toggleFullscreen,
      },
      { id: "altimate.warehouse.close", title: "Close warehouses", bind: "escape", run: props.panel.close },
    ],
  }))

  return (
    <box flexDirection="column" padding={1} gap={1} height="100%">
      <text fg={context.theme.text.base}>
        <b>Warehouses</b>
      </text>
      <Switch>
        <Match when={data.error}>
          <text fg={context.theme.text.feedback.error.base}>Unable to load warehouses. Press r to retry.</text>
        </Match>
        <Match when={data.loading && !data.latest}>
          <text fg={context.theme.text.muted}>Loading warehouses...</text>
        </Match>
        <Match when={data.latest}>
          {(loaded) => (
            <scrollbox flexGrow={1}>
              <box flexDirection="column" gap={1}>
                <For
                  each={loaded().warehouses}
                  fallback={<text fg={context.theme.text.muted}>No warehouses registered.</text>}
                >
                  {(warehouse) => (
                    <text fg={context.theme.text.base}>
                      {warehouse.name} ({warehouse.type})
                    </text>
                  )}
                </For>
                <text fg={context.theme.text.base}>
                  <b>Last query result</b>
                </text>
                <Show
                  when={loaded().result}
                  fallback={<text fg={context.theme.text.muted}>No query result in this session.</text>}
                >
                  {(result) => (
                    <box flexDirection="column">
                      <text fg={context.theme.text.muted}>
                        {result().warehouse} · {result().row_count} {result().row_count === 1 ? "row" : "rows"}
                        {result().truncated ? " (truncated)" : ""}
                      </text>
                      <text fg={context.theme.text.base}>{result().columns.join(" | ")}</text>
                      <For each={result().rows}>
                        {(row) => (
                          <text fg={context.theme.text.base}>
                            {row
                              .map((value) =>
                                value === null
                                  ? "NULL"
                                  : typeof value === "object"
                                    ? JSON.stringify(value)
                                    : String(value),
                              )
                              .join(" | ")}
                          </text>
                        )}
                      </For>
                    </box>
                  )}
                </Show>
              </box>
            </scrollbox>
          )}
        </Match>
      </Switch>
      <text fg={context.theme.text.muted}>r refresh · f full screen · esc close</text>
    </box>
  )
}

export default Plugin.define({
  id: "altimate",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "altimate.warehouse",
          title: "Open warehouses",
          group: "Altimate",
          palette: true,
          slash: { name: "warehouse" },
          run() {
            if (context.ui.panel.open("altimate.warehouse")) return
            context.ui.toast.show({ message: "Open a session to view warehouses.", variant: "info" })
          },
        },
      ],
    }))
    return context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === "altimate.warehouse"}>
          <WarehousePanel context={context} panel={panel} />
        </Show>
      ),
    })
  },
})
