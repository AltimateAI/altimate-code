import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization } from "@opencode-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { markSetupComplete } from "./altimate-onboarding"
import { useKeyboard } from "@opentui/solid"
import { Clipboard } from "@tui/util/clipboard"
import { useToast } from "../ui/toast"
// altimate_change start — import AltimateApi for direct credential file write
import { AltimateApi } from "../../../../altimate/api/client"
// altimate_change end

const PROVIDER_PRIORITY: Record<string, number> = {
  // altimate_change start — Part 1 onboarding: Altimate LLM Gateway is the
  // recommended default first; the BYOK providers rank next; OpenCode Zen loses
  // its "Recommended" tag and drops below. (Big Pickle occupies priority 4, injected
  // by dialog-model between Google and Zen.)
  "altimate-backend": 0,
  anthropic: 1,
  openai: 2,
  google: 3,
  // 4 reserved for Big Pickle (see dialog-model)
  opencode: 5,
  "opencode-go": 6,
  "github-copilot": 7,
  // altimate_change end
}

// altimate_change start — known-bad tool-callers, surfaced inline in the model picker
// (imported by dialog-model's READY/NEEDS-SETUP list).
export const WARNLIST: Record<string, string> = {
  "qwen-plus": "⚠ known tool-calling issues",
}
// altimate_change end

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const options = createMemo(() => {
    return pipe(
      sync.data.provider_next.all,
      sortBy((x) => PROVIDER_PRIORITY[x.id] ?? 99),
      map((provider) => ({
        // altimate_change start — brand the gateway entry + relabel priorities
        title: provider.id === "altimate-backend" ? "Altimate LLM Gateway" : provider.name,
        value: provider.id,
        description: {
          "altimate-backend": "Recommended · best tool-calling · 10M free tokens",
          anthropic: "(API key)",
          openai: "(ChatGPT Plus/Pro or API key)",
          google: "(API key)",
          opencode: "Bring your own Zen key",
          "opencode-go": "Low cost subscription for everyone",
        }[provider.id],
        // altimate_change end
        category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Other",
        async onSelect() {
          const methods = sync.data.provider_auth[provider.id] ?? [
            {
              type: "api",
              label: "API key",
            },
          ]
          let index: number | null = 0
          if (methods.length > 1) {
            index = await new Promise<number | null>((resolve) => {
              dialog.replace(
                () => (
                  <DialogSelect
                    title="Select auth method"
                    options={methods.map((x, index) => ({
                      title: x.label,
                      value: index,
                    }))}
                    onSelect={(option) => resolve(option.value)}
                  />
                ),
                () => resolve(null),
              )
            })
          }
          if (index == null) return
          const method = methods[index]
          if (method.type === "oauth") {
            // altimate_change — guard the authorize (e.g. loopback port busy) so the
            // recommended /connect path surfaces the error instead of failing silently
            // (parity with DialogAltimateAuth).
            try {
              const result = await sdk.client.provider.oauth.authorize({
                providerID: provider.id,
                method: index,
              })
              if (result.data?.method === "code") {
                dialog.replace(() => (
                  <CodeMethod
                    providerID={provider.id}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                  />
                ))
              } else if (result.data?.method === "auto") {
                dialog.replace(() => (
                  <AutoMethod
                    providerID={provider.id}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                  />
                ))
              } else {
                dialog.clear()
              }
            } catch (err) {
              toast.error(err instanceof Error ? err : new Error("Failed to start sign-in"))
              dialog.clear()
            }
          }
          if (method.type === "api") {
            return dialog.replace(() => <ApiMethod providerID={provider.id} title={method.label} />)
          }
        },
      })),
    )
  })
  return options
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  return <DialogSelect title="Connect a provider" options={options()} />
}

