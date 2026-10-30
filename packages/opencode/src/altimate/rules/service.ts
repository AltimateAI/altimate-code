// altimate_change - new file
//
// Per instance: keep workspace rules fresh and turn a session's corrections into proposal cards.
//
// - Sync in the background at start, then every `REFRESH_MS` (approved rules reach sessions within minutes), for a
//   project that is linked (local binding or pulled state); others pay no network call. The timer and the idle
//   hook are always registered and check the settings each time, so turning learning on later needs no restart.
// - Capture corrections when learning is on for this project: the person's own setting, else the
//   workspace's "Learn from sessions" (see `learningEnabled`). Capture enabled in config starts on its own;
//   capture started here stops when learning turns off (setting changed, or the project unlinked).
// - The learn config is read on each refresh and each check, so `learn disable` takes effect without a restart.
// - After each turn (session idle), check the session's new corrections (`RuleTrigger.afterTurn`).
// - Review notices from a pull are published as `rule.proposal.reviewed` by the sync run itself (`RulesSync`).
import fs from "node:fs/promises"
import { Effect } from "effect"
import { Bus } from "@/bus"
import { registerDisposer } from "@/effect/instance-registry"
import type { InstanceContext } from "@/project/instance-context"
import { Log } from "@/util/log"
import { captureEnabled } from "../learn/config"
import { RuleEvents } from "./events"
import { RulesStore } from "./store"
import { RulesSync } from "./sync"
import type { RulesTelemetry } from "./telemetry"
import { RuleTrigger } from "./trigger"

const log = Log.create({ service: "rules.service" })

type LearnConfig = { enabled?: boolean; capture?: boolean; model?: string; capture_policy?: boolean } | undefined

/**
 * `loaded` (the session's config, every layer already merged and expanded) with the project file's `learn` as it is on
 * disk now: `learn enable/disable` write it while the session runs. Only keys no layer above project files set
 * (`Config.learnKeysAboveProject`) are taken from the file, so a committed project setting never beats the home or
 * `OPENCODE_CONFIG_DIR` config, `OPENCODE_CONFIG_CONTENT`, the account's config, managed config or MDM. When one of those
 * sets `learn.capture`, `capture_policy` marks it: it then also beats the person's `/rules` choice. Shared by the service
 * and the routes so both decide the same way.
 */
export async function effectiveLearn(loaded: LearnConfig, root: string, directory: string): Promise<LearnConfig> {
  const [{ readProjectLearning }, { Config }] = await Promise.all([import("../learn/project-config"), import("@/config/config")])
  const onDisk = (await readProjectLearning(root, directory).catch(() => undefined)) as Record<string, unknown> | undefined
  if (!loaded && !onDisk) return undefined
  const above = Config.learnKeysAboveProject(directory)
  const result: Record<string, unknown> = { ...loaded }
  for (const [key, value] of Object.entries(onDisk ?? {})) if (!above.has(key)) result[key] = value
  // Only this function marks a policy: a key named so in any file (a committed project file above all) is not one.
  delete result.capture_policy
  if (above.has("capture")) result.capture_policy = true
  return result as LearnConfig
}

async function learnConfig(ctx: InstanceContext): Promise<LearnConfig> {
  const { Config } = await import("@/config/config")
  return effectiveLearn(Config.peek(ctx)?.learn as LearnConfig, ctx.worktree !== "/" ? ctx.worktree : ctx.directory, ctx.directory)
}

/** Whether a pull can find anything: pulled state, or a local workspace binding. No network. */
async function linked(root: string, directory: string): Promise<boolean> {
  if ((await RulesStore.read(root).catch(() => undefined))?.scope) return true
  const { readLocalBinding } = await import("../workspace/state")
  return !!(await readLocalBinding(directory).catch(() => null))
}

function triggerDeps(ctx: InstanceContext, model?: string): RuleTrigger.TriggerDeps {
  return {
    source: async (sessionID) => (await import("../learn/session-reflect")).sourceFromSession(sessionID, ctx),
    generate: async (source, onUsage) => {
      const [{ Provider }, { AppRuntime }, { InstanceRef }, { DEFAULT_TIMEOUT_MS, providerGenerate }, { learnModel }] = await Promise.all([
        import("@/provider/provider"),
        import("@/effect/app-runtime"),
        import("@/effect/instance-ref"),
        import("../learn/reflect"),
        import("../learn/auto"),
      ])
      const chosen = learnModel(model)
      return AppRuntime.runPromise(
        providerGenerate(chosen ? Provider.parseModel(chosen) : source.model, DEFAULT_TIMEOUT_MS, undefined, onUsage).pipe(Effect.provideService(InstanceRef, ctx)),
      )
    },
  }
}

/** Sync now, or join the sync already running. Its notices and change event are published by the run itself, once.
 * Shared with routes and the TUI menu. */
export async function syncNow(root: string, directory: string, learn: Parameters<typeof RulesSync.run>[2], trigger: RulesTelemetry.SyncTrigger = "refresh") {
  return RulesSync.runShared(root, directory, learn, trigger)
}

/**
 * The bounded pull before a session's first turn, so it sees rules approved since the last refresh, with the
 * notices it brings published. The session loop calls it once per session; later prompts rely on the timer.
 */
export async function sessionStart(root: string, directory: string, loaded: LearnConfig): Promise<void> {
  const learn = await effectiveLearn(loaded, root, directory)
  if (!RulesSync.rulesEnabled(learn) || !(await linked(root, directory))) return
  // A project with no rules state yet only waits for the service's first pull if it is running: starting one here
  // would add up to `SESSION_WAIT_MS` to the first prompt of every session in a project without rules.
  const hasState = !!(await RulesStore.read(root).catch(() => undefined))?.scope
  await RulesSync.sessionStart(root, directory, learn, { startIfDue: hasState })
}

