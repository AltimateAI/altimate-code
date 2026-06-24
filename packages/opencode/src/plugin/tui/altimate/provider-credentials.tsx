// altimate_change start — fork TUI feature: altimate-backend provider credential flow.
//
// Re-homed from the pre-merge inline `altimate_change` blocks in
// packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx (see
// docs/internal/2026-06-23-tui-fork-features-as-plugins-adr.md, re-home plan item 1).
//
// This is an opencode-side, fork-owned plugin: it imports opencode-package code
// (AltimateApi) directly — the whole point of the ADR — and renders/acts through the
// TuiPluginApi (api.ui.DialogPrompt / api.ui.dialog / api.theme / api.client / api.keymap)
// so upstream packages/tui stays untouched.
//
// Trigger: a "Connect altimate-backend" command in the palette. The pre-merge trigger was
// provider-selection inside dialog-provider.tsx's onConfirm; that selection point is upstream
// tui-internal and not reachable from the plugin api, so we expose the credential dialog as a
// standalone command instead (see DEFERRED note at the bottom of this file).
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { createSignal, Show } from "solid-js"
import { AltimateApi } from "@/altimate/api/client"

const id = "altimate:provider-credentials"

const PROVIDER_ID = "altimate-backend"
const PLACEHOLDER = "instance-name::api-key"

function CredentialDialog(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [validationError, setValidationError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  return (
    <props.api.ui.DialogPrompt
      title="Connect altimate-backend"
      placeholder={PLACEHOLDER}
      busy={busy()}
      busyText="Validating credentials..."
      description={() => (
        <box gap={1}>
          <text fg={theme().textMuted}>Enter your Altimate credentials in this format:</text>
          <text fg={theme().text}>instance-name::api-key</text>
          <text fg={theme().textMuted}>e.g. mycompany::abc123 (uses https://api.myaltimate.com)</text>
          <text fg={theme().textMuted}>For a custom API URL, use: api-url::instance-name::api-key</text>
          <Show when={validationError()}>
            <text fg={theme().error}>{validationError()!}</text>
          </Show>
        </box>
      )}
      onConfirm={async (value) => {
        if (!value || busy()) return
        setValidationError(null)

        const parsed = AltimateApi.parseAltimateKey(value)
        if (!parsed) {
          setValidationError(
            "Invalid format — use: instance-name::api-key (or api-url::instance-name::api-key for a custom URL)",
          )
          return
        }

        setBusy(true)
        try {
          const validation = await AltimateApi.validateCredentials(parsed)
          if (!validation.ok) {
            setValidationError(validation.error)
            return
          }
          await AltimateApi.saveCredentials(parsed)
          // Disposing the server instance triggers a `server.instance.disposed` event that the
          // TUI's sync layer handles (re-bootstrap), so the new credentials/providers reload.
          await props.api.client.instance.dispose()
          props.api.ui.toast({ variant: "success", message: "Altimate credentials saved" })
          props.api.ui.dialog.clear()
        } catch (err) {
          setValidationError(err instanceof Error ? err.message : "Failed to save credentials")
        } finally {
          setBusy(false)
        }
      }}
      onCancel={() => props.api.ui.dialog.clear()}
    />
  )
}

function show(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <CredentialDialog api={api} />)
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "altimate.provider.connect",
        title: "Connect altimate-backend",
        category: "Altimate",
        namespace: "palette",
        run() {
          show(api)
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("altimate.palette", ["altimate.provider.connect"]),
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

// DEFERRED (cannot map to the plugin api without fabricating methods):
//   1. Provider-selection trigger — pre-merge, this dialog opened when the user picked the
//      "altimate-backend" entry inside upstream dialog-provider.tsx. That selection list lives in
//      upstream packages/tui and is not surfaced by TuiPluginApi, so the flow is exposed as the
//      "Connect altimate-backend" palette command instead.
//   2. `sync.bootstrap()` + `dialog.replace(<DialogModel ... />)` follow-on — `sync` and
//      `DialogModel` are tui-internal (no plugin-api equivalent). Instead we dispose the server
//      instance via `api.client.instance.dispose()`, which emits `server.instance.disposed`; the
//      TUI's own sync layer re-bootstraps from that event, so providers/models reload without a
//      direct bootstrap call. The explicit jump into the model picker is left out.
// altimate_change end
