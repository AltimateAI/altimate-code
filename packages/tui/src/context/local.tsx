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

// altimate_change start — remove Big Pickle from migrated recents without touching other models
export function migrateLegacyRecentModels(recent: readonly unknown[]) {
  return recentModels(
    ALTIMATE_BASE_MODEL,
    recent.filter((model): model is ModelRef => isModelRef(model) && !isLegacyBigPickleModel(model)),
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
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
        // altimate_change start — see the `explicitDefault` field declaration above
        explicitDefault: undefined,
        // altimate_change end
      })

      const filePath = path.join(paths.state, "model.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          recent: modelStore.recent,
          favorite: modelStore.favorite,
          variant: modelStore.variant,
          // altimate_change start — persist the last explicitly-picked model across launches
          explicitDefault: modelStore.explicitDefault,
          // altimate_change end
        })
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

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider[0]
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
          if (options?.recent || options?.explicit) save()
          selected = true
        })
        return selected
      }

      function usesLegacyDefault() {
        return shouldMigrateLegacyDefault(
          currentModel(),
          modelStore.recent,
          hasExplicitModel(),
          sync.data.config.provider,
        )
      }

      function hasExistingLegacySelection() {
        return isExistingBigPickleSelection(currentModel(), modelStore.recent, hasExplicitLegacyModel())
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
        parsed: createMemo(() => {
          const value = currentModel()
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
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...val })
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
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...next })
          setModelStore("recent", recentModels(next, modelStore.recent))
          save()
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
        migrateLegacyDefault() {
          if (!usesLegacyDefault() || !isModelValid(ALTIMATE_BASE_MODEL)) return false
          batch(() => {
            const a = agent.current()
            if (a) setModelStore("model", a.name, { ...ALTIMATE_BASE_MODEL })
            setModelStore("recent", migrateLegacyRecentModels(modelStore.recent))
            save()
          })
          return true
        },
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
