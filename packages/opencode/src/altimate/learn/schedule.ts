// altimate_change - new file
import fs from "node:fs/promises"
import { Log } from "@/util/log"
import { registerDisposer } from "@/effect/instance-registry"
import type { InstanceContext } from "@/project/instance-context"
import { autoReflectEnabled, flushCapture } from "./capture"
import { autoReflectSession, type AutoReflectOutcome } from "./auto"
import { listSignals, pendingSessions, type Signal } from "./signals"
import { readScheduleState, resolveRecoveryLimits, type RecoveryLimits, type ScheduleState } from "./schedule-state"

const log = Log.create({ service: "learn.schedule" })
export const SIGNAL_THRESHOLD = 3
export const IDLE_DEBOUNCE_MS = 10 * 60_000

export interface ReflectionOptions {
  signalIDs?: readonly string[]
  shouldContinue: () => boolean
  deadline?: number
  abortSignal?: AbortSignal
}

type Timer = { unref: () => unknown }
interface Dependencies {
  startupSignals: Signal[]
  limits: RecoveryLimits
  listSignals: () => Promise<Signal[]>
  flushCapture: () => Promise<void>
  reflect: (sessionID: string, options: ReflectionOptions) => Promise<unknown>
  readState: () => Promise<Pick<ScheduleState, "recoveries">>
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => Timer
  clearTimer?: (timer: Timer) => void
  claimRecovery?: () => boolean
}

/** Event handlers only enqueue work; neither the bus nor the turn waits on reflection. */
export class Scheduler {
  private stopped = false
  private recoveryStarted = false
  private finishing = new Set<string>()
  private running?: { sessionID: string; abort: AbortController; promise: Promise<unknown> }
  private active = new Set<string>()
  private epochs = new Map<string, number>()
  private timers = new Map<string, Timer>()
  private queue = Promise.resolve()
  private now: () => number
  private setTimer: NonNullable<Dependencies["setTimer"]>
  private clearTimer: NonNullable<Dependencies["clearTimer"]>

  constructor(private deps: Dependencies) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  private cancelTimer(sessionID: string) {
    const timer = this.timers.get(sessionID)
    if (timer) this.clearTimer(timer)
    this.timers.delete(sessionID)
  }

  onActivity(sessionID: string): void {
    this.finishing.delete(sessionID)
    this.active.add(sessionID)
    this.epochs.set(sessionID, (this.epochs.get(sessionID) ?? 0) + 1)
    this.cancelTimer(sessionID)
  }

  private enqueue(task: () => Promise<void>) {
    this.queue = this.queue.then(async () => {
      if (!this.stopped) await task()
    }).catch((error) => {
      log.warn("background reflection deferred", { error: error instanceof Error ? error.message : String(error) })
    })
  }

  onIdle(sessionID: string): void {
    if (this.stopped || this.finishing.has(sessionID)) return
    this.active.add(sessionID)
    this.cancelTimer(sessionID)
    const epoch = (this.epochs.get(sessionID) ?? 0) + 1
    this.epochs.set(sessionID, epoch)
    const idleAt = this.now()
    const ready = () => !this.stopped && this.epochs.get(sessionID) === epoch
    const recovery = !this.recoveryStarted && (this.deps.claimRecovery?.() ?? true)
    this.recoveryStarted = true
    this.enqueue(async () => {
      await this.deps.flushCapture()
      if (!ready() || this.finishing.has(sessionID)) return
      const signals = (await this.deps.listSignals()).filter((signal) => signal.sessionID === sessionID)
      if (!ready() || this.finishing.has(sessionID)) return
      if (signals.length) {
        const timer = this.setTimer(() => {
          this.timers.delete(sessionID)
          this.enqueue(async () => {
            if (ready()) await this.attempt(sessionID, { shouldContinue: ready })
          })
        }, Math.max(0, idleAt + IDLE_DEBOUNCE_MS - this.now()))
        timer.unref()
        this.timers.set(sessionID, timer)
      }
      if (signals.length >= SIGNAL_THRESHOLD) await this.attempt(sessionID, { shouldContinue: ready })
    })
    if (recovery) this.enqueue(() => this.recover(idleAt))
  }

  private async attempt(sessionID: string, options: ReflectionOptions) {
    if (this.finishing.has(sessionID) || !options.shouldContinue()) return
    const state = await this.deps.readState()
    if (!options.shouldContinue() || (state.recoveries[sessionID]?.retryAt ?? 0) > this.now()) return
    const open = await this.deps.listSignals()
    if (this.finishing.has(sessionID) || !options.shouldContinue() || !open.some((signal) => signal.sessionID === sessionID)) return
    await this.runReflection(sessionID, options)
  }

  private async runReflection(sessionID: string, options: ReflectionOptions) {
    const abort = new AbortController()
    const running = {
      sessionID,
      abort,
      promise: this.deps.reflect(sessionID, {
        ...options,
        abortSignal: abort.signal,
        shouldContinue: () => !abort.signal.aborted && options.shouldContinue(),
      }),
    }
    this.running = running
    try {
      await running.promise
    } finally {
      if (this.running === running) this.running = undefined
    }
  }

