import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo } from "solid-js"
import { useSync } from "./sync"
import { useEvent } from "./event"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { readJson, writeJsonAtomic } from "../util/persistence"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute } from "./route"
// altimate_change — reuse the same free-tier marker `isAnyProviderConnected` uses so the two
// checks cannot silently diverge; see `isFreeZenModel` below.
import type { ConnectedProviderShape } from "../util/connected"
// altimate_change — fixes #1301 (Codex review, P2): `hasUsableFreeDefault` below needs to see the
// same migration-decline kv key app.tsx writes.
import { useKV } from "./kv"

export type LocalTheme = {
  secondary: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  primary: RGBA
  error: RGBA
  info: RGBA
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

// altimate_change start — migrate only the retired implicit free-model choice
export type ModelRef = { providerID: string; modelID: string }

export const LEGACY_BIG_PICKLE_MODEL = {
  providerID: "opencode",
  modelID: "big-pickle",
} as const satisfies ModelRef

export const ALTIMATE_BASE_MODEL = {
  providerID: "altimate-free",
  modelID: "altimate-base",
} as const satisfies ModelRef

// altimate_change — remember an explicit migration decline without suppressing later manual
// setup. Moved here (from app.tsx) so `hasUsableFreeDefault` below can read the same key.
export const ALTIMATE_BASE_MIGRATION_DECLINED_KEY = "altimate_base_big_pickle_migration_declined_v1"

export function isModelRef(model: unknown): model is ModelRef {
  if (!model || typeof model !== "object") return false
  const value = model as Record<string, unknown>
  return typeof value.providerID === "string" && typeof value.modelID === "string"
}

export function isLegacyBigPickleModel(model: unknown): model is ModelRef {
  if (!isModelRef(model)) return false
  return model.providerID === LEGACY_BIG_PICKLE_MODEL.providerID && model.modelID === LEGACY_BIG_PICKLE_MODEL.modelID
}

export function isExistingBigPickleSelection(current: unknown, recent: readonly unknown[], explicit: boolean) {
  if (!isLegacyBigPickleModel(current)) return false
  return explicit || recent.some(isLegacyBigPickleModel)
}

export function allowsManagedBaseDefault(providerConfig: unknown) {
  if (providerConfig === undefined || providerConfig === null) return true
  if (typeof providerConfig !== "object" || Array.isArray(providerConfig)) return false
  // A non-empty provider block is an explicit project allowlist. As in Provider.defaultModel,
  // naming the managed provider there cannot force it into the request-logging default path.
  return Object.keys(providerConfig).length === 0
}

export function shouldMigrateLegacyDefault(
  current: unknown,
  recent: readonly unknown[],
  explicit: boolean,
  providerConfig: unknown,
) {
  if (explicit || !allowsManagedBaseDefault(providerConfig)) return false
  return isExistingBigPickleSelection(current, recent, false)
}

// A picker-driven selection (`/model`, the provider dialog, onboarding) persists through the same
// `model`/`recent` fields the retired implicit default used, so `shouldMigrateLegacyDefault` alone
// cannot tell "the user never chose anything" from "the user deliberately picked Big Pickle again
// after registering Altimate Base." `explicitDefault` is a separate marker set only by an
// interactive picker (see `local.tsx`'s `set`); the current selection counts as explicit only when
// it still matches that marker exactly — if the user has since picked something else, or restored
// an older session, the marker no longer applies and migration is free to run again.
export function isConfirmedExplicitSelection(current: unknown, explicitDefault: unknown): boolean {
  if (!isModelRef(current) || !isModelRef(explicitDefault)) return false
  return current.providerID === explicitDefault.providerID && current.modelID === explicitDefault.modelID
}
// altimate_change end

// altimate_change start — fixes #1301: offer Altimate Base to every user riding an implicit free
// public Zen default, not only the retired Big Pickle id. `shouldMigrateLegacyDefault` above
// required Big Pickle in `recent`, but only a picker-driven pick ever writes `recent` — the vast
// majority of implicit-default users never touched a picker, so they were never offered Base.
export function isFreeZenModel(model: ModelRef | undefined, providers: readonly ConnectedProviderShape[]): boolean {
  if (!model || model.providerID !== "opencode") return false
  const provider = providers.find((item) => item.id === model.providerID)
  const info = provider?.models[model.modelID]
  if (!info) return false
  // Same free-tier marker `util/connected.ts`'s `isAnyProviderConnected` uses: a missing cost or
  // an explicit zero on the built-in `opencode` provider both mean the public free tier.
  const cost = info.cost?.input
  return cost == null || cost === 0
}

export function shouldOfferManagedBaseDefault(
  current: ModelRef | undefined,
  explicit: boolean,
  providerConfig: unknown,
  isFree: (model: ModelRef) => boolean,
): boolean {
  if (explicit || !allowsManagedBaseDefault(providerConfig)) return false
  if (current == null) return false
  return isFree(current)
}
// altimate_change end

// altimate_change start — fixes #1301 (Codex review, P2): pure predicate for "is the CURRENT
// model a free public Zen model the user is fine staying on" — explicitly chosen, or already
// declined migrating away from. A free default the user picked on purpose or already said No to
// moving is a legitimate way to use the product, not "un-onboarded"; without this, a returning
// free-default user who is explicit or already declined gets treated as not-ready on every
// relaunch (see `hasUsableFreeDefault`'s call site for what that breaks).
export function isUsableFreeDefault(
  current: ModelRef | undefined,
  isValid: (model: ModelRef) => boolean,
  isFree: (model: ModelRef) => boolean,
  explicit: boolean,
  declined: boolean,
): boolean {
  if (!current || !isValid(current)) return false
  if (!isFree(current)) return false
  return explicit || declined
}
// altimate_change end

// altimate_change start — fixes #1301 (Codex review round 2, P1): an older picker-written Zen
// recent that predates the `explicitDefault` marker (see that field's declaration comment) is
// still the user's OWN past pick, not a truly implicit default — `recentModels()` only ever adds
// an entry through a deliberate `/model` pick, session restore, or this migration itself. Silent
// migration (when Base is already registered) must not sweep that up without asking; the
// disclosure stays declinable for it. Big Pickle is deliberately excluded: recents written before
// this whole distinction existed were always silently migrated, and that stays unchanged.
export function isOwnPastPickOfFreeDefault(current: ModelRef | undefined, recent: readonly ModelRef[]): boolean {
  if (!current) return false
  // Destructured BEFORE the `isLegacyBigPickleModel` check, not after: it is itself a type
  // predicate over `ModelRef`, and TS (still, even through a `const` alias — "control flow
  // analysis of aliased conditions") narrows `current` on its false branch by subtracting that
  // asserted type from `current`'s already-`ModelRef` type, which collapses straight to `never`
  // and breaks any later property access on `current` (same hazard `migrateLegacyRecentModels`
  // documents above).
  const { providerID, modelID } = current
  if (isLegacyBigPickleModel(current)) return false
  return recent.some((item) => item.providerID === providerID && item.modelID === modelID)
}
// altimate_change end

// altimate_change start — fixes #1301 (Codex review round 2, P1): migration is a decision about
// the DEFAULT, not about an already-open conversation. `current` is `currentModel()` (can be a
// session-restored model, `restoreSession`/`--continue`); `previous` is the `fallbackModel()`
// captured before migration mutates anything — the implicit default actually being migrated
// away from. Only move the active agent's model when it is STILL that default (or there simply
// is no current model to preserve); a restored conversation on some other model must be left
// alone — migrating the default must not silently rewrite an unrelated open thread onto Base.
export function shouldMoveAgentModelDuringMigration(
  current: ModelRef | undefined,
  previous: ModelRef | undefined,
): boolean {
  if (!current) return true
  if (!previous) return false
  return current.providerID === previous.providerID && current.modelID === previous.modelID
}
// altimate_change end

// altimate_change start — Codex review round 2, P2: `migrateLegacyDefault({ from })`'s captured
// `from` must not bypass free-model validation entirely — a provider refresh moving
// `fallbackModel()` off `from` onto some OTHER (in particular PAID) model while the dialog is
// open must not still let accept insert Base. Only the ONE transition this capture exists for is
// allowed: the launch default is either still exactly `from`, or registration itself already
// moved it to Base (the expected post-registration state `usesLegacyDefault()`'s own `isFree`
// check can no longer see, since Base is not a free model).
function sameModel(a: ModelRef | undefined, b: ModelRef): boolean {
  return a !== undefined && a.providerID === b.providerID && a.modelID === b.modelID
}

export function isMigrationStillEligibleAfterCapture(
  current: ModelRef | undefined,
  from: ModelRef,
  explicit: boolean,
  providerConfig: unknown,
): boolean {
  if (explicit || !allowsManagedBaseDefault(providerConfig)) return false
  return sameModel(current, from) || sameModel(current, ALTIMATE_BASE_MODEL)
}
// altimate_change end

export function recentModels(
  model: { providerID: string; modelID: string },
  recent: { providerID: string; modelID: string }[],
) {
  const seen = new Set<string>()
  return [model, ...recent]
    .filter((item) => {
      const key = `${item.providerID}/${item.modelID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
    .map((item) => ({ providerID: item.providerID, modelID: item.modelID }))
}

// altimate_change start — remove Big Pickle from migrated recents without touching other models.
// `previous` additionally drops the free Zen model just migrated away from (any implicit free
// default now, not only Big Pickle) so `cycle()` does not bounce straight back onto it.
export function migrateLegacyRecentModels(recent: readonly unknown[], previous?: ModelRef) {
  return recentModels(
    ALTIMATE_BASE_MODEL,
    recent.filter(
      // `isLegacyBigPickleModel` is checked LAST: it is itself a type predicate over `ModelRef`,
      // and TS narrows `model` on its false branch by subtracting that asserted type from
      // `model`'s current (already-`ModelRef`) type — which collapses straight to `never` and
      // breaks the `previous` field access below if that access comes after this call instead.
      (model): model is ModelRef =>
        isModelRef(model) &&
        !(previous && model.providerID === previous.providerID && model.modelID === previous.modelID) &&
        !isLegacyBigPickleModel(model),
    ),
  )
}
// altimate_change end

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const theme = useTheme().theme
    const route = useRoute()
    const paths = useTuiPaths()
    // altimate_change start — fixes #1301 (Codex review, P2): `hasUsableFreeDefault` reads the
    // migration-decline kv key here too. `KVProvider` wraps `LocalProvider` in app.tsx, so this
    // is always available.
    const kv = useKV()
    // altimate_change end

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((item) => item.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    function createAgent() {
      const agents = createMemo(() => sync.data.agent.filter((agent) => agent.mode !== "subagent" && !agent.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((agent) => !agent.hidden))
      const [agentStore, setAgentStore] = createStore({
        current: undefined as string | undefined,
      })
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) ?? agents().at(0)
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((x) => x.name === current.name) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    }

    const agent = createAgent()

    function createModel() {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
        // altimate_change start — the model a user last picked through an interactive picker
        // (`/model`, the provider dialog, onboarding). Distinguishes a DELIBERATE re-selection of
        // Big Pickle from the retired implicit default: both persist through `model`/`recent`, but
        // only this marks "the user chose this on purpose," so legacy-default migration never
        // silently overwrites it. See `hasExplicitModel` / `shouldMigrateLegacyDefault` below.
        explicitDefault: ModelRef | undefined
        // altimate_change end
        // altimate_change start — fixes #1301 (Codex review, P1): a migration decline used to
        // live ONLY in the TUI's kv store (app.tsx's `ALTIMATE_BASE_MIGRATION_DECLINED_KEY`),
        // which headless/server default selection (`Provider.defaultModel()`, ACP) cannot see.
        // Persisting it here too, alongside the rest of the model state the server already reads
        // from `model.json`, lets the server-side consent gate honor the same refusal.
        declinedManagedBaseDefault: boolean
        // altimate_change end
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
        // altimate_change start — see the `explicitDefault` field declaration above
        explicitDefault: undefined,
        // altimate_change end
        // altimate_change start — see the `declinedManagedBaseDefault` field declaration above
        declinedManagedBaseDefault: false,
        // altimate_change end
      })

      const filePath = path.join(paths.state, "model.json")
      const state = {
        pending: false,
      }
      // altimate_change start — PR #1302 review (CodeRabbit + cubic "Await the atomic writes
      // before disposing the state directory"; Codex review round 2, P2: a single `pendingWrite`
      // reassigned on every `save()` only let a caller wait for the LATEST write — an earlier one
      // still in flight (rapid consecutive `save()` calls, e.g. `declineManagedBaseDefault()`
      // immediately followed by another mutation) was silently dropped from what `persisted()`
      // waited for). Track every outstanding write in a Set instead, each removing itself once
      // settled; `persisted()` below awaits all of them, not just the newest.
      const pendingWrites = new Set<Promise<void>>()
      // altimate_change end

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        // altimate_change — see `pendingWrites`' declaration above
        const write = writeJsonAtomic(filePath, {
          recent: modelStore.recent,
          favorite: modelStore.favorite,
          variant: modelStore.variant,
          // altimate_change start — persist the last explicitly-picked model across launches
          explicitDefault: modelStore.explicitDefault,
          // altimate_change end
          // altimate_change start — see the `declinedManagedBaseDefault` field declaration above
          declinedManagedBaseDefault: modelStore.declinedManagedBaseDefault,
          // altimate_change end
        })
        pendingWrites.add(write)
        // `.catch()` here keeps `write` itself from ever being an unhandled rejection (a handler
        // is now attached directly to it); `persisted()`'s `Promise.allSettled` below tolerates
        // either outcome regardless.
        write.catch(() => {}).finally(() => pendingWrites.delete(write))
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const value = x as Record<string, unknown>
          // altimate_change start — discard malformed persisted model references before default migration
          if (Array.isArray(value.recent)) setModelStore("recent", value.recent.filter(isModelRef))
          // altimate_change end
          if (Array.isArray(value.favorite)) setModelStore("favorite", value.favorite)
          if (typeof value.variant === "object" && value.variant !== null)
            setModelStore("variant", value.variant as Record<string, string | undefined>)
          // altimate_change start — restore the last explicitly-picked model
          if (isModelRef(value.explicitDefault)) setModelStore("explicitDefault", value.explicitDefault)
          // altimate_change end
          // altimate_change start — restore a persisted Base-migration decline
          if (typeof value.declinedManagedBaseDefault === "boolean")
            setModelStore("declinedManagedBaseDefault", value.declinedManagedBaseDefault)
          // altimate_change end
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const args = useArgs()

      // altimate_change start — distinguish explicit model choices from the retired implicit default
      // A command-line, project, or agent model is an explicit choice. So is a model the user
      // picked through an interactive picker (`/model`, the provider dialog, onboarding) that is
      // STILL the current selection — persisted separately as `explicitDefault` because a picker
      // choice lands in the same `model`/`recent` fields the old implicit default used, and legacy
      // migration cannot tell those apart without this. Legacy migration applies only to the
      // implicit/persisted default and must never rewrite any of these.
      function hasExplicitModel() {
        if (args.model || sync.data.config.model) return true
        if (agent.current()?.model) return true
        return isConfirmedExplicitSelection(currentModel(), modelStore.explicitDefault)
      }

      // altimate_change start — fixes #1301 (Codex review, P1): `usesImplicitFreeDefault` below
      // judges eligibility against `fallbackModel()` (the LAUNCH default), so explicitness must be
      // judged against that SAME model — not `currentModel()`, which `hasExplicitModel` above
      // uses and which can be a session-restored model (`restoreSession`, `--continue`) unrelated
      // to what this launch would actually fall back to. Using `hasExplicitModel()` there let an
      // explicit Nemotron pick read as "implicit" whenever a different conversation happened to be
      // open, and `migrateLegacyDefault()` then overwrote that restored conversation's model.
      // Older picker-written recents without an `explicitDefault` marker remain eligible here by
      // design (see that field's declaration comment) — those users still see one declinable
      // migration prompt rather than being silently exempted forever.
      function hasExplicitDefault() {
        if (args.model || sync.data.config.model) return true
        if (agent.current()?.model) return true
        return isConfirmedExplicitSelection(fallbackModel(), modelStore.explicitDefault)
      }
      // altimate_change end

      function hasExplicitLegacyModel() {
        const configured = [args.model, sync.data.config.model]
          .filter((model): model is string => Boolean(model))
          .some((model) => isLegacyBigPickleModel(parseModel(model)))
        return configured || isLegacyBigPickleModel(agent.current()?.model)
      }
      // altimate_change end

      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        if (sync.data.config.model) {
          const { providerID, modelID } = parseModel(sync.data.config.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        // altimate_change start — apply the same managed-provider policy `Provider.defaultModel()`
        // enforces server-side: a project provider allowlist that excludes Altimate Base must not
        // let this implicit TUI fallback reintroduce it either, whether through a persisted recent
        // entry or the first-live-provider selection below. An explicit `--model`/config `model`
        // above remains authoritative regardless, matching the server.
        const managedBaseAllowed = allowsManagedBaseDefault(sync.data.config.provider)
        const isManagedBaseModel = (model: ModelRef) =>
          model.providerID === ALTIMATE_BASE_MODEL.providerID && model.modelID === ALTIMATE_BASE_MODEL.modelID

        // A recent entry is the user's own past pick, so — matching `Provider.defaultModel()`'s
        // comment on the same tradeoff — it stays honored for every provider except the
        // consent-gated managed one; a narrowed project allowlist does not retroactively invalidate
        // an otherwise-valid prior explicit choice.
        for (const item of modelStore.recent) {
          if (isModelValid(item) && (managedBaseAllowed || !isManagedBaseModel(item))) {
            return item
          }
        }

        // Unlike `recent`, this is an IMPLICIT last-resort pick with no history behind it, so it
        // must honor the full allowlist — not just exclude Altimate Base — or it can land on a
        // connected provider the project never named either.
        const configuredProviderIDs = Object.keys(sync.data.config.provider ?? {})
        const providerAllowed = (id: string) => configuredProviderIDs.length === 0 || configuredProviderIDs.includes(id)
        const provider = sync.data.provider.find(
          (candidate) =>
            providerAllowed(candidate.id) && (managedBaseAllowed || candidate.id !== ALTIMATE_BASE_MODEL.providerID),
        )
        // altimate_change end
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const currentModel = createMemo(() => {
        const a = agent.current()
        return (
          getFirstValidModel(
            () => a && modelStore.model[a.name],
            () => a && a.model,
            fallbackModel,
          ) ?? undefined
        )
      })

      // altimate_change start — share validated selection with legacy-default and session migration
      function selectModel(model: ModelRef, options?: { recent?: boolean; explicit?: boolean }) {
        let selected = false
        batch(() => {
          if (!isModelValid(model)) {
            toast.show({
              message: `Model ${model.providerID}/${model.modelID} is not valid`,
              variant: "warning",
              duration: 3000,
            })
            return
          }
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, model)
          if (options?.recent) setModelStore("recent", recentModels(model, modelStore.recent))
          // A picker-driven selection, as opposed to session restore or programmatic migration —
          // see `hasExplicitModel` above for why this needs its own persisted marker.
          if (options?.explicit) setModelStore("explicitDefault", { providerID: model.providerID, modelID: model.modelID })
          // altimate_change start — fixes #1301 (Codex review round 2, P2): ANY deliberate,
          // interactive explicit selection of Altimate Base clears an earlier migration decline —
          // not only `/connect`'s `set()`. `cycleFavorite` below calls `selectModel` directly, so
          // the clearing has to live HERE, in the one place every explicit selection funnels
          // through, or favorite-cycling to Base left `declinedManagedBaseDefault` (and the
          // mirrored kv key) stuck `true`, which a later headless/ACP launch still reads as a
          // refusal even though the user just picked Base on purpose. Both flags are cleared
          // together — see `declineManagedBaseDefault()` below for where both are SET together.
          if (
            options?.explicit &&
            model.providerID === ALTIMATE_BASE_MODEL.providerID &&
            model.modelID === ALTIMATE_BASE_MODEL.modelID
          ) {
            setModelStore("declinedManagedBaseDefault", false)
            kv.set(ALTIMATE_BASE_MIGRATION_DECLINED_KEY, false)
          }
          // altimate_change end
          if (options?.recent || options?.explicit) save()
          selected = true
        })
        return selected
      }

      // fixes #1301: evaluated against `fallbackModel()` (the LAUNCH default), not
      // `currentModel()`. `currentModel()` can resolve to a session-restored model
      // (`restoreSession`, `--continue`), which was never a deliberate choice either way and must
      // not be mistaken for "this launch's implicit default" — see `restoreSession` below.
      function usesImplicitFreeDefault() {
        return shouldOfferManagedBaseDefault(
          fallbackModel(),
          hasExplicitDefault(),
          sync.data.config.provider,
          (candidate) => isLegacyBigPickleModel(candidate) || isFreeZenModel(candidate, sync.data.provider),
        )
      }
      // Alias kept so existing call sites (app.tsx's migration effect, `migrateLegacyDefault`
      // below) do not need to change.
      const usesLegacyDefault = usesImplicitFreeDefault

      // altimate_change — fixes #1301 (Codex review round 2, P1): see `isOwnPastPickOfFreeDefault`
      // above. Evaluated against the same launch default (`fallbackModel()`) eligibility is
      // judged on, and app.tsx's silent-migration branch (Base already registered) consults it
      // to fall back to the declinable disclosure instead.
      function hasOwnPickOfImplicitDefault() {
        return isOwnPastPickOfFreeDefault(fallbackModel(), modelStore.recent)
      }

      function hasExistingLegacySelection() {
        return isExistingBigPickleSelection(currentModel(), modelStore.recent, hasExplicitLegacyModel())
      }
      // altimate_change end

      // altimate_change start — fixes #1301 (Codex review, P2): a free public Zen model the user
      // either chose on purpose or already said No to migrating away from is a legitimate way to
      // use the product, not "un-onboarded." Without this, a returning Nemotron user who
      // explicitly selected it (or already declined once) sees the first-run welcome picker on
      // every relaunch, re-enters the first-run funnel, and has prompt submission itself reopen
      // the picker and discard whatever they typed (see `useReady()`'s callers in
      // component/prompt/index.tsx).
      function hasUsableFreeDefault() {
        // Codex review round 2, P1: usability is about the model
        // ACTUALLY IN USE right now, so explicitness must be judged against `currentModel()` too
        // — `hasExplicitModel()`, not `hasExplicitDefault()` (which judges against the LAUNCH
        // default `fallbackModel()`, the right comparison for migration eligibility, but the
        // wrong one here). Cycling from free model A (the launch default) to free model B writes
        // `explicitDefault = B`; comparing that against A made this predicate go false right
        // after a deliberate pick, flipping `useReady()` true→false and reopening the picker (and
        // clearing the prompt) on the very next submit.
        return (
          isUsableFreeDefault(
            currentModel(),
            isModelValid,
            (candidate) => isLegacyBigPickleModel(candidate) || isFreeZenModel(candidate, sync.data.provider),
            hasExplicitModel(),
            kv.get(ALTIMATE_BASE_MIGRATION_DECLINED_KEY, false) || modelStore.declinedManagedBaseDefault,
          ) ||
          // Codex review round 2, P2: an older picker-written free recent with no explicit marker
          // (`hasOwnPickOfImplicitDefault`, judged against the LAUNCH default) is exempted from
          // the startup picker in app.tsx — folded in here too so the prompt gate (which reads
          // `useReady()`, built on this predicate) agrees, instead of catching that same user on
          // their next submit and discarding whatever they typed.
          hasOwnPickOfImplicitDefault()
        )
      }
      // altimate_change end

      // altimate_change start — PR #1302 review (CodeRabbit): shared by `parsed` below and
      // `launchDefaultDisplay` — the migration disclosure needs to resolve a display name for the
      // LAUNCH default (`fallbackModel()`), not only the current selection, via the exact same
      // provider/model lookup so the two can never drift.
      function modelDisplayName(value: ModelRef | undefined) {
        if (!value) {
          return {
            provider: "Connect a provider",
            model: "No provider selected",
            reasoning: false,
          }
        }
        const provider = sync.data.provider.find((item) => item.id === value.providerID)
        const info = provider?.models[value.modelID]
        return {
          provider: provider?.name ?? value.providerID,
          model: info?.name ?? value.modelID,
          reasoning: info?.capabilities?.reasoning ?? false,
        }
      }
      // altimate_change end

      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        // altimate_change start — PR #1302 review (CodeRabbit "Migration copy names the wrong
        // model"): the migration disclosure and `migrateLegacyDefault()` both reason about the
        // LAUNCH default, not whatever `currentModel()` happens to be (which can be a
        // session-restored model on `restoreSession`/`--continue`). Expose it, and its resolved
        // display name, directly rather than making every caller re-derive them.
        launchDefault: fallbackModel,
        launchDefaultDisplay: createMemo(() => modelDisplayName(fallbackModel())),
        // altimate_change end
        parsed: createMemo(() => {
          return modelDisplayName(currentModel())
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          // altimate_change start — PR #1302 review, cubic P2: route through `selectModel` (with
          // `explicit: true`, no `recent: true` — this shortcut cycles WITHIN `recent`, it doesn't
          // reorder it) so this deliberate keyboard pick also marks `explicitDefault`, mirroring
          // `cycleFavorite` below. Without this, an all-free-tier user who cycles onto a free Zen
          // model stays "implicit" per `hasExplicitDefault()`/`hasUsableFreeDefault()`, and the
          // first-run picker reopens on every later launch even though they chose it on purpose.
          selectModel(val, { explicit: true })
          // altimate_change end
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          // altimate_change start — a deliberate favorite-cycle pick is as explicit as `/model`;
          // route through `selectModel` so it marks `explicitDefault` too (see `hasExplicitModel`
          // above), otherwise this persists through the same fields the retired implicit default
          // used and legacy migration silently overwrites it on the next launch.
          selectModel(next, { recent: true, explicit: true })
          // altimate_change end
        },
        // altimate_change start — share the validated selection path with default migration.
        // Every caller of `set` (the `/model` dialog, the provider dialog, onboarding, and the
        // `--model` CLI flag) is a deliberate, interactive choice, so it always marks
        // `explicitDefault` — see `hasExplicitModel` for why that matters for legacy migration.
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          selectModel(model, { ...options, explicit: true })
        },
        // altimate_change end
        // altimate_change start — migrate Big Pickle defaults after managed-model consent
        usesLegacyDefault,
        hasExistingLegacySelection,
        // altimate_change — fixes #1301 (Codex review, P2): see `hasUsableFreeDefault`'s
        // declaration above
        hasUsableFreeDefault,
        // altimate_change — fixes #1301 (Codex review round 2, P1): see
        // `hasOwnPickOfImplicitDefault`'s declaration above
        hasOwnPickOfImplicitDefault,
        // altimate_change — fixes #1301 (Codex review round 2, P2/D): read-only accessor so
        // callers (and tests) can check the persisted decline state directly, rather than only
        // its downstream effects.
        declinedManagedBaseDefault() {
          return modelStore.declinedManagedBaseDefault
        },
        // altimate_change — PR #1302 review (CodeRabbit + cubic): see `pendingWrite`'s
        // declaration above. Awaiting this settles once the most recent `save()` has landed.
        persisted() {
          // altimate_change — see `pendingWrites`' declaration above. `allSettled` (not `all`)
          // so one write's rejection can't stop the caller from also waiting out the others.
          return Promise.allSettled([...pendingWrites]).then(() => undefined)
        },
        // altimate_change start — fixes #1301 (Codex review, P1): see the
        // `declinedManagedBaseDefault` field declaration above. Called from app.tsx's migration
        // `onDecline`, alongside (not instead of) the existing kv-key write.
        declineManagedBaseDefault() {
          batch(() => {
            setModelStore("declinedManagedBaseDefault", true)
            save()
          })
        },
        // altimate_change end
        // altimate_change start — PR #1302 review (Cursor "Accept can skip default rewrite",
        // medium, real): after registration, `yes()` calls `sdk.client.instance.dispose()` then
        // `sync.bootstrap()`, which can make `altimate-free/altimate-base` the FIRST live
        // provider — so a fresh `fallbackModel()`/`usesLegacyDefault()` re-check here resolves to
        // Base itself, its `isFree(fallback)` term goes false, and a real accept looks
        // ineligible: recents are never rewritten and the user is bounced to the welcome picker.
        // `options.from` lets the caller (the migration dialog's `yes()`) pass the LAUNCH default
        // it captured on mount, BEFORE registration ran. With `from` given, eligibility only
        // re-checks the parts registration cannot invalidate — still not an explicit choice,
        // still allowed by the project's provider allowlist — and skips re-deriving (and losing)
        // the free-default check against a `fallbackModel()` that has since moved. The silent
        // (already-registered) path in app.tsx keeps calling this with no `from`, unchanged.
        migrateLegacyDefault(options?: { from?: ModelRef }) {
          const from = options?.from
          // altimate_change start — Codex review round 2, P2: see `isMigrationStillEligibleAfterCapture`'s
          // declaration above for why `from` cannot just bypass eligibility entirely.
          const eligible = from
            ? isMigrationStillEligibleAfterCapture(fallbackModel(), from, hasExplicitDefault(), sync.data.config.provider)
            : usesLegacyDefault()
          if (!eligible || !isModelValid(ALTIMATE_BASE_MODEL)) return false
          // altimate_change end
          // Capture the model being migrated away from BEFORE mutating: reading it after
          // `setModelStore("model", ...)` below would see Base, not the free default being
          // dropped, so `migrateLegacyRecentModels` could never actually remove it from `recent`.
          // Use the LAUNCH default (`fallbackModel`, or the caller's captured `from` — see above),
          // the same value eligibility was judged on: `currentModel()` can be a session-restored
          // model, which must not be dropped from `recent` just because the implicit default moved.
          const previous = from ?? fallbackModel()
          batch(() => {
            const a = agent.current()
            // altimate_change start — fixes #1301 (Codex review round 2, P1): migration is a
            // decision about the DEFAULT, not about an already-open conversation. A restored
            // session (`restoreSession`, `--continue`) can be on a DIFFERENT model than the
            // implicit default this migration is about — unconditionally reassigning the active
            // agent's model overwrote that conversation with Base. `shouldMoveAgentModelDuringMigration`
            // (a pure, directly-tested predicate — see its declaration) decides whether THIS
            // conversation is still actually on the default being migrated away from. The recents
            // rewrite and decline-clear below still always happen regardless — those are about
            // the DEFAULT going forward, independent of what this one conversation is showing.
            if (a && shouldMoveAgentModelDuringMigration(currentModel(), previous))
              setModelStore("model", a.name, { ...ALTIMATE_BASE_MODEL })
            // altimate_change end
            setModelStore("recent", migrateLegacyRecentModels(modelStore.recent, previous))
            // altimate_change — fixes #1301 (Codex review round 2, P2): an explicit accept via
            // migration clears any earlier decline the same way `selectModel` does for every
            // other explicit Base selection (`/connect`, favorite-cycling) — both flags together.
            setModelStore("declinedManagedBaseDefault", false)
            kv.set(ALTIMATE_BASE_MIGRATION_DECLINED_KEY, false)
            save()
          })
          return true
        },
        // altimate_change end
        // Opening an old session restores the model that session was recorded with, verbatim.
        // Migration is a decision about the DEFAULT model and is owned by the disclosure flow in
        // app.tsx; applying it here rewrote historical threads onto the request-logging tier with
        // no per-session prompt, and did so even for users who had explicitly declined.
        restoreSession(model: ModelRef) {
          if (!selectModel(model)) return undefined
          return model
        },
        // altimate_change end
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          selected() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key]
          },
          current() {
            const v = this.selected()
            if (!v) return undefined
            if (!this.list().includes(v)) return undefined
            return v
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((item) => item.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            setModelStore("variant", key, value ?? "default")
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    }

    const model = createModel()

    function createSession() {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const filePath = path.join(paths.state, "session.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          pinned: sessionStore.pinned,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const pinned = (x as Record<string, unknown>).pinned
          if (Array.isArray(pinned))
            setSessionStore(
              "pinned",
              pinned.filter((item): item is string => typeof item === "string"),
            )
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const event = useEvent()

      const slots = createMemo(() => {
        const existing = new Set(sync.data.session.filter((x) => x.parentID === undefined).map((x) => x.id))
        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)
      })

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((x) => x !== sessionID),
            )
          }
          save()
        })
      }

      event.on("session.deleted", (evt) => {
        prune(evt.properties.info.id)
      })

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    }

    const session = createSession()

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    createEffect(() => {
      const value = agent.current()
      if (!value?.model) return
      if (isModelValid(value.model)) return
      toast.show({
        variant: "warning",
        message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
        duration: 3000,
      })
    })

    const result = {
      model,
      agent,
      mcp,
      session,
    }
    return result
  },
})
