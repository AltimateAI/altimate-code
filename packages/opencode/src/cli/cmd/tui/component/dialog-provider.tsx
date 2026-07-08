import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { Spinner } from "./spinner"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization } from "@opencode-ai/sdk/v2"
import { DialogModel, markSetupComplete } from "./dialog-model"
import { useKeyboard } from "@opentui/solid"
import { Clipboard } from "@tui/util/clipboard"
import { useToast } from "../ui/toast"
import open from "open"
// altimate_change start — import AltimateApi for direct credential file write + gateway flow
import { AltimateApi } from "../../../../altimate/api/client"
// altimate_change end

// altimate_change start — Part 1 onboarding: Altimate LLM Gateway is the
// recommended default; OpenCode Zen loses its "Recommended" tag and drops below.
// Big Pickle (priority 4) is injected by dialog-model between Google and Zen.
const PROVIDER_PRIORITY: Record<string, number> = {
  "altimate-backend": 0,
  anthropic: 1,
  openai: 2,
  google: 3,
  // 4 reserved for Big Pickle (see dialog-model)
  opencode: 5,
  "opencode-go": 6,
  "github-copilot": 7,
}

// Known-bad tool-callers, surfaced inline in the picker.
export const WARNLIST: Record<string, string> = {
  "qwen-plus": "⚠ known tool-calling issues",
}

