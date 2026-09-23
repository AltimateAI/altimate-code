// Altimate onboarding layer — kept in a dedicated, altimate-owned file so it does
// NOT enlarge the rebase surface of the upstream `dialog-model.tsx`. Holds the
// first-run readiness state, the curated welcome/provider picker, and the Altimate
// Base disclosure. Imports back into dialog-model are runtime-only (used inside
// callbacks/JSX), so the circular reference is safe.
import { createEffect, createMemo, createSignal, For, Show, onMount, onCleanup } from "solid-js"
import { useLocal, isLegacyBigPickleModel } from "../context/local"
import { useDialog } from "../ui/dialog"
import { useTheme, selectedForeground } from "../context/theme"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createDialogProviderOptions } from "./dialog-provider"
import { DialogModel } from "./dialog-model"
import { useConnected } from "./use-connected"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { useKV } from "../context/kv"
// altimate_change — onboarding funnel telemetry seam
import { useOnboardingTelemetry } from "../context/onboarding-telemetry"
// altimate_change — the Base disclosure has one definition, shared with the HTTP route
import { ALTIMATE_BASE_DISCLOSURE, ALTIMATE_BASE_HINT } from "@opencode-ai/core/altimate-base-disclosure"

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
// altimate_change start — cubic review (3986532221): app.tsx's startup effect used
// `setupComplete()` alone to decide whether THIS launch's model selection is a genuine
// first-run/impatient-picker completion (worth firing onboarding telemetry + the scan gate for)
// versus a RETURNING user's ordinary `/model` switch that merely raced the startup effect —
// `markSetupComplete()` fires for BOTH cases identically. `firstRunActive` above cannot answer
// this either: `markSetupComplete()` deliberately CLEARS it (so a later routine switch doesn't
// look like onboarding), so by the time app.tsx's effect gets around to checking it, it has
// already been reset to `false` for both a genuine first-run AND the very completion that would
// prove it happened. `firstRunOpenedThisLaunch` is a separate, ONE-WAY latch: set whenever the
// first-run picker actually opens THIS launch — either app.tsx's own startup fallthrough, or the
// prompt gate's equivalent for an impatient submit before that effect settles (see
// `component/prompt/index.tsx`'s `markFirstRunActive()` call) — and never cleared by
// `markSetupComplete()`/`clearFirstRunActive()` (only by `resetSetupComplete()`, on `/logout`,
// which returns the user to a genuinely fresh state). `setupComplete() &&
// firstRunOpenedThisLaunch()` is the correct "did first-run genuinely complete this launch"
// signal; a returning user's routine mid-race `/model` switch has `setupComplete() === true` but
// `firstRunOpenedThisLaunch() === false`, so it reads as `false` and no longer fires anything.
const [firstRunOpenedThisLaunch, setFirstRunOpenedThisLaunch] = createSignal(false)
export function useFirstRunOpenedThisLaunch() {
  return firstRunOpenedThisLaunch
}
// altimate_change end
export function markFirstRunActive() {
  setFirstRunActive(true)
  // altimate_change — see `firstRunOpenedThisLaunch`'s declaration above
  setFirstRunOpenedThisLaunch(true)
  // altimate_change end
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
  // altimate_change — see `firstRunOpenedThisLaunch`'s declaration above: /logout returns the
  // user to a genuinely fresh state, so a first run after it must be free to latch again.
  setFirstRunOpenedThisLaunch(false)
  // altimate_change end
}
export function useReady() {
  const connected = useConnected()
  // altimate_change start — fixes #1301 (Codex review, P2): a free public Zen model the user
  // either chose on purpose or already declined migrating away from is a legitimate way to use
  // the product, not "un-onboarded." Without this term, a returning free-default user who is
  // explicit or already said No gets treated as not-ready on every relaunch — the first-run
  // welcome picker reopens (see the first-run effect in app.tsx) and prompt submission itself
  // reopens the picker and discards whatever was typed (see `useReady()`'s callers in
  // component/prompt/index.tsx). `LocalProvider` wraps the whole app above `DialogProvider` (see
  // app.tsx), so `useLocal()` is always available to every caller of `useReady()`.
  const local = useLocal()
  // altimate_change — Codex HOLD finding 1: `hasUsableFreeDefault()` can now return `"pending"`
  // (kv not hydrated yet, see its declaration in local.tsx) as well as a boolean. Every consumer
  // of `useReady()` EXCEPT the prompt submit gate only needs a plain boolean (display text,
  // whether a command is enabled, the first-run chat lock) — `"pending"` collapses to `false` for
  // all of them, the same conservative default this code had before kv.ready-awareness existed.
  // `useReadyPending()` below is the ONE seam the submit gate uses to see the pending state
  // itself, so it can defer instead of discarding.
  return createMemo(() => connected() || setupComplete() || local.model.hasUsableFreeDefault() === true)
  // altimate_change end
}

