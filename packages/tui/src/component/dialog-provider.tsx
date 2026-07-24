import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useSync } from "../context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider } from "../util/provider-origin"
import { useConnected } from "./use-connected"
import { useBindings, useOpencodeKeymap } from "../keymap"
import { useClipboard } from "../context/clipboard"
import { useLocal } from "../context/local"
// altimate_change — mark first-run setup complete once the gateway sign-in succeeds
// (used by AutoMethod below); flips useReady() so the first-run chat lock lifts.
import { markSetupComplete } from "./altimate-onboarding"

export const PROVIDER_PRIORITY: Record<string, number> = {
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
}
// altimate_change end

// altimate_change start — known-bad tool-callers, surfaced inline in the model picker
// (imported by dialog-model's READY/NEEDS-SETUP list).
export const WARNLIST: Record<string, string> = {
  "qwen-plus": "⚠ known tool-calling issues",
}
// altimate_change end

const CUSTOM_PROVIDER_OPTION_VALUE = "__opencode_custom_provider__"
const CUSTOM_PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

type ProviderOptionBase = {
  title: string
  value: string
  description?: string
  category: string
}

type ProviderOption =
  | (ProviderOptionBase & {
      type: "provider"
      providerID: string
    })
  | (ProviderOptionBase & {
      type: "custom"
    })

export function providerOptions(list: { id: string; name: string }[]): ProviderOption[] {
  return [
    ...pipe(
      list,
      sortBy(
        (x) => PROVIDER_PRIORITY[x.id] ?? 99,
        (x) => x.name.toLowerCase(),
        (x) => x.id,
      ),
      map((provider) => ({
        type: "provider" as const,
        // altimate_change start — brand the gateway entry + relabel priorities
        title: provider.id === "altimate-backend" ? "Altimate LLM Gateway" : provider.name,
        value: provider.id,
        providerID: provider.id,
        description: {
          "altimate-backend": "Recommended · best tool-calling · 10M free tokens",
          anthropic: "(API key)",
          openai: "(ChatGPT Plus/Pro or API key)",
          google: "(API key)",
          opencode: "Bring your own Zen key",
          "opencode-go": "Low cost subscription for everyone",
        }[provider.id],
        // altimate_change end
        category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Providers",
      })),
    ),
    {
      type: "custom",
      title: "Other",
      value: CUSTOM_PROVIDER_OPTION_VALUE,
      description: "Custom provider",
      category: "Providers",
    },
  ]
}

