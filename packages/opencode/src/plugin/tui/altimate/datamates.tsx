// altimate_change start — fork TUI feature: browse the tenant's datamates and wire one up.
//
// Human-facing counterpart to the `datamate_manager` LLM tool. Read-only over the API — it lists
// datamates and connects the selected one; create/edit/delete stay with the tool and the console.
//
// This is an opencode-side, fork-owned plugin per
// docs/internal/2026-06-23-tui-fork-features-as-plugins-adr.md: it imports opencode-package code
// (AltimateApi, the datamate config readers) directly and renders through the TuiPluginApi so
// upstream packages/tui stays untouched.
//
// The connect step does NOT happen here. Wiring a datamate mutates the live MCP registry, which
// only exists in the server — the TUI runs the plugin host in its main thread and talks to a Worker
// server over RPC (cli/cmd/tui.ts). So selection POSTs to the fork endpoint
// /altimate/datamate/connect, which calls the same `connectDatamate` the tool's 'add' operation
// uses. Everything this file does itself (list, read config) is pure API/fs work, safe in-process.
//
// Surfaces:
//   - `altimate.datamate.list` palette command / `/datamates` — the picker.
//   - a dismissable home_bottom banner pointing at /datamates, hidden once a datamate is wired.
import type { TuiPlugin, TuiPluginApi, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { createMemo, createResource, Show } from "solid-js"
import { AltimateApi } from "@/altimate/api/client"
import { readWiredDatamates, slugify, type WiredDatamates } from "@/altimate/datamate-config"
import { DATAMATE_KEY } from "@/altimate/datamate-transport"

const id = "altimate:datamates"

/** KV key for the home banner, following the `dismissed_getting_started` naming. */
const BANNER_KV_KEY = "dismissed_datamates_banner"

type Datamate = Awaited<ReturnType<typeof AltimateApi.listDatamates>>[number]

type ListState =
  | { kind: "unconfigured" }
  | { kind: "error"; message: string }
  | { kind: "ready"; datamates: Datamate[]; wired: WiredDatamates }

/** Mirrors the server's datamate projectRoot(): worktree unless it degenerated to "/". */
function projectRootDir(api: TuiPluginApi): string {
  const worktree = api.state.path.worktree
  if (!worktree || worktree === "/") return api.state.path.directory || process.cwd()
  return worktree
}

async function loadState(api: TuiPluginApi): Promise<ListState> {
  if (!(await AltimateApi.isConfigured())) return { kind: "unconfigured" }
  try {
    const [datamates, wired] = await Promise.all([AltimateApi.listDatamates(), readWiredDatamates(projectRootDir(api))])
    return { kind: "ready", datamates, wired }
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) }
  }
}

// ── Connect (server round-trip) ─────────────────────────────────────────────────────────────────

type RawSdkClient = {
  post(options: {
    url: string
    body?: unknown
    headers?: Record<string, string>
  }): Promise<{ data?: unknown; error?: unknown }>
}

// Guard against a second Enter landing while a connect is in flight.
let wiring = false

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Render the connect outcome as a toast. Shapes match DatamateConnectResult. */
function toastResult(api: TuiPluginApi, datamateName: string, result: Record<string, unknown>) {
  const serverName = asString(result["serverName"]) ?? DATAMATE_KEY
  const toolCount = typeof result["toolCount"] === "number" ? result["toolCount"] : 0
  const stale = Array.isArray(result["staleEntries"]) ? result["staleEntries"].filter(asString) : []
  const staleNote =
    stale.length > 0 ? `\n\nStale per-datamate config entries: ${stale.join(", ")} — ask the agent to remove them.` : ""

  switch (result["status"]) {
    case "already-connected":
      api.ui.toast({
        message: `'${datamateName}' is already connected via '${serverName}' (${toolCount} tools active).${staleNote}`,
        variant: "info",
        duration: 6000,
      })
      return
    case "connected":
      api.ui.toast({
        message: `Connected '${datamateName}' as '${serverName}'.\n\n${toolCount} tools are now available — they are usable in the next message.${staleNote}`,
        variant: "success",
        duration: 8000,
      })
      return
    case "pending": {
      const status = asString(asRecord(result["mcpStatus"])?.["status"]) ?? "unknown"
      api.ui.toast({
        message: `Saved '${datamateName}' as '${serverName}', but the connection is ${status}.\n\nIt will auto-connect on the next session start.`,
        variant: "warning",
        duration: 8000,
      })
      return
    }
    default:
      api.ui.toast({
        message: `Wired '${datamateName}' as '${serverName}', but the server returned an unexpected status.`,
        variant: "warning",
        duration: 6000,
      })
  }
}