// Providers the user force-continued past a failed tool-calling validation
// (stage 2 "Continue anyway"). Drives the persistent "⚠ unreliable model" chip
// in the status bar. Session-scoped: resets on relaunch.
const [unreliableProviders, setUnreliableProviders] = createSignal<string[]>([])
export function markUnreliableProvider(id: string) {
  setUnreliableProviders((prev) => (prev.includes(id) ? prev : [...prev, id]))
}
export function isProviderUnreliable(id: string | undefined): boolean {
  return !!id && unreliableProviders().includes(id)
}
// altimate_change end

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
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
          // altimate_change start — Altimate LLM Gateway: browser device sign-in
          // (no key is ever displayed or pasted), instead of manual key entry.
          if (provider.id === "altimate-backend") {
            return dialog.replace(() => <GatewayFlow />)
          }
          // altimate_change end
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
            const result = await sdk.client.provider.oauth.authorize({
              providerID: provider.id,
              method: index,
            })
            if (result.data?.method === "code") {
              dialog.replace(() => (
                <CodeMethod providerID={provider.id} title={method.label} index={index} authorization={result.data!} />
              ))
            }
            if (result.data?.method === "auto") {
              dialog.replace(() => (
                <AutoMethod providerID={provider.id} title={method.label} index={index} authorization={result.data!} />
              ))
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
  const toast = useToast()

  useKeyboard((evt) => {
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
    if (result.error) {
      dialog.clear()
      return
    }
    // altimate_change start — stage-2 tool-calling validation after OAuth success
    const stage2 = await AltimateApi.byokValidateTools(props.providerID)
    if (!stage2.ok) {
      dialog.replace(() => <DialogToolsFailed providerID={props.providerID} error={stage2.error} />)
      return
    }
    // altimate_change end
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
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
          // altimate_change start — stage-2 tool-calling validation after OAuth success
          const stage2 = await AltimateApi.byokValidateTools(props.providerID)
          if (!stage2.ok) {
            dialog.replace(() => <DialogToolsFailed providerID={props.providerID} error={stage2.error} />)
            return
          }
          // altimate_change end
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
  // BYOK validation busy state (stage 1 + 2 run after submit)
  const [busy, setBusy] = createSignal(false)
  // altimate_change end

  // altimate_change start — altimate-backend placeholder matches the credential format
  const placeholder = props.providerID === "altimate-backend" ? "instance-name::api-key" : "API key"
  // altimate_change end

  return (
    <DialogPrompt
      title={props.title}
      // altimate_change start — altimate-backend custom placeholder + validation busy state
      placeholder={placeholder}
      busy={busy()}
      busyText="Validating key..."
      // altimate_change end
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
                Altimate Code Go is a $10 per month subscription that provides reliable access to popular open coding models
                with generous usage limits.
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
              <text fg={theme.textMuted}>
                Enter your Altimate credentials in this format:
              </text>
              <text fg={theme.text}>
                instance-name::api-key
              </text>
              <text fg={theme.textMuted}>
                e.g. mycompany::abc123 (uses https://api.myaltimate.com)
              </text>
              <text fg={theme.textMuted}>
                For a custom API URL, use: api-url::instance-name::api-key
              </text>
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
            setValidationError("Invalid format — use: instance-name::api-key (or api-url::instance-name::api-key for a custom URL)")
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
        // altimate_change start — BYOK validation layers (strictly after submit;
        // the auth-method screens above are unchanged). Stage 1: cheap key ping.
        // Stage 2: minimal forced tool call.
        setBusy(true)
        const stage1 = await AltimateApi.byokValidateKey(props.providerID, value)
        if (!stage1.ok) {
          setBusy(false)
          dialog.replace(() => <DialogKeyInvalid providerID={props.providerID} title={props.title} error={stage1.error} />)
          return
        }
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key: value,
          },
        })
        const stage2 = await AltimateApi.byokValidateTools(props.providerID)
        setBusy(false)
        if (!stage2.ok) {
          dialog.replace(() => <DialogToolsFailed providerID={props.providerID} error={stage2.error} />)
          return
        }
        // altimate_change end
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}

// altimate_change start — BYOK validation failure dialogs (Part 1 onboarding).

// Stage-1 failure: an invalid key can never work, so exactly two options and
// NO "continue anyway" here.
function DialogKeyInvalid(props: { providerID: string; title: string; error: string }) {
  const dialog = useDialog()
  return (
    <DialogSelect
      title="Invalid API key"
      options={[
        {
          title: "Enter a valid API key",
          value: "reenter",
          category: props.error,
          onSelect: () => dialog.replace(() => <ApiMethod providerID={props.providerID} title={props.title} />),
        },
        {
          title: "Use Altimate LLM Gateway",
          description: "recommended · free 10M tokens",
          value: "gateway",
          category: props.error,
          onSelect: () => dialog.replace(() => <GatewayFlow />),
        },
      ]}
    />
  )
}

// Stage-2 failure: key valid, but the model can't drive the harness.
function DialogToolsFailed(props: { providerID: string; error: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  async function proceed() {
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  }

  return (
    <DialogSelect
      title="Tool-calling check failed"
      options={[
        {
          title: "Retry",
          value: "retry",
          category: props.error,
          onSelect: async () => {
            const result = await AltimateApi.byokValidateTools(props.providerID)
            if (result.ok) {
              toast.show({ message: "Tool-calling check passed", variant: "success" })
              await proceed()
              return
            }
            dialog.replace(() => <DialogToolsFailed providerID={props.providerID} error={result.error} />)
          },
        },
        {
          title: "Use Altimate LLM Gateway",
          description: "recommended · free 10M tokens",
          value: "gateway",
          category: props.error,
          onSelect: () => dialog.replace(() => <GatewayFlow />),
        },
        // PM-DECISION: stage-2 continue-anyway is the earlier locked decision; the
        // "remove continue-anyway" instruction applies to stage-1 invalid keys only.
        // If PM wants it gone from stage 2 as well, delete this option.
        {
          title: "Continue anyway",
          description: 'requires typing "continue"',
          value: "continue",
          category: props.error,
          onSelect: () => dialog.replace(() => <DialogToolsContinue providerID={props.providerID} onProceed={proceed} />),
        },
      ]}
    />
  )
}

// Gated continue: the user must type "continue"; the provider is then flagged
// with a persistent "⚠ unreliable model" chip in the status bar.
function DialogToolsContinue(props: { providerID: string; onProceed: () => Promise<void> }) {
  const { theme } = useTheme()
  const [wrong, setWrong] = createSignal(false)
  return (
    <DialogPrompt
      title="Continue with an unreliable model?"
      placeholder='Type "continue" to proceed'
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>
            This model failed the tool-calling check — data tasks may fail or silently produce wrong results.
          </text>
          <Show when={wrong()}>
            <text fg={theme.error}>Type "continue" to proceed, or press esc to go back.</text>
          </Show>
        </box>
      )}
      onConfirm={async (value) => {
        if (value.trim().toLowerCase() !== "continue") {
          setWrong(true)
          return
        }
        markUnreliableProvider(props.providerID)
        await props.onProceed()
      }}
    />
  )
}
// altimate_change end

