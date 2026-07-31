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
// Trigger: a "Connect altimate-backend" command in the palette, also dispatched by the provider
// selection list in packages/tui/src/component/dialog-provider.tsx for the pre-merge /connect path.
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
          await props.api.client.instance.dispose()
          await props.api.ui.dialog.openModel(PROVIDER_ID)
          props.api.ui.toast({ variant: "success", message: "Altimate credentials saved" })
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

// altimate_change start — /logout: clear the stored gateway credential. Self-contained
// (dispatched from the packages/tui slash command in app.tsx) since AltimateApi is
// opencode-side and unreachable from packages/tui.
async function logout(api: TuiPluginApi) {
  try {
    await AltimateApi.clearCredentials()
    await api.client.instance.dispose()
    api.ui.toast({ variant: "success", message: "Signed out of Altimate LLM Gateway" })
  } catch (err) {
    api.ui.toast({ variant: "error", message: err instanceof Error ? err.message : "Sign-out failed" })
  }
}
// altimate_change end

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
      // altimate_change start — /logout entry point, dispatched by packages/tui/src/app.tsx
      {
        name: "altimate.provider.logout",
        title: "Sign out of Altimate LLM Gateway",
        category: "Altimate",
        namespace: "palette",
        run() {
          void logout(api)
        },
      },
      // altimate_change end
    ],
    bindings: api.tuiConfig.keybinds.gather("altimate.palette", [
      "altimate.provider.connect",
      "altimate.provider.logout",
    ]),
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

// Restored handoffs:
//   1. Provider selection dispatches this command from packages/tui/src/component/dialog-provider.tsx
//      when the selected provider is "altimate-backend".
//   2. `sync.bootstrap()` + `dialog.replace(<DialogModel ... />)` follow-on is exposed via
//      `api.ui.dialog.openModel(PROVIDER_ID)`, a small host-owned plugin API seam that keeps
//      DialogModel inside packages/tui while this plugin keeps the fork credential logic.
// altimate_change end
