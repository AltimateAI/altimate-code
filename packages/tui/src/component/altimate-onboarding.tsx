// Altimate onboarding layer — kept in a dedicated, altimate-owned file so it does
// NOT enlarge the rebase surface of the upstream `dialog-model.tsx`. Holds the
// first-run readiness state, the curated welcome/provider picker, and the Big
// Pickle interstitial. Imports back into dialog-model are runtime-only (used inside
// callbacks/JSX), so the circular reference is safe.
import { createMemo, createSignal, For, Show, onMount, onCleanup } from "solid-js"
import { useLocal } from "../context/local"
import { useDialog } from "../ui/dialog"
import { useTheme, selectedForeground } from "../context/theme"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createDialogProviderOptions } from "./dialog-provider"
import { DialogModel } from "./dialog-model"
import { useConnected } from "./use-connected"
// altimate_change — free-tier registration is an opencode-side action reached over the fork
// server endpoint; the toast surfaces failures that would otherwise be invisible.
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
// altimate_change — onboarding funnel telemetry seam
import { useOnboardingTelemetry } from "../context/onboarding-telemetry"

// Session-scoped "setup complete" flag. Set when the user picks a ready model,
// chooses the free Big Pickle option, or finishes the gateway flow. Combined with
// useConnected() (real credentials) via useReady(), it gates the first-run chat
// lock. Module-global so it is shared across the app and resets on every process
// launch (so a fresh relaunch is a clean fresh-user state).
const [setupComplete, setSetupComplete] = createSignal(false)

// Whether a first run is in progress. Set when the first-run gate opens the picker, cleared once
// setup completes. The full model catalogue (dialog-model.tsx) is shared with /model and routine
// model switching, so it consults this before emitting any funnel event — otherwise every model
// change for the life of the product would look like an onboarding provider choice.
const [firstRunActive, setFirstRunActive] = createSignal(false)
export function markFirstRunActive() {
  setFirstRunActive(true)
}
/**
 * Clear without marking setup complete.
 *
 * Needed for exactly one shape: the user HAS credentials but never chose a model, so
 * markSetupComplete() — the normal clear — will not run. The gateway's connected-but-no-usable-
 * model branch is the real instance (dialog-provider.tsx). Leaving the flag set there made later
 * routine /model use emit funnel events for the rest of the session.
 *
 * NOT for ordinary dismissals. A user who closes the picker without setting anything up is still
 * mid-first-run, and their next provider pick genuinely is the onboarding one.
 */
export function clearFirstRunActive() {
  setFirstRunActive(false)
}
export function useFirstRunActive() {
  return firstRunActive
}

export function markSetupComplete() {
  setSetupComplete(true)
  setFirstRunActive(false)
}
// Cleared on /logout so first-run tips don't keep showing "you're all set" after
// the credential is gone.
export function resetSetupComplete() {
  setSetupComplete(false)
  setFirstRunActive(false)
}
export function useReady() {
  const connected = useConnected()
  return createMemo(() => connected() || setupComplete())
}

/**
 * Setup completion ONLY — deliberately without the `connected()` term.
 *
 * `connected()` flips as soon as a provider appears in sync data, which happens inside
 * `await sync.bootstrap()` in the BYOK confirm handlers — before those handlers go on to open the
 * model picker. Anything driven off `useReady()` therefore fires while the user still has no model
 * selected, and is then immediately replaced by that picker. Use this accessor for "the user has
 * finished setting up", and `useReady()` only for "is chat usable at all".
 */
export function useSetupComplete() {
  return setupComplete
}

// First-run welcome picker (presentation only; reuses the same action handlers as
// DialogModel/createDialogProviderOptions). A curated six: five recommended
// providers + a "Search all providers…" row that hands off to the full DialogModel
// picker. The long tail stays behind search.
const NAME_W = 24
type WelcomeTone = "success" | "warning" | "muted"

