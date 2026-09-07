// Altimate onboarding layer — kept in a dedicated, altimate-owned file so it does
// NOT enlarge the rebase surface of the upstream `dialog-model.tsx`. Holds the
// first-run readiness state, the curated welcome/provider picker, and the Altimate
// Base disclosure. Imports back into dialog-model are runtime-only (used inside
// callbacks/JSX), so the circular reference is safe.
import { createEffect, createMemo, createSignal, For, Show, onMount, onCleanup } from "solid-js"
import { useLocal } from "../context/local"
import { useDialog } from "../ui/dialog"
import { useTheme, selectedForeground } from "../context/theme"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createDialogProviderOptions } from "./dialog-provider"
import { DialogModel } from "./dialog-model"
import { useConnected } from "./use-connected"
import { useSDK } from "../context/sdk"
// altimate_change — the consent-gated registration operation lives outside the public SDK
// context; see context/altimate-base-consent.tsx.
import { useAltimateBaseConsent, type AltimateBaseRegistration } from "../context/altimate-base-consent"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
// altimate_change — onboarding funnel telemetry seam
import { useOnboardingTelemetry } from "../context/onboarding-telemetry"

// Session-scoped "setup complete" flag. Set when the user picks a ready model,
// chooses Altimate Base, or finishes the gateway flow. Combined with
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
  // any model of that provider; add modelID to match a specific model.
  providerID?: string
  modelID?: string
}