// altimate_change start — /auth entry: go straight to the Altimate LLM Gateway
// sign-in (the OAuth loopback method, index 0), skipping the provider picker.
export function DialogAltimateAuth() {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()

  onMount(async () => {
    const providerID = "altimate-backend"
    try {
      const result = await sdk.client.provider.oauth.authorize({ providerID, method: 0 })
      if (result.data?.method === "auto") {
        dialog.replace(() => (
          <AutoMethod providerID={providerID} title="Altimate LLM Gateway" index={0} authorization={result.data!} />
        ))
      } else if (result.data?.method === "code") {
        dialog.replace(() => (
          <CodeMethod providerID={providerID} title="Altimate LLM Gateway" index={0} authorization={result.data!} />
        ))
      } else {
        dialog.clear()
      }
    } catch (err) {
      // e.g. the loopback port is busy — don't hang on "Starting sign-in…".
      toast.error(err instanceof Error ? err : new Error("Failed to start sign-in"))
      dialog.clear()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        Altimate LLM Gateway
      </text>
      <text fg={theme.textMuted}>Starting sign-in…</text>
    </box>
  )
}
// altimate_change end

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const local = useLocal()
  const toast = useToast()
  // altimate_change — success state: confirm inline (green) below the "waiting" line,
  // then auto-close, instead of jumping into the model picker.
  const [connected, setConnected] = createSignal(false)
  // Guard against a late callback / auto-close firing after the dialog is dismissed.
  let disposed = false
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    disposed = true
    if (closeTimer) clearTimeout(closeTimer)
  })

  useKeyboard((evt) => {
    if (connected()) return
    if (evt.name === "c" && !evt.ctrl && !evt.meta) {
      const code = props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
      Clipboard.copy(code)
        .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
        .catch(toast.error)
    }
  })

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (disposed) return
    if (result.error) {
      // altimate_change — surface the failure instead of clearing silently. The
      // precise reason is also logged server-side by the plugin callback.
      toast.error(
        result.error instanceof Error
          ? result.error
          : new Error("Sign-in didn't complete. Please try again (see the terminal/logs for details)."),
      )
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    if (disposed) return
    // altimate_change start — mark setup complete (flips useReady → unlocks first-run chat/tips)
    markSetupComplete()
    // The gateway sign-in already shows the auth URL + "Waiting for authorization…".
    // On success, confirm inline (green) and auto-close after a moment rather than
    // opening the model picker. Auto-select a model so the user can chat right away.
    if (props.providerID === "altimate-backend") {
      const provider = sync.data.provider.find((p) => p.id === props.providerID)
      const model = provider
        ? Object.entries(provider.models).find(([, info]) => info.status !== "deprecated")?.[0]
        : undefined
      if (!model) {
        // Connected, but nothing usable to select — don't fake a green ✓; open the
        // picker so the user can choose a model (or another provider).
        toast.show({
          message: "Connected, but no model is available yet — pick one to start.",
          variant: "warning",
        })
        dialog.replace(() => <DialogModel />)
        return
      }
      local.model.set({ providerID: props.providerID, modelID: model }, { recent: true })
      setConnected(true)
      closeTimer = setTimeout(() => {
        if (!disposed) dialog.clear()
      }, 5000)
      return
    }
    // altimate_change end
    toast.show({ message: `Connected to ${props.title}`, variant: "success" })
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <Show when={!connected()}>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </Show>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      {/* altimate_change — swap the "waiting" line for a green success confirmation */}
      <Show
        when={connected()}
        fallback={
          <>
            <text fg={theme.textMuted}>Waiting for authorization...</text>
            <text fg={theme.text}>
              c <span style={{ fg: theme.textMuted }}>copy</span>
            </text>
          </>
        }
      >
        {/* theme.success is plain ANSI green (col 2) — dim/gray in many palettes;
            diffHighlightAdded is the bright green (greenBright) so it reads clearly. */}
        <text fg={theme.diffHighlightAdded} attributes={TextAttributes.BOLD}>
          ✓ Authentication successful
        </text>
        <text fg={theme.textMuted}>You are all set — returning to Altimate Code…</text>
      </Show>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.replace(() => <DialogModel providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  // altimate_change start — altimate-backend: validation error signal
  const [validationError, setValidationError] = createSignal<string | null>(null)
  // altimate_change end

  // altimate_change start — altimate-backend placeholder matches the credential format
  const placeholder = props.providerID === "altimate-backend" ? "instance-name::api-key" : "API key"
  // altimate_change end

  return (
    <DialogPrompt
      title={props.title}
      // altimate_change start — altimate-backend custom placeholder
      placeholder={placeholder}
      // altimate_change end
      description={
        {
          opencode: (
            <box gap={1}>
              <text fg={theme.textMuted}>
                Altimate Code Zen gives you access to all the best coding models at the cheapest prices with a single
                API key.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://altimate.ai/zen</span> to get a key
              </text>
            </box>
          ),
          "opencode-go": (
            <box gap={1}>
              <text fg={theme.textMuted}>
                Altimate Code Go is a $10 per month subscription that provides reliable access to popular open coding
                models with generous usage limits.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://altimate.ai/zen</span> and enable Altimate Code Go
              </text>
            </box>
          ),
          // altimate_change start — altimate-backend credential format description
          "altimate-backend": (
            <box gap={1}>
              {/* altimate_change start — default-URL credential format (2-part preferred) */}
              <text fg={theme.textMuted}>Enter your Altimate credentials in this format:</text>
              <text fg={theme.text}>instance-name::api-key</text>
              <text fg={theme.textMuted}>e.g. mycompany::abc123 (uses https://api.myaltimate.com)</text>
              <text fg={theme.textMuted}>For a custom API URL, use: api-url::instance-name::api-key</text>
              {/* altimate_change end */}
              <Show when={validationError()}>
                <text fg={theme.error}>{validationError()!}</text>
              </Show>
            </box>
          ),
          // altimate_change end
        }[props.providerID] ?? undefined
      }
      onConfirm={async (value) => {
        if (!value) return
        // altimate_change start — altimate-backend: validate then write credentials file directly
        if (props.providerID === "altimate-backend") {
          const parsed = AltimateApi.parseAltimateKey(value)
          if (!parsed) {
            setValidationError(
              "Invalid format — use: instance-name::api-key (or api-url::instance-name::api-key for a custom URL)",
            )
            return
          }
          const validation = await AltimateApi.validateCredentials(parsed)
          if (!validation.ok) {
            setValidationError(validation.error)
            return
          }
          try {
            await AltimateApi.saveCredentials(parsed)
            await sdk.client.instance.dispose()
            await sync.bootstrap()
            dialog.replace(() => <DialogModel providerID={props.providerID} />)
          } catch (err) {
            setValidationError(err instanceof Error ? err.message : "Failed to save credentials")
          }
          return
        }
        // altimate_change end
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key: value,
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}