// altimate_change start — Codex HOLD finding 1: true only when overall readiness cannot be
// decided YET — none of `connected()`/`setupComplete()` are already true, and the free-default
// predicate is specifically `"pending"` (kv still hydrating), not a settled `false`. The prompt
// submit gate (component/prompt/index.tsx) is the one caller that needs this: `useReady()` alone
// cannot distinguish "genuinely not usable, show the picker" from "don't know yet, kv is still
// loading" — both read as `false` there by design (see `useReady()`'s comment above), which is
// the right default for every OTHER consumer (display text, command enablement) but wrong for a
// submit gate whose `false` branch discards the typed prompt. This predicate lets the submit
// gate keep the prompt and retry once kv resolves, instead of guessing either way.
export function useReadyPending() {
  const connected = useConnected()
  const local = useLocal()
  return createMemo(() => !connected() && !setupComplete() && local.model.hasUsableFreeDefault() === "pending")
}
// altimate_change end

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
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
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
    // altimate_change — a failed selection must not permanently latch the row inert; only a
    // SUCCESSFUL selection is meant to be one-shot (it closes the dialog). Returning `true`
    // synchronously below keeps `activateRow`'s double-input guard active for the in-flight
    // window; this resets it if the attempt turns out to have failed.
    selectAltimateBase({ sdk, sync, local, toast, dialog }).then((selected) => {
      if (!selected) activated = false
    })
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
            note: ALTIMATE_BASE_HINT,
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

// altimate_change start — the gateway still logs requests, so this notice text stays even though
// registering no longer requires accepting it first. Defined once in core (imported at the top of
// this file) and re-exported here for existing consumers, so this TUI notice and the HTTP
// disclosure route (packages/opencode, for hosts that render their own copy) cannot drift apart —
// a copy change like #1268 now lands on both.
export { ALTIMATE_BASE_DISCLOSURE }
// altimate_change end

// altimate_change start — no consent dialog: selecting Altimate Base from any picker registers it
// if needed (or reuses an existing/auto-registered credential) and selects it directly. Replaces
// `DialogAltimateBaseConfirm`; keeps the same register -> refresh provider state -> validate ->
// select sequence that dialog used, and the same "show an error, don't select" behavior on
// failure.
type RegisterOutcome =
  | { ok: true }
  | { ok: false; result: "rate_limited" | "unavailable" | "network" | "error"; message: string }

const REGISTER_FAILURE_MESSAGE = "Could not set up Altimate Base. Try again, or pick another provider."

/**
 * Registers via the host-injected `sdk.registerAltimateBase` (the private worker RPC — see
 * context/sdk.tsx) when available. An attached TUI has no in-process worker to call
 * (cli/cmd/attach.ts never provides it), so it falls back to the server's own
 * `POST /altimate/base/register` route over the same transport (`sdk.fetch`/`sdk.url`) everything
 * else uses — including `sdk.headers`, the same Basic-auth headers `createOpencodeClient` bakes
 * into every typed SDK call, so this raw fetch doesn't 401 against a password-protected attached
 * server the way a bare `sdk.fetch` call would.
 */