// altimate_change start — Altimate LLM Gateway sign-in (Part 1 onboarding).
// Standard OAuth device flow (mirrors account.ts) → GET /api/user → instance
// name prompt (pre-filled from suggested_instance) → POST /api/instance (409 →
// suggest "<name>-2") → poll GET /api/instance → save 3-part creds. The API key
// is never displayed or pasted anywhere on this path.
export function GatewayFlow() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const toast = useToast()

  const [authUrl, setAuthUrl] = createSignal("")
  const [userCode, setUserCode] = createSignal("")
  const [authError, setAuthError] = createSignal<string | null>(null)
  const [accessToken, setAccessToken] = createSignal("")
  // promptKey: 0 = auth phase; >0 = instance phase. Bumping it remounts the
  // DialogPrompt so a server-suggested name (e.g. "acme-2") shows in the field.
  const [promptKey, setPromptKey] = createSignal(0)
  const [instanceName, setInstanceName] = createSignal("")
  const [instanceError, setInstanceError] = createSignal<string | null>(null)
  const [provisioning, setProvisioning] = createSignal(false)

  let cancelled = false
  onCleanup(() => {
    cancelled = true
  })

  onMount(async () => {
    try {
      const device = await AltimateApi.gatewayStartDevice()
      if (cancelled) return
      setAuthUrl(device.verificationUrl)
      setUserCode(device.userCode)
      open(device.verificationUrl).catch(() => {})

      const deadline = Date.now() + device.expiresInMs
      let interval = device.intervalMs

      const tick = async () => {
        if (cancelled) return
        if (Date.now() > deadline) {
          setAuthError("Sign-in timed out. Press esc and try again.")
          return
        }
        const result = await AltimateApi.gatewayPollToken(device.deviceCode)
        if (cancelled) return
        if (result.status === "authorized") {
          setAccessToken(result.accessToken)
          const user = await AltimateApi.gatewayGetUser(result.accessToken)
          if (cancelled) return
          setInstanceName(user.suggestedInstance)
          setPromptKey(1)
          return
        }
        if (result.status === "expired") return setAuthError("Device code expired. Press esc and try again.")
        if (result.status === "denied") return setAuthError("Sign-in was denied. Press esc and try again.")
        if (result.status === "slow_down") interval += 5000
        setTimeout(tick, interval)
      }
      setTimeout(tick, interval)
    } catch (err) {
      if (!cancelled) setAuthError(err instanceof Error ? err.message : "Sign-in failed")
    }
  })

  async function submitInstance(raw: string) {
    const name = raw.trim().toLowerCase()
    if (!name) return setInstanceError("Enter an instance name")
    setInstanceError(null)
    setProvisioning(true)
    try {
      const created = await AltimateApi.gatewayCreateInstance(accessToken(), name)
      if (cancelled) return
      if (created === "name_taken") {
        setProvisioning(false)
        const suggestion = `${name}-2`
        setInstanceName(suggestion)
        setInstanceError(`"${name}" is taken — try ${suggestion}`)
        setPromptKey(promptKey() + 1)
        return
      }
      if (created === "invalid_name") {
        setProvisioning(false)
        setInstanceError("Use lowercase letters, numbers, - or _ (must start with a letter)")
        setPromptKey(promptKey() + 1)
        return
      }
      const poll = async () => {
        if (cancelled) return
        const res = await AltimateApi.gatewayPollInstance(accessToken())
        if (cancelled) return
        if (res.status === "ready") return finish(res.instance, res.apiKey)
        setTimeout(poll, 1500)
      }
      poll()
    } catch (err) {
      if (cancelled) return
      setProvisioning(false)
      setInstanceError(err instanceof Error ? err.message : "Provisioning failed")
      setPromptKey(promptKey() + 1)
    }
  }

  async function finish(instance: string, apiKey: string) {
    await AltimateApi.saveCredentials({
      altimateUrl: AltimateApi.gatewayBaseUrl(),
      altimateInstanceName: instance,
      altimateApiKey: apiKey,
    })
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    if (cancelled) return
    local.model.set({ providerID: "altimate-backend", modelID: "altimate-default" }, { recent: true })
    markSetupComplete()
    toast.show({ message: "✓ Instance ready · 10M free tokens active", variant: "success" })
    dialog.clear()
  }

  // A fresh DialogPrompt each call, so a server-suggested name shows in the field.
  const instancePrompt = () => (
    <DialogPrompt
      title="Instance name"
      value={instanceName()}
      placeholder="your-company"
      busy={provisioning()}
      busyText="Provisioning your instance..."
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>This is your Altimate AI instance. Enter to accept · you can rename later.</text>
          <Show when={instanceError()}>
            <text fg={theme.error}>{instanceError()}</text>
          </Show>
        </box>
      )}
      onConfirm={submitInstance}
    />
  )

  return (
    <>
      <Show when={promptKey() === 0}>
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              Altimate LLM Gateway
            </text>
            <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
              esc
            </text>
          </box>
          <Show when={!authError()} fallback={<text fg={theme.error}>{authError()}</text>}>
            <box gap={1}>
              <text fg={theme.textMuted}>Sign in to activate your free Altimate instance (10M tokens).</text>
              <text fg={theme.textMuted}>Opening your browser — if it didn't open, go to:</text>
              <Link href={authUrl()} fg={theme.primary} />
              <Show when={userCode()}>
                <text fg={theme.text}>
                  Code: <span style={{ fg: theme.primary }}>{userCode()}</span>
                </text>
              </Show>
              <Spinner color={theme.textMuted}>Waiting for authorization...</Spinner>
            </box>
          </Show>
        </box>
      </Show>
      {/* Two mutually-exclusive slots; bumping promptKey swaps them, forcing the
          prompt to remount with the current (possibly server-suggested) name. */}
      <Show when={promptKey() > 0 && promptKey() % 2 === 1}>{instancePrompt()}</Show>
      <Show when={promptKey() > 0 && promptKey() % 2 === 0}>{instancePrompt()}</Show>
    </>
  )
}
// altimate_change end