interface WelcomeRow {
  name: string
  note: string
  tone: WelcomeTone
  activate: () => boolean
  // altimate_change — funnel: the "search all" row has no provider of its own; every other row
  // is identified by its raw providerID/modelID below and classified host-side.
  analyticsSearchAll?: boolean
  // Identifies the row for the "currently selected" tick. providerID alone matches
  // any model of that provider; add modelID to match a specific model (Big Pickle).
  providerID?: string
  modelID?: string
}

export function DialogModelWelcome(props: {
  intro?: string
  // altimate_change — funnel: which path opened the picker. It also opens from /connect, from
  // declining Big Pickle, and from the prompt gate, so without this every impression would read
  // as a fresh first run. Defaults to the /connect case since that is the only caller that does
  // not pass one explicitly.
  trigger?: "first_run" | "connect_command" | "big_pickle_back" | "free_gemini_back" | "prompt_gate"
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()
  const providers = createDialogProviderOptions()
  const [selected, setSelected] = createSignal(0)
  // altimate_change start — funnel: picker impression + provider choice
  const trackOnboarding = useOnboardingTelemetry()
  const firstRunActive = useFirstRunActive()
  // model_picker_shown carries a `trigger`, so a /connect impression is already distinguishable and
  // is kept. The choice events below are not distinguishable and are gated instead.
  onMount(() => trackOnboarding({ name: "model_picker_shown", trigger: props.trigger ?? "connect_command" }))
  // altimate_change end

  onMount(() => dialog.setSize("large"))

  /**
   * Reuse the exact provider onSelect (gateway flow for altimate-backend, auth-method screens for
   * the BYOK providers). Returns whether an action was actually dispatched: the server filters
   * providers via `enabled_providers` / `disabled_providers` while these five rows are hardcoded,
   * so a row can legitimately have no matching option and this would otherwise no-op in silence.
   */
  function connectProvider(id: string): boolean {
    const option = providers().find((o) => o.value === id)
    if (!option?.onSelect) return false
    option.onSelect()
    return true
  }

  function chooseBigPickle(): boolean {
    dialog.replace(() => <DialogBigPickleConfirm origin="welcome" />)
    return true
  }

  function chooseFreeGemini(): boolean {
    dialog.replace(() => <DialogFreeGeminiConfirm origin="welcome" />)
    return true
  }

  function openFullCatalog(): boolean {
    // altimate_change — viaSearch marks this as the genuine search path; the catalogue's other
    // entry points must not inherit it.
    dialog.replace(() => <DialogModel viaSearch />)
    return true
  }

  const rows = createMemo<WelcomeRow[]>(() => [
    {
      name: "Altimate LLM Gateway",
      note: "Recommended · best for data work · 10M free tokens",
      tone: "success",
      providerID: "altimate-backend",
      activate: () => connectProvider("altimate-backend"),
    },
    {
      name: "Anthropic (Claude)",
      note: "bring your own API key",
      tone: "muted",
      providerID: "anthropic",
      activate: () => connectProvider("anthropic"),
    },
    {
      name: "OpenAI (GPT)",
      note: "bring your own API key",
      tone: "muted",
      providerID: "openai",
      activate: () => connectProvider("openai"),
    },
    {
      name: "Google (Gemini)",
      note: "bring your own API key",
      tone: "muted",
      providerID: "google",
      activate: () => connectProvider("google"),
    },
    {
      name: "Gemini Flash (Free)",
      note: "free, no signup · prompts are logged",
      tone: "warning",
      providerID: "altimate-free",
      modelID: "gemini-flash-free",
      activate: chooseFreeGemini,
    },
    {
      name: "Big Pickle",
      note: "free · less reliable for data work",
      tone: "warning",
      providerID: "opencode",
      modelID: "big-pickle",
      activate: chooseBigPickle,
    },
    {
      name: "Search all providers…",
      note: "/",
      tone: "muted",
      activate: openFullCatalog,
      analyticsSearchAll: true,
    },
  ])

  // The currently active model → drives the green "selected" tick.
  const current = createMemo(() => local.model.current())
  const isCurrent = (row: WelcomeRow) => {
    const c = current()
    if (!row.providerID || !c || c.providerID !== row.providerID) return false
    return row.modelID ? c.modelID === row.modelID : true
  }

  // altimate_change — funnel: single choke point for row activation so keyboard and mouse
  // cannot diverge. Fires on selection, before auth resolves: a cancelled or failed sign-in
  // still counts as a provider having been chosen, which is what the funnel step means.
  // Guarded: keyboard return and mouse-up both reach here, and nothing stops two firing before
  // the dialog unmounts — a fast double input would both double-count and start the provider
  // flow twice. Per instance, so re-opening the picker is a genuinely new selection.
  let activated = false
  function activateRow(row: WelcomeRow) {
    if (activated) return
    // Claim the latch only once the action actually dispatched. Setting it first bricked the
    // dialog: `connectProvider` silently no-ops for a provider the server has filtered out, and
    // every later Enter, `/` and mouse-up then returned early — on the first-run gate, before the
    // user has any model at all.
    const dispatched = row.activate()
    if (!dispatched) return
    activated = true
    // Funnel-only: /connect opens this same picker for an established user, and provider_selected
    // carries no trigger, so an ungated emit would contaminate that launch's funnel.
    if (firstRunActive())
      trackOnboarding({
      name: "provider_selected",
      ...(row.analyticsSearchAll
        ? { searchAll: true }
        : { providerID: row.providerID, modelID: row.modelID }),
      })
  }

  // The last row is the search row (rendered below a divider); everything above it is a provider.
  // altimate_change — derived rather than hardcoded so adding a provider row (the free Gemini
  // Flash entry) cannot silently strand the search row outside the keyboard cycle.
  const searchIndex = createMemo(() => rows().length - 1)
  function move(direction: number) {
    const count = rows().length
    setSelected((prev) => (prev + direction + count) % count)
  }

  useKeyboard((evt) => {
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) return move(-1)
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) return move(1)
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      activateRow(rows()[selected()])
      return
    }
    // "/", ctrl+a, or any letter/number reveals the full searchable catalog.
    if (evt.name === "/" || (evt.ctrl && evt.name === "a") || /^[a-z0-9]$/i.test(evt.name ?? "")) {
      evt.preventDefault()
      // altimate_change — the "/" shortcut is the same intent as the "Search all providers…"
      // row, so it routes through the same guarded path.
      activateRow(rows()[searchIndex()])
    }
  })

  const selFg = selectedForeground(theme)
  const transparent = RGBA.fromInts(0, 0, 0, 0)
  const noteColor = (tone: WelcomeTone) =>
    tone === "success" ? theme.success : tone === "warning" ? theme.warning : theme.textMuted

  const Row = (props: { row: WelcomeRow; index: number; onActivate: (row: WelcomeRow) => void }) => {
    const active = createMemo(() => selected() === props.index)
    return (
      <box
        flexDirection="row"
        gap={1}
        onMouseMove={() => setSelected(props.index)}
        onMouseUp={() => props.onActivate(props.row)}
      >
        <text flexShrink={0} fg={theme.primary}>
          {active() ? "›" : " "}
        </text>
        <box
          width={NAME_W}
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={active() ? theme.primary : transparent}
        >
          <text
            fg={active() ? selFg : theme.text}
            attributes={active() ? TextAttributes.BOLD : undefined}
            wrapMode="none"
          >
            {props.row.name}
          </text>
        </box>
        {/* bright green so it reads clearly even where ANSI green renders dim */}
        <text flexShrink={0} fg={theme.diffHighlightAdded} attributes={TextAttributes.BOLD}>
          {isCurrent(props.row) ? "✓" : " "}
        </text>
        <text flexGrow={1} fg={noteColor(props.row.tone)} wrapMode="none">
          {isCurrent(props.row) ? `${props.row.note} · selected` : props.row.note}
        </text>
      </box>
    )
  }

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <Show when={props.intro}>
        <box paddingBottom={1} paddingLeft={1}>
          <text fg={theme.textMuted}>{props.intro}</text>
        </box>
      </Show>
      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        title=" Altimate Code "
        titleAlignment="left"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        gap={1}
      >
        <text wrapMode="none">
          <span style={{ fg: theme.text }}>
            <b>Select a provider</b>
          </span>
          <span style={{ fg: theme.textMuted }}> — you can change this anytime with /model</span>
        </text>
        <box gap={0}>
          <For each={rows().slice(0, searchIndex())}>
            {(row, i) => <Row row={row} index={i()} onActivate={activateRow} />}
          </For>
        </box>
        <box border={["top"]} borderColor={theme.border} />
        <Row row={rows()[searchIndex()]} index={searchIndex()} onActivate={activateRow} />
      </box>
    </box>
  )
}