async function registerAltimateBase(sdk: ReturnType<typeof useSDK>): Promise<RegisterOutcome> {
  try {
    if (sdk.registerAltimateBase) {
      const data = await sdk.registerAltimateBase()
      if (data.ok) return { ok: true }
      return { ok: false, result: data.result, message: data.message || REGISTER_FAILURE_MESSAGE }
    }
    const headers = new Headers(sdk.headers)
    headers.set("Content-Type", "application/json")
    const response = await sdk.fetch(`${sdk.url}/altimate/base/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    })
    const body = (await response.json().catch(() => undefined)) as
      | { ok?: boolean; result?: "rate_limited" | "unavailable" | "network" | "error"; message?: string }
      | undefined
    if (body?.ok) return { ok: true }
    return { ok: false, result: body?.result ?? "error", message: body?.message || REGISTER_FAILURE_MESSAGE }
  } catch {
    return { ok: false, result: "network", message: REGISTER_FAILURE_MESSAGE }
  }
}

// altimate_change start — exported so tests can simulate "already shown, this is a later launch"
// by pre-seeding kv.json with this key, the same way ALTIMATE_BASE_MIGRATION_DECLINED_KEY is
// exported from context/local.tsx for the same reason.
export const ALTIMATE_BASE_DISCLOSURE_SHOWN_KEY = "altimate_base_disclosure_shown_v1"
// altimate_change end

/**
 * Non-blocking replacement for the old consent dialog's disclosure text: a one-line toast shown
 * once per install, the first time Base becomes the active model — whether that happened via
 * autoRegister at startup or an explicit picker selection. Never blocks input.
 */
export function useAltimateBaseDisclosureNotice() {
  const local = useLocal()
  const kv = useKV()
  const toast = useToast()
  createEffect(() => {
    if (!kv.ready) return
    const model = local.model.current()
    if (!model || model.providerID !== "altimate-free" || model.modelID !== "altimate-base") return
    if (kv.get(ALTIMATE_BASE_DISCLOSURE_SHOWN_KEY, false)) return
    kv.set(ALTIMATE_BASE_DISCLOSURE_SHOWN_KEY, true)
    toast.show({ variant: "info", message: ALTIMATE_BASE_DISCLOSURE, duration: 8000 })
  })
}

/**
 * Shared by every picker that offers Altimate Base (the welcome picker, the full catalogue, and
 * the provider dialog): register if needed, refresh provider state, confirm the model actually
 * came up, then select it. An error at any step is shown via toast and the selection is left
 * alone — never a partial/failed switch.
 *
 * Also guards against the originating picker going away mid-flight (see `stillOpen()` below):
 * registration and bootstrap are both async, and if the user dismissed the picker or opened
 * something else in the meantime, neither the model switch nor `dialog.clear()` should run —
 * `clear()` would otherwise close whatever the user has open NOW, not the picker that started
 * this.
 */
export async function selectAltimateBase(input: {
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  local: ReturnType<typeof useLocal>
  toast: ReturnType<typeof useToast>
  dialog: ReturnType<typeof useDialog>
}): Promise<boolean> {
  // altimate_change start — Codex review finding: snapshot the top-of-stack item BY REFERENCE at
  // entry; `stillOpen()` re-checks it after every await below. `dialog.replace()`/`clear()` always
  // install a brand-new stack (and a dismissal empties it), so any of those happening in between —
  // whether the user backed out or a different feature took the dialog stack over — makes this
  // reference comparison false, and every call site below bails out silently: no toast (there is
  // nothing left for it to be about), no model switch, no `clear()`.
  const originatingDialog = input.dialog.stack.at(-1)
  const stillOpen = () => input.dialog.stack.at(-1) === originatingDialog
  // altimate_change end

  const outcome = await registerAltimateBase(input.sdk)
  if (!stillOpen()) return false
  if (!outcome.ok) {
    input.toast.show({ variant: "error", message: outcome.message })
    return false
  }

  await input.sdk.client.instance.dispose().catch(() => {})
  if (!stillOpen()) return false
  await input.sync.bootstrap().catch(() => {})
  if (!stillOpen()) return false
  const available = input.sync.data.provider.some(
    (provider) => provider.id === "altimate-free" && Boolean(provider.models?.["altimate-base"]),
  )
  if (!available) {
    const message = "Altimate Base was registered, but the model is not ready yet. Try again in a moment."
    input.toast.show({ variant: "error", message })
    return false
  }

  input.local.model.set({ providerID: "altimate-free", modelID: "altimate-base" }, { recent: true })
  input.dialog.clear()
  markSetupComplete()
  return true
}
// altimate_change end