async function wireDatamate(api: TuiPluginApi, datamate: Datamate): Promise<void> {
  if (wiring) return
  wiring = true
  api.ui.toast({ message: `Connecting '${datamate.name}'...`, variant: "info", duration: 600000 })
  try {
    const raw = (api.client as unknown as { client?: RawSdkClient }).client
    if (!raw) {
      api.ui.toast({ message: "Cannot reach the altimate-code server.", variant: "error", duration: 6000 })
      return
    }
    const response = await raw.post({
      url: "/altimate/datamate/connect",
      body: { datamate_id: datamate.id },
      headers: { "Content-Type": "application/json" },
    })
    const data = asRecord(response.data)
    const result = asRecord(data?.["result"])
    if (data?.["ok"] !== true || !result) {
      const message = asString(data?.["error"]) ?? "the server rejected the request"
      api.ui.toast({
        message: `Failed to connect '${datamate.name}': ${message.slice(0, 200)}`,
        variant: "error",
        duration: 8000,
      })
      return
    }
    toastResult(api, datamate.name, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    api.ui.toast({
      message: `Failed to connect '${datamate.name}': ${message.slice(0, 200)}`,
      variant: "error",
      duration: 8000,
    })
  } finally {
    wiring = false
  }
}

// ── Picker ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether this datamate is currently served.
 *
 * Two shapes, both derived from the MCP config (see readWiredDatamates):
 *   - standalone/cloud — the entry carries `x-datamate-id`, so the exact datamate is known.
 *   - IDE gateway — a single `datamate` server serves EVERY datamate through one connection, so
 *     there is no per-datamate id to match and all of them are active. The dialog title says so.
 */
function isActive(wired: WiredDatamates, datamate: Datamate): boolean {
  return wired.gateway || wired.ids.has(datamate.id) || wired.serverNames.includes(`datamate-${slugify(datamate.name)}`)
}

function buildOptions(wired: WiredDatamates, datamates: Datamate[]): TuiDialogSelectOption<string>[] {
  const maxWidth = Math.max(0, ...datamates.map((d) => d.name.length))
  return datamates.map((datamate) => {
    const description = datamate.description?.replace(/\s+/g, " ").trim()
    const integrations = datamate.integrations?.map((i) => i.id) ?? []
    return {
      title: `${isActive(wired, datamate) ? "✓" : " "} ${datamate.name.padEnd(maxWidth)}`,
      description: description && description.length > 80 ? description.slice(0, 77) + "..." : description,
      footer: integrations.length > 0 ? integrations.join(", ") : "no integrations",
      value: datamate.id,
    } satisfies TuiDialogSelectOption<string>
  })
}

function DialogDatamateList(props: { api: TuiPluginApi }) {
  const { api } = props
  const [state] = createResource(() => loadState(api))

  return (
    <Show when={state()} fallback={<api.ui.DialogAlert title="Datamates" message="Loading datamates..." />}>
      {(resolved) => {
        const current = resolved()
        if (current.kind === "unconfigured") {
          return (
            <api.ui.DialogAlert
              title="Datamates"
              message={
                "Altimate credentials not found.\n\n" +
                "Run /connect and pick the Altimate provider to add your instance name and API key, " +
                "then reopen /datamates."
              }
            />
          )
        }
        if (current.kind === "error") {
          return (
            <api.ui.DialogAlert
              title="Datamates"
              message={`Failed to load datamates: ${current.message.slice(0, 300)}`}
            />
          )
        }
        if (current.datamates.length === 0) {
          return (
            <api.ui.DialogAlert
              title="Datamates"
              message={
                "No datamates in this workspace yet.\n\n" +
                "Create one in the Altimate console (or ask the agent to), then reopen /datamates."
              }
            />
          )
        }
        // With the gateway there is no single active datamate, so leave `current` unset and let the
        // title carry the explanation; standalone mode can point the cursor at the wired one.
        const activeId = current.wired.gateway ? undefined : [...current.wired.ids][0]
        return (
          <api.ui.DialogSelect
            title={current.wired.gateway ? "Datamates (via extension gateway)" : "Datamates"}
            placeholder="Search datamates..."
            options={buildOptions(current.wired, current.datamates)}
            current={activeId}
            onSelect={(item) => {
              const datamate = current.datamates.find((d) => d.id === item.value)
              if (!datamate) return
              api.ui.dialog.clear()
              void wireDatamate(api, datamate)
            }}
          />
        )
      }}
    </Show>
  )
}

function showList(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <DialogDatamateList api={api} />)
}

// ── Home banner ─────────────────────────────────────────────────────────────────────────────────

function Banner(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  return (
    <box width="100%" maxWidth={75} paddingTop={1} flexShrink={0}>
      <box
        backgroundColor={theme().backgroundElement}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="row"
        gap={1}
      >
        <text flexShrink={0} fg={theme().text}>
          ⬖
        </text>
        <box flexGrow={1} gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme().text}>
              <b>Datamates</b>
            </text>
            <text fg={theme().textMuted} onMouseDown={() => props.api.kv.set(BANNER_KV_KEY, true)}>
              ✕
            </text>
          </box>
          <text fg={theme().textMuted}>
            A datamate brings its integrations — Snowflake, dbt, Jira and more — into this session as tools.
          </text>
          <box flexDirection="row" gap={1} justifyContent="space-between">
            <text fg={theme().text}>Browse your datamates</text>
            <text fg={theme().textMuted}>/datamates</text>
          </box>
        </box>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "altimate.datamate.list",
        title: "Datamates",
        desc: "Browse your Altimate datamates and connect one to this session",
        category: "Altimate",
        namespace: "palette",
        slashName: "datamates",
        run() {
          showList(api)
        },
      },
      // The banner's ✕ needs a mouse; keep a keyboard route to dismissal (as tips.toggle does).
      {
        name: "altimate.datamate.banner.hide",
        title: "Hide datamates tip",
        desc: "Dismiss the datamates banner on the home screen",
        category: "Altimate",
        namespace: "palette",
        run() {
          api.kv.set(BANNER_KV_KEY, true)
          api.ui.dialog.clear()
        },
      },
    ],
  })

  api.slots.register({
    order: 110,
    slots: {
      home_bottom() {
        const dismissed = createMemo(() => api.kv.get(BANNER_KV_KEY, false))
        // Once a datamate MCP server exists there is nothing left to promote. Read live MCP status
        // rather than the config so the banner also stays hidden for gateway-supplied servers.
        const connected = createMemo(() =>
          api.state.mcp().some((item) => item.name === DATAMATE_KEY || item.name.startsWith("datamate-")),
        )
        const show = createMemo(() => api.state.ready && !dismissed() && !connected())
        return (
          <Show when={show()}>
            <Banner api={api} />
          </Show>
        )
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
// altimate_change end