export async function start(ctx: InstanceContext): Promise<void> {
  try {
    const root = await fs.realpath(ctx.worktree !== "/" ? ctx.worktree : ctx.directory)
    const { Instance } = await import("@/project/instance")
    let disposed = false
    // Capture this service started because the workspace turned learning on. Capture the person enabled in
    // config is started (and owned) by bootstrap.
    let stopCapture: (() => Promise<void>) | undefined
    let starting = false
    // Follow the learning setting each time: the person's config can change, and a sync can change the
    // workspace's setting or unlink the project.
    // While capture runs (whoever started it), every correction is checked against the whole learning decision, so
    // "off for me" stops recording even with learn.capture on. Set only once capture runs: a project with learning off
    // never loads the capture module.
    let gated = false
    const gate = async () => {
      if (gated) return
      gated = true
      const { setCaptureGate } = await import("../learn/capture")
      setCaptureGate(ctx.directory, async () => RuleTrigger.learningEnabled(await learnConfig(ctx), await RulesStore.read(root)))
    }
    const followLearning = async (learn: LearnConfig) => {
      if (disposed || starting) return
      // Capture enabled in config is bootstrap's when it was on at startup; turned on later (`learn enable`, a project
      // file edit) nothing runs it, so it is started here, like capture the workspace turned on. Never a second capture
      // beside one already running; with learning off, a capture this service did not start is left to the gate.
      const on = captureEnabled(learn) || RuleTrigger.learningEnabled(learn, await RulesStore.read(root))
      const running = on && (await import("../learn/capture")).captureRunning(ctx.directory)
      if (on && (stopCapture || running)) return void (await gate())
      if (on) {
        starting = true
        try {
          await gate()
          const stop = await import("../learn/capture").then((m) => m.startCapture(ctx, { force: true }))
          if (disposed) await stop?.()
          else stopCapture = stop
        } finally {
          starting = false
        }
      } else if (!on && stopCapture) {
        const stop = stopCapture
        stopCapture = undefined
        await stop()
      }
    }
    // "Remember" requests no card will settle: another process's that died, or this one's whose save failed.
    const recover = Instance.bind(async () => {
      if (disposed) return
      // Cards past their day close first (their fallback saves them), then the leftovers are recovered.
      const [{ RulesRemember }, { RuleProposal }] = await Promise.all([import("./remember"), import("./proposal")])
      RuleProposal.list(ctx.directory)
      await RulesRemember.recoverRequests(root, ctx.directory)
    })
    const refresh = Instance.bind(async () => {
      if (disposed) return
      await recover().catch((error) => log.warn("rules remember recovery failed", { error: error instanceof Error ? error.message : String(error) }))
      const learn = await learnConfig(ctx)
      if (!RulesSync.rulesEnabled(learn) || !(await linked(root, ctx.directory))) return void (await followLearning(learn))
      const report = await syncNow(root, ctx.directory, learn).catch((error) => {
        log.warn("rules sync failed", { error: error instanceof Error ? error.message : String(error) })
        return undefined
      })
      if (report) await followLearning(learn)
    })
    // Background callbacks never reject unhandled: an unreadable rules state or config is logged, and the next tick tries
    // again.
    const safely = (what: string, work: () => Promise<unknown>) => () =>
      void work().catch((error) => log.warn(`rules ${what} failed`, { error: error instanceof Error ? error.message : String(error) }))
    await followLearning(await learnConfig(ctx)).catch((error) => log.warn("rules learning setup failed", { error: String(error) }))
    safely("refresh", refresh)()
    const timer = setInterval(safely("refresh", refresh), RulesSync.REFRESH_MS)
    timer.unref?.()
    const onIdle = Instance.bind(async (sessionID: string) => {
      if (disposed) return
      const learn = await learnConfig(ctx)
      if (!RulesSync.rulesEnabled(learn)) return
      // A subagent's session is not one a client shows: a card raised there would never be seen, and its corrections
      // would be marked handled. They are left unprocessed.
      if (await import("./remember").then((m) => m.RulesRemember.subagentSession(sessionID))) return
      const { flushCapture } = await import("../learn/capture")
      await flushCapture()
      await RuleTrigger.afterTurn({ sessionID, root, directory: ctx.directory, learn, deps: triggerDeps(ctx, learn?.model) })
    })
    // A settings change (`/rules` learning on/off) starts or stops capture now, not at the next refresh.
    const onChanged = Instance.bind(async () => {
      if (!disposed) await followLearning(await learnConfig(ctx))
    })
    const stop = Bus.subscribeAll((event) => {
      if (event.type === "session.idle") safely("after-turn check", () => onIdle(event.properties.sessionID))()
      if (event.type === RuleEvents.Event.Changed.type && (event.properties as { directory?: string }).directory === ctx.directory)
        safely("learning update", onChanged)()
    })
    const unregister = registerDisposer(async (directory) => {
      if (directory !== ctx.directory) return
      disposed = true
      clearInterval(timer)
      stop()
      unregister()
      // Cards nobody answered go with the instance: they cannot be answered after it.
      const { RuleProposal } = await import("./proposal")
      await RuleProposal.drop(ctx.directory)
      // The capture's own disposer stops it too; this covers a stop handle taken before disposal. The gate goes last:
      // signals the stop flushes are still checked against the learning decision.
      await stopCapture?.()
      stopCapture = undefined
      if (gated) (await import("../learn/capture")).setCaptureGate(ctx.directory, undefined)
    })
    log.info("rules service started", { root })
  } catch (error) {
    log.warn("rules service not started", { error: error instanceof Error ? error.message : String(error) })
  }
}

export * as RulesService from "./service"