export function DialogModelWelcome(props: {
  intro?: string
  // altimate_change — funnel: which path opened the picker. It also opens from /connect, from
  // declining Altimate Base, and from the prompt gate, so without this every impression would read
  // as a fresh first run. Defaults to the /connect case since that is the only caller that does
  // not pass one explicitly.
  trigger?: "first_run" | "connect_command" | "altimate_base_back" | "prompt_gate"
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

  function chooseAltimateBase(): boolean {
    if (!providers().some((provider) => provider.value === "altimate-free")) return false
    dialog.replace(() => <DialogAltimateBaseConfirm origin="welcome" />)
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
    ...(providers().some((provider) => provider.value === "altimate-free")
      ? [
          {
            name: "Altimate Base",
            note: "free · no signup · rate limited",
            tone: "warning" as const,
            providerID: "altimate-free",
            modelID: "altimate-base",
            activate: chooseAltimateBase,
          },
        ]
      : []),
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

  const searchIndex = createMemo(() => rows().length - 1)
  createEffect(() => {
    const last = rows().length - 1
    if (selected() > last) setSelected(Math.max(0, last))
  })
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

// altimate_change start — surfaced in the DialogAltimateBaseConfirm consent gate before any Base
// credential is minted. This is the text a user actually consents against before any registration
// request, so it must disclose that requests are linkable across launches — not defer that to
// docs/docs/configure/providers.md, which a user never sees before accepting. Keep this in sync
// with that fuller "Data handling" note.
export const ALTIMATE_BASE_DISCLOSURE =
  "Altimate Base is free and requires no signup. Requests and responses may be logged and used to improve Altimate's products, including the model. Secrets are automatically masked before storage, but don't rely on it — avoid sending secrets or confidential code. Logs are linked to a persistent per-installation identifier. Usage is rate limited."
// altimate_change end

type RegisterOutcome =
  | { ok: true }
  | { ok: false; result: "rate_limited" | "unavailable" | "network" | "error"; message: string }

const REGISTER_FAILURE_MESSAGE = "Could not set up Altimate Base. Try again, or pick another provider."

async function registerAltimateBase(register: AltimateBaseRegistration | undefined): Promise<RegisterOutcome> {
  if (!register) return { ok: false, result: "error", message: REGISTER_FAILURE_MESSAGE }
  try {
    const data = await register()
    if (data.ok) return { ok: true }
    return {
      ok: false,
      result: data.result,
      message: data.message || REGISTER_FAILURE_MESSAGE,
    }
  } catch {
    return { ok: false, result: "network", message: REGISTER_FAILURE_MESSAGE }
  }
}

// Consent disclosure and registration flow. The default remains No, and no identifier is minted
// until the user explicitly accepts.
export function DialogAltimateBaseConfirm(props: {
  // altimate_change — returning Big Pickle users reuse the same disclosure before migration
  origin: "welcome" | "model" | "migration"
  viaSearch?: boolean
  onDecline?: () => void
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()
  const sdk = useSDK()
  // altimate_change — the actual registration call, read from its own dedicated context rather
  // than the public SDK context; see context/altimate-base-consent.tsx.
  const altimateBaseConsent = useAltimateBaseConsent()
  const sync = useSync()
  const toast = useToast()
  const [selected, setSelected] = createSignal(0) // 0 = No (default)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const trackOnboarding = useOnboardingTelemetry()
  const firstRunActive = useFirstRunActive()
  let decided = false
  let choiceRecorded = false
  let disposed = false
  const releaseCloseGuard = dialog.guardClose(() => !busy())

  function recordChoice(choice: "accept" | "cancel") {
    if (choiceRecorded) return
    choiceRecorded = true
    if (firstRunActive() && props.origin !== "migration") {
      trackOnboarding({ name: "altimate_base_choice", choice })
    }
  }

  onMount(() => {
    // Migration is not first-run onboarding and must not enter that funnel.
    if (firstRunActive() && props.origin !== "migration") {
      trackOnboarding({ name: "altimate_base_confirm_shown", origin: props.origin })
    }
  })
  onCleanup(() => {
    releaseCloseGuard()
    disposed = true
    // Escape and click-away are handled by DialogProvider and never reach no(), but they are just
    // as much a refusal. Persisting the decline here too keeps a dismissed migration prompt from
    // reappearing on every launch forever.
    if (!decided && props.origin === "migration") props.onDecline?.()
    decided = true
    recordChoice("cancel")
  })

  function no() {
    if (decided || busy()) return
    decided = true
    recordChoice("cancel")
    // altimate_change — a migration decline no longer just leaves the dialog cleared: Big Pickle
    // is retired, so "pick something else" must actually route somewhere. `onDecline` still
    // persists the refusal first, so this prompt is not shown again on a later launch.
    if (props.origin === "migration") props.onDecline?.()
    dialog.replace(() =>
      props.origin === "model" ? (
        <DialogModel viaSearch={props.viaSearch} />
      ) : (
        <DialogModelWelcome trigger="altimate_base_back" />
      ),
    )
  }

  async function yes() {
    if (decided || busy()) return
    recordChoice("accept")
    setBusy(true)
    setError(undefined)
    const outcome = await registerAltimateBase(altimateBaseConsent)
    if (disposed) return
    if (firstRunActive() && props.origin !== "migration") {
      trackOnboarding({
        name: "altimate_base_register_result",
        result: outcome.ok ? "success" : outcome.result,
      })
    }
    if (!outcome.ok) {
      setBusy(false)
      setError(outcome.message)
      toast.show({ variant: "error", message: outcome.message })
      return
    }

    await sdk.client.instance.dispose().catch(() => {})
    if (disposed) return
    await sync.bootstrap().catch(() => {})
    if (disposed) return
    const available = sync.data.provider.some(
      (provider) => provider.id === "altimate-free" && Boolean(provider.models?.["altimate-base"]),
    )
    if (!available) {
      const message = "Altimate Base was registered, but the model is not ready yet. Try again in a moment."
      setBusy(false)
      setError(message)
      toast.show({ variant: "error", message })
      return
    }

    decided = true
    setBusy(false)
    if (props.origin === "migration") {
      // A migration also removes the retired implicit model from recents. Re-check eligibility
      // after registration so a project allowlist or explicit model change made while the dialog
      // was open cannot be overwritten by the returning-user migration.
      const migrated = local.model.migrateLegacyDefault()
      if (!migrated) {
        // Registration succeeded, but migration is no longer eligible — the user is still on the
        // retired Big Pickle model. Route to the picker instead of marking setup complete for a
        // model this session no longer treats as usable.
        dialog.replace(() => <DialogModelWelcome trigger="altimate_base_back" />)
        return
      }
    } else {
      local.model.set({ providerID: "altimate-free", modelID: "altimate-base" }, { recent: true })
    }
    dialog.clear()
    markSetupComplete()
  }

  const options = [
    {
      label: "No — pick something else",
      hint: "(default)",
      run: no,
    },
    { label: "Yes — use Altimate Base", hint: "", run: () => void yes() },
  ]

  useKeyboard((evt) => {
    if (busy()) {
      if (evt.name === "escape" || (evt.ctrl && evt.name === "c")) {
        evt.preventDefault()
        evt.stopPropagation()
      }
      return
    }
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
          Use Altimate Base?
        </text>
        <text fg={theme.textMuted} onMouseUp={() => !busy() && dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word" width="100%">
        {ALTIMATE_BASE_DISCLOSURE}
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