  /** Run exit takes over this session, without draining queued startup recovery. */
  async drainSession(sessionID: string, abortSignal?: AbortSignal): Promise<void> {
    this.finishing.add(sessionID)
    this.cancelTimer(sessionID)
    const running = this.running
    if (!running || running.sessionID !== sessionID) return
    const abort = () => running.abort.abort()
    abortSignal?.addEventListener("abort", abort, { once: true })
    if (abortSignal?.aborted) abort()
    try {
      await running.promise
    } finally {
      abortSignal?.removeEventListener("abort", abort)
    }
  }

  private async recover(idleAt: number) {
    const deadline = idleAt + this.deps.limits.recovery_max_seconds * 1000
    let attempts = 0
    for (const sessionID of pendingSessions(this.deps.startupSignals)) {
      if (this.stopped || this.now() >= deadline || attempts >= this.deps.limits.recovery_max_reflections) break
      if (this.active.has(sessionID) || this.finishing.has(sessionID)) continue
      const state = await this.deps.readState()
      if ((state.recoveries[sessionID]?.retryAt ?? 0) > this.now()) continue
      const open = new Set((await this.deps.listSignals()).map((signal) => signal.id))
      const signalIDs = this.deps.startupSignals.filter((signal) => signal.sessionID === sessionID && open.has(signal.id)).map((signal) => signal.id)
      if (!signalIDs.length) continue
      const shouldContinue = () => !this.stopped && !this.active.has(sessionID) && this.now() < deadline
      if (!shouldContinue()) continue
      attempts++
      // A failed session must not prevent another eligible recovery within the process budget.
      await this.runReflection(sessionID, { signalIDs, shouldContinue, deadline }).catch((error) => {
        log.warn("startup reflection deferred", { error: error instanceof Error ? error.message : String(error) })
      })
    }
  }

  /** Test/diagnostic barrier, deliberately never used for shutdown. */
  async settle(): Promise<void> {
    let pending: Promise<void>
    do {
      pending = this.queue
      await pending
    } while (pending !== this.queue)
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.running?.abort.abort()
    for (const sessionID of this.timers.keys()) this.cancelTimer(sessionID)
    await this.deps.flushCapture()
  }
}

// Multiple instances of one project share the queue and the process's single recovery budget.
const projects = new Map<string, {
  scheduler: Scheduler
  contexts: Set<InstanceContext>
  outcomes: Map<string, AutoReflectOutcome>
  shutdown: () => void
}>()
const recovered = new Set<string>()

/** Only `run`'s normal completion waits here. Disposal and graceful exit never wait on a model. */
export async function drainScheduledReflections(root: string, sessionID: string, abortSignal?: AbortSignal): Promise<AutoReflectOutcome | undefined> {
  const project = projects.get(await fs.realpath(root))
  if (!project) return
  await project.scheduler.drainSession(sessionID, abortSignal)
  const outcome = project.outcomes.get(sessionID)
  project.outcomes.delete(sessionID)
  return outcome
}

/** Signal handlers stop all queues before draining capture; they never await model work. */
export async function shutdownScheduledReflections(): Promise<void> {
  await Promise.all([...projects.values()].map(({ scheduler }) => scheduler.shutdown()))
  await flushCapture()
}

/** Called only behind the bootstrap's opt-in import gate, after capture is subscribed. */
export async function startScheduler(ctx: InstanceContext): Promise<void> {
  try {
    const { Config } = await import("@/config/config")
    const learn = Config.peek(ctx)?.learn
    if (!autoReflectEnabled(learn)) return
    const root = await fs.realpath(ctx.worktree !== "/" ? ctx.worktree : ctx.directory)
    const { Bus } = await import("@/bus")
    let project = projects.get(root)
    if (!project) {
      const contexts = new Set<InstanceContext>()
      const outcomes = new Map<string, AutoReflectOutcome>()
      const scheduler = new Scheduler({
        startupSignals: await listSignals(root),
        limits: resolveRecoveryLimits(learn),
        listSignals: () => listSignals(root),
        flushCapture,
        readState: () => readScheduleState(root),
        claimRecovery: () => {
          if (recovered.has(root)) return false
          recovered.add(root)
          return true
        },
        reflect: async (sessionID, options) => {
          const outcome = await autoReflectSession(sessionID, { ...options, context: contexts.values().next().value })
          if (outcome) outcomes.set(sessionID, outcome)
          return outcome
        },
      })
      // Bootstrap can race across two directories in the same project.
      project = projects.get(root)
      if (!project) {
        const shutdown = () => { void scheduler.shutdown().catch(() => {}) }
        project = { scheduler, contexts, outcomes, shutdown }
        projects.set(root, project)
        process.once("beforeExit", shutdown)
      }
    }
    project.contexts.add(ctx)
    const { scheduler, contexts, shutdown } = project
    const stop = Bus.subscribeAll((event) => {
      if (event.type === "session.idle") scheduler.onIdle(event.properties.sessionID)
      else if (event.type === "session.status" && event.properties.status.type !== "idle")
        scheduler.onActivity(event.properties.sessionID)
      else if (event.type === "message.updated" && event.properties.info.role === "user")
        scheduler.onActivity(event.properties.info.sessionID)
    })
    const unregister = registerDisposer(async (directory) => {
      if (directory !== ctx.directory) return
      stop()
      contexts.delete(ctx)
      if (!contexts.size) {
        projects.delete(root)
        process.removeListener("beforeExit", shutdown)
        await scheduler.shutdown()
      }
      unregister()
    })
    log.info("learn scheduler started", { root })
  } catch (error) {
    log.warn("learn scheduler not started", { error: error instanceof Error ? error.message : String(error) })
  }
}