export function normalizeCustomProviderID(value: string) {
  const providerID = value.trim().replace(/^@ai-sdk\//, "")
  if (!CUSTOM_PROVIDER_ID.test(providerID)) return
  return providerID
}

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const onboarded = useConnected()
  // altimate_change start — delegate altimate-backend provider selection to fork credential plugin
  const keymap = useOpencodeKeymap()
  // altimate_change end

  async function promptCustomProviderID(): Promise<string | undefined> {
    const value = await DialogPrompt.show(dialog, "Other", {
      placeholder: "Provider id",
      description: () => (
        <text fg={theme.textMuted}>
          This only stores a credential. Configure the provider in opencode.json to use it.
        </text>
      ),
    })
    if (value === null) return

    const providerID = normalizeCustomProviderID(value)
    if (providerID) return providerID

    toast.show({
      variant: "error",
      message:
        "Provider ids must start with a lowercase letter or number and only use lowercase letters, numbers, hyphens, and underscores",
    })
    return promptCustomProviderID()
  }

  const options = createMemo(() => {
    return pipe(
      providerOptions(sync.data.provider_next.all),
      map((provider) => {
        if (provider.type === "custom") {
          return {
            title: provider.title,
            value: provider.value,
            description: provider.description,
            category: provider.category,
            async onSelect() {
              const providerID = await promptCustomProviderID()
              if (!providerID) return
              return dialog.replace(() => <ApiMethod providerID={providerID} title="API key" custom />)
            },
          }
        }

        const providerID = provider.providerID
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, providerID)
        const connected = sync.data.provider_next.connected.includes(providerID)

        return {
          title: provider.title,
          value: provider.value,
          description: provider.description,
          footer: consoleManaged ? sync.data.console_state.activeOrgName : undefined,
          category: provider.category,
          gutter: connected && onboarded() ? () => <text fg={theme.success}>✓</text> : undefined,
          async onSelect() {
            if (consoleManaged) return

            const methods = sync.data.provider_auth[providerID] ?? [
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
              let inputs: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({
                  dialog,
                  prompts: method.prompts,
                })
                if (!value) return
                inputs = value
              }

              // altimate_change start — guard the authorize (e.g. loopback port busy) so
              // the recommended /connect path surfaces the error instead of failing
              // silently (parity with DialogAltimateAuth).
              try {
                const result = await sdk.client.provider.oauth.authorize({
                  providerID,
                  method: index,
                  inputs,
                })
                if (result.error) {
                  toast.show({
                    variant: "error",
                    message: JSON.stringify(result.error),
                  })
                  dialog.clear()
                  return
                }
                if (result.data?.method === "code") {
                  dialog.replace(() => (
                    <CodeMethod
                      providerID={providerID}
                      title={method.label}
                      index={index}
                      authorization={result.data!}
                    />
                  ))
                } else if (result.data?.method === "auto") {
                  dialog.replace(() => (
                    <AutoMethod
                      providerID={providerID}
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
              // altimate_change end
            }
            if (method.type === "api") {
              // altimate_change start — restore Altimate credential validation/save/model-picker
              // flow: the instance-name::api-key entry is opencode-side (needs AltimateApi), so
              // it's re-homed as a plugin (see docs/internal/2026-06-23-tui-fork-features-as-plugins-adr.md).
              if (providerID === "altimate-backend") {
                keymap.dispatchCommand("altimate.provider.connect")
                return
              }
              // altimate_change end
              let metadata: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({ dialog, prompts: method.prompts })
                if (!value) return
                metadata = value
              }
              return dialog.replace(() => (
                <ApiMethod providerID={providerID} title={method.label} metadata={metadata} />
              ))
            }
          },
        }
      }),
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
      if (result.error) {
        toast.show({ variant: "error", message: JSON.stringify(result.error) })
        dialog.clear()
        return
      }
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
  // altimate_change start — `local` sets the connected model as the default post-connect
  const local = useLocal()
  // altimate_change end
  const toast = useToast()
  const clipboard = useClipboard()
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

  useBindings(() => ({
    bindings: connected()
      ? []
      : [
          {
            key: "c",
            desc: "Copy provider code",
            group: "Dialog",
            cmd: () => {
              const code =
                props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
              clipboard
                .write?.(code)
                .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
                .catch(toast.error)
            },
          },
        ],
  }))

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (disposed) return
    if (result.error) {
      // altimate_change — surface the failure instead of clearing silently. The
      // precise reason is also logged server-side by the plugin callback.
      toast.show({
        variant: "error",
        message:
          "name" in result.error && result.error.name === "ProviderAuthOauthCallbackFailed"
            ? "OAuth authorization failed. Try /connect again."
            : JSON.stringify(result.error),
      })
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
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
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
  metadata?: Record<string, string>
  custom?: boolean
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      description={
        {
          opencode: (
            <box gap={1}>
              <text fg={theme.textMuted}>
                Altimate Code Zen gives you access to all the best coding models at the cheapest prices with a single API
                key.
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
                Go to <span style={{ fg: theme.primary }}>https://altimate.ai/go</span> and enable Altimate Code Go
              </text>
            </box>
          ),
        }[props.providerID] ?? undefined
      }
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key: value,
            ...(props.metadata ? { metadata: props.metadata } : {}),
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        if (props.custom && !sync.data.provider_next.all.some((provider) => provider.id === props.providerID)) {
          toast.show({
            variant: "info",
            message: `Saved credential for ${props.providerID}. Configure it in opencode.json to use it.`,
          })
          dialog.clear()
          return
        }
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<ProviderAuthMethod["prompts"]>[number][]
}
async function PromptsMethod(props: PromptsMethodProps) {
  const inputs: Record<string, string> = {}
  for (const prompt of props.prompts) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
      if (!matches) continue
    }

    if (prompt.type === "select") {
      const value = await new Promise<string | null>((resolve) => {
        props.dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      props.dialog.replace(
        () => (
          <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}
