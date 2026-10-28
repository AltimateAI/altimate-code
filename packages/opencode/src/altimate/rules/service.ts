// altimate_change - new file
//
// Per instance: keep workspace rules fresh and turn a session's corrections into proposal cards.
//
// - Sync in the background at start, then every `REFRESH_MS` (approved rules reach sessions within minutes).
// - Capture corrections when learning is on for this project: the person's own setting, else the
//   workspace's "Learn from sessions" (see `learningEnabled`). Capture enabled in config starts on its own;
//   capture started here stops when learning turns off (setting changed, or the project unlinked).
// - The learn config is read on each refresh and each check, so `learn disable` takes effect without a restart.
// - After each turn (session idle), check the session's new corrections (`RuleTrigger.afterTurn`).
// - Publish review notices from a pull as `rule.proposal.reviewed`.
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
import { RuleTrigger } from "./trigger"

const log = Log.create({ service: "rules.service" })

type LearnConfig = { enabled?: boolean; capture?: boolean; model?: string } | undefined

/** The loaded config's `learn`, with the project file's `learn` as it is on disk now (`learn enable/disable`
 * and `/rules` write it while the session runs). */
async function learnConfig(ctx: InstanceContext): Promise<LearnConfig> {
  const [{ Config }, { readProjectLearning }] = await Promise.all([import("@/config/config"), import("../learn/project-config")])
  const loaded = Config.peek(ctx)?.learn as LearnConfig
  const root = ctx.worktree !== "/" ? ctx.worktree : ctx.directory
  const onDisk = (await readProjectLearning(root, ctx.directory).catch(() => undefined)) as LearnConfig
  return loaded || onDisk ? { ...loaded, ...onDisk } : undefined
}

function deps(ctx: InstanceContext, model?: string): RuleTrigger.TriggerDeps {
  return {
    source: async (sessionID) => (await import("../learn/session-reflect")).sourceFromSession(sessionID, ctx),
    generate: async (source) => {
      const [{ Provider }, { AppRuntime }, { InstanceRef }, { DEFAULT_TIMEOUT_MS, providerGenerate }, { learnModel }] = await Promise.all([
        import("@/provider/provider"),
        import("@/effect/app-runtime"),
        import("@/effect/instance-ref"),
        import("../learn/reflect"),
        import("../learn/auto"),
      ])
      const chosen = learnModel(model)
      return AppRuntime.runPromise(
        providerGenerate(chosen ? Provider.parseModel(chosen) : source.model, DEFAULT_TIMEOUT_MS).pipe(Effect.provideService(InstanceRef, ctx)),
      )
    },
  }
}

async function publishNotices(directory: string, report: RulesSync.RunReport) {
  for (const notice of report.pull?.notices ?? [])
    await Bus.publish(RuleEvents.Event.Reviewed, {
      public_id: notice.public_id,
      text: notice.text,
      status: notice.status,
      ...(notice.reason ? { reason: notice.reason } : {}),
      ...(notice.reviewer ? { reviewer: notice.reviewer } : {}),
    }).catch(() => {})
  if (report.context.status === "ready") await Bus.publish(RuleEvents.Event.Changed, { directory }).catch(() => {})
}

/** Sync now, publishing notices and a change event. Shared with routes and the TUI menu. */
export async function syncNow(root: string, directory: string, learn: Parameters<typeof RulesSync.run>[2]) {
  const report = await RulesSync.runShared(root, directory, learn)
  await publishNotices(directory, report)
  return report
}

export async function start(ctx: InstanceContext): Promise<void> {
  try {
    if (!RulesSync.rulesEnabled(await learnConfig(ctx))) return
    const root = await fs.realpath(ctx.worktree !== "/" ? ctx.worktree : ctx.directory)
    const { Instance } = await import("@/project/instance")
    let disposed = false
    // Capture this service started because the workspace turned learning on. Capture the person enabled in
    // config is started (and owned) by bootstrap.
    let stopCapture: (() => Promise<void>) | undefined
    let starting = false
    // Follow the learning setting each time: the person's config can change, and a sync can change the
    // workspace's setting or unlink the project.
    const followLearning = async (learn: LearnConfig) => {
      if (disposed || starting || captureEnabled(learn)) return
      const on = RuleTrigger.learningEnabled(learn, await RulesStore.read(root))
      if (on && !stopCapture) {
        starting = true
        try {
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
    const refresh = Instance.bind(async () => {
      if (disposed) return
      const learn = await learnConfig(ctx)
      if (!RulesSync.rulesEnabled(learn)) return void (await followLearning(learn))
      const report = await syncNow(root, ctx.directory, learn).catch((error) => {
        log.warn("rules sync failed", { error: error instanceof Error ? error.message : String(error) })
        return undefined
      })
      if (report) await followLearning(learn)
    })
    await followLearning(await learnConfig(ctx))
    void refresh()
    const timer = setInterval(() => void refresh(), RulesSync.REFRESH_MS)
    timer.unref?.()
    const onIdle = Instance.bind(async (sessionID: string) => {
      if (disposed) return
      const learn = await learnConfig(ctx)
      if (!RulesSync.rulesEnabled(learn)) return
      const { flushCapture } = await import("../learn/capture")
      await flushCapture()
      await RuleTrigger.afterTurn({ sessionID, root, directory: ctx.directory, learn, deps: deps(ctx, learn?.model) })
    })
    const stop = Bus.subscribeAll((event) => {
      if (event.type === "session.idle") void onIdle(event.properties.sessionID)
    })
    const unregister = registerDisposer(async (directory) => {
      if (directory !== ctx.directory) return
      disposed = true
      clearInterval(timer)
      stop()
      unregister()
      // The capture's own disposer stops it too; this covers a stop handle taken before disposal.
      await stopCapture?.()
      stopCapture = undefined
    })
    log.info("rules service started", { root })
  } catch (error) {
    log.warn("rules service not started", { error: error instanceof Error ? error.message : String(error) })
  }
}

export * as RulesService from "./service"