// altimate_change start — free Gemini Flash interstitial.
//
// The disclosure below is the consent gate for the whole free tier: no install identifier is
// minted and nothing is sent to the gateway until `yes()` runs, so this text is on screen before
// the first network call. The wording is fixed — it is the notice users are shown about payload
// logging — and a test pins it.
export const FREE_GEMINI_DISCLOSURE =
  "Free model — requests and responses are logged and may be used to improve Altimate's products and services. Don't send secrets or confidential code. No signup required."

type RawSdkClient = {
  post(options: {
    url: string
    body?: unknown
    headers?: Record<string, string>
  }): Promise<{ data?: unknown; error?: unknown }>
}

type RegisterOutcome =
  | { ok: true }
  | { ok: false; result: "rate_limited" | "unavailable" | "network" | "error"; message: string }

const REGISTER_FAILURE_MESSAGE = "Could not set up the free model. Try again, or pick another provider."

/**
 * Registration runs opencode-side (POST /altimate/free/register) because the install secret and
 * the credential it returns belong to the process that owns the auth store. The raw client is
 * used for the same reason prompt auto-enhance does: fork endpoints are not in the generated SDK.
 */
async function registerFreeTier(sdk: ReturnType<typeof useSDK>): Promise<RegisterOutcome> {
  const raw = (sdk.client as unknown as { client?: RawSdkClient }).client
  if (!raw) return { ok: false, result: "error", message: REGISTER_FAILURE_MESSAGE }
  try {
    const response = await raw.post({
      url: "/altimate/free/register",
      body: {},
      headers: { "Content-Type": "application/json" },
    })
    // The route answers 200 with `ok:false` for a rejection, but read the error channel too: a
    // non-2xx from anywhere else in the stack lands there, and reading only `data` would report
    // every one of those as a network failure.
    const data = (response.data ?? response.error) as
      | { ok?: unknown; message?: unknown; status?: unknown }
      | undefined
    if (data?.ok === true) return { ok: true }
    const status = typeof data?.status === "number" ? data.status : undefined
    return {
      ok: false,
      result: status === 429 ? "rate_limited" : status === 503 ? "unavailable" : status ? "error" : "network",
      message: typeof data?.message === "string" ? data.message : REGISTER_FAILURE_MESSAGE,
    }
  } catch {
    return { ok: false, result: "network", message: REGISTER_FAILURE_MESSAGE }
  }
}

export function DialogFreeGeminiConfirm(props: {
  origin: "welcome" | "model"
  /** Carried so declining returns to the catalogue the user actually came through. */
  viaSearch?: boolean
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()
  const sdk = useSDK()
  const toast = useToast()
  const [selected, setSelected] = createSignal(0) // 0 = No (default)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const trackOnboarding = useOnboardingTelemetry()
  const firstRunActive = useFirstRunActive()
  // Two latches, because the dialog can outlive the decision. `decided` closes the dialog's own
  // navigation; `choice` is telemetry-only and, unlike `decided`, is claimed the moment the user
  // accepts — a failed registration keeps the dialog open for a retry, and neither that retry nor
  // the eventual dismissal may record a second choice for the same user.
  let decided = false
  let choice = false

  function recordChoice(value: "accept" | "cancel") {
    if (choice) return
    choice = true
    if (firstRunActive()) trackOnboarding({ name: "free_gemini_choice", choice: value })
  }

  onMount(() => {
    if (firstRunActive()) trackOnboarding({ name: "free_gemini_confirm_shown", origin: props.origin })
  })
  // Escape and click-away are handled by DialogProvider and never reach the key handler below, so
  // cleanup is the only place that sees every non-y/n dismissal.
  onCleanup(() => {
    decided = true
    recordChoice("cancel")
  })

  function no() {
    if (decided || busy()) return
    decided = true
    recordChoice("cancel")
    dialog.replace(() =>
      props.origin === "welcome" ? (
        <DialogModelWelcome trigger="free_gemini_back" />
      ) : (
        <DialogModel viaSearch={props.viaSearch} />
      ),
    )
  }

  async function yes() {
    if (decided || busy()) return
    recordChoice("accept")
    setError(null)
    setBusy(true)
    const outcome = await registerFreeTier(sdk)
    setBusy(false)
    if (firstRunActive())
      trackOnboarding({
        name: "free_gemini_register_result",
        result: outcome.ok ? "success" : outcome.result,
      })
    if (!outcome.ok) {
      setError(outcome.message)
      toast.show({ variant: "error", message: outcome.message })
      return
    }
    // The user can escape while the request is in flight, and this continuation resumes into a
    // dialog that is already gone. The credential is stored either way — they will find the model
    // in the picker — but clearing a dialog we no longer own, and switching their model behind
    // their back, are not ours to do any more.
    if (decided) return
    decided = true
    // The provider only autoloads once the credential exists, so the running instance has to
    // re-resolve before the model is selectable.
    await sdk.client.instance.dispose().catch(() => {})
    dialog.clear()
    local.model.set({ providerID: "altimate-free", modelID: "gemini-flash-free" }, { recent: true })
    markSetupComplete()
  }

  const options = [
    { label: "No — pick something else", hint: "(default)", run: no },
    { label: "Yes — use Gemini Flash (Free)", hint: "", run: () => void yes() },
  ]

  useKeyboard((evt) => {
    if (busy()) return
    if (evt.name === "up" || evt.name === "down") {
      setSelected((prev) => (prev + 1) % 2)
      evt.preventDefault()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      options[selected()].run()
      return
    }
    if (evt.name === "y" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      void yes()
      return
    }
    if (evt.name === "n" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      no()
    }
  })

  const selFg = selectedForeground(theme)
  const transparent = RGBA.fromInts(0, 0, 0, 0)

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Gemini Flash (Free)
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word" width="100%">
        {FREE_GEMINI_DISCLOSURE}
      </text>
      <Show when={error()}>
        <text fg={theme.error} wrapMode="word" width="100%">
          {error()!}
        </text>
      </Show>
      <Show when={busy()}>
        <text fg={theme.textMuted}>Setting up…</text>
      </Show>
      <box>
        <For each={options}>
          {(option, index) => (
            <box flexDirection="row" gap={1} onMouseMove={() => setSelected(index())} onMouseUp={() => option.run()}>
              <text flexShrink={0} fg={theme.primary}>
                {selected() === index() ? "›" : " "}
              </text>
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={selected() === index() ? theme.primary : transparent}
              >
                <text
                  fg={selected() === index() ? selFg : theme.text}
                  attributes={selected() === index() ? TextAttributes.BOLD : undefined}
                >
                  {option.label}
                </text>
              </box>
              <Show when={option.hint}>
                <text fg={theme.textMuted}>{option.hint}</text>
              </Show>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
// altimate_change end

// Big Pickle interstitial — one confirm, default No. Custom component (not
// DialogSelect) so the full warning wraps instead of clipping; y/n keys work,
// enter accepts the highlighted row (No by default).
export function DialogBigPickleConfirm(props: {
  origin: "welcome" | "model"
  /** altimate_change — funnel: carried only so the `no()` return path can hand it back to
   *  DialogModel. Cancelling out of Big Pickle does not leave the catalogue the user reached
   *  through "Search all providers…", but dropping it here re-created the next pick as
   *  via_search:false. */
  viaSearch?: boolean
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()
  const [selected, setSelected] = createSignal(0) // 0 = No (default)
  // altimate_change start — funnel: interstitial impression + decision.
  // `decided` guards against a double-submit: keyboard and mouse handlers both call yes()/no()
  // directly, and nothing prevents two firing before the dialog unmounts.
  const trackOnboarding = useOnboardingTelemetry()
  const firstRunActive = useFirstRunActive()
  let decided = false
  // Funnel-only: /model reaches this interstitial with origin="model" for an established user.
  onMount(() => {
    if (firstRunActive()) trackOnboarding({ name: "big_pickle_confirm_shown", origin: props.origin })
  })
  // Every close that is not y/n is still a decision not to take Big Pickle, and the funnel showed
  // an impression with no choice for all of them. onCleanup (rather than the inline `esc` control)
  // is what makes this cover ALL of them — the Escape key and click-away are handled by
  // DialogProvider and never reach this component's own handlers. `decided` keeps yes()/no() from
  // double-emitting when their dialog.clear()/replace() unmounts us.
  onCleanup(() => {
    if (decided) return
    decided = true
    if (firstRunActive()) trackOnboarding({ name: "big_pickle_choice", choice: "cancel" })
  })
  // altimate_change end

  function no() {
    // altimate_change start
    if (decided) return
    decided = true
    if (firstRunActive()) trackOnboarding({ name: "big_pickle_choice", choice: "cancel" })
    // altimate_change end
    dialog.replace(() =>
      props.origin === "welcome" ? (
        <DialogModelWelcome trigger="big_pickle_back" />
      ) : (
        <DialogModel viaSearch={props.viaSearch} />
      ),
    )
  }
  function yes() {
    // altimate_change start
    if (decided) return
    decided = true
    if (firstRunActive()) trackOnboarding({ name: "big_pickle_choice", choice: "accept" })
    // altimate_change end
    dialog.clear()
    local.model.set({ providerID: "opencode", modelID: "big-pickle" }, { recent: true })
    markSetupComplete()
  }
  const options = [
    { label: "No — pick something else", hint: "(default)", run: no },
    { label: "Yes — continue with Big Pickle", hint: "", run: yes },
  ]

  useKeyboard((evt) => {
    if (evt.name === "up" || evt.name === "down") {
      setSelected((prev) => (prev + 1) % 2)
      evt.preventDefault()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      options[selected()].run()
      return
    }
    if (evt.name === "y" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      yes()
      return
    }
    if (evt.name === "n" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      no()
    }
  })

  const selFg = selectedForeground(theme)
  const transparent = RGBA.fromInts(0, 0, 0, 0)

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Use Big Pickle?
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word" width="100%">
        Big Pickle works for chat but often fails at data tasks. The Gateway is free to start (10M tokens). Continue?
        [y/N]
      </text>
      <box>
        <For each={options}>
          {(option, index) => (
            <box flexDirection="row" gap={1} onMouseMove={() => setSelected(index())} onMouseUp={() => option.run()}>
              <text flexShrink={0} fg={theme.primary}>
                {selected() === index() ? "›" : " "}
              </text>
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={selected() === index() ? theme.primary : transparent}
              >
                <text
                  fg={selected() === index() ? selFg : theme.text}
                  attributes={selected() === index() ? TextAttributes.BOLD : undefined}
                >
                  {option.label}
                </text>
              </box>
              <Show when={option.hint}>
                <text fg={theme.textMuted}>{option.hint}</text>
              </Show>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
