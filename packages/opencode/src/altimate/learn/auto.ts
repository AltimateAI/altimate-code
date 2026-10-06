// altimate_change - new file
//
// Auto-reflect from the scheduler or the end of `altimate-code run`: open learning signals use the
// same claimed reflect path in-process and report one line. Edits are staged as the candidate; promotion
// stays explicit (`learn promote`) unless `learn.auto_promote` is on and every gate passes (auto-promote.ts).
// Never throws: learning must not change a run's outcome.
import * as Playbook from "./playbook"
import { DEFAULT_MAX_STORED, summarize } from "./curator"
import { autoReflectEnabled, captureEnabled, flushCapture } from "./capture"
import { autoPromoteEnabled, resolveAutoPromoteLimits } from "./config"
import { autoPromote, type AutoPromoteResult } from "./auto-promote"
import { DEFAULT_TIMEOUT_MS, providerGenerate } from "./reflect"
import { candidatePath, errText, reflectSessionSignals, sourceFromSession } from "./session-reflect"
import { readScheduleState, recordReflection } from "./schedule-state"
import type { InstanceContext } from "@/project/instance-context"
import type { ReflectionOptions } from "./schedule"
import { Effect } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { createUsageTracker, type UsageSummary } from "./usage"
import { redactSecrets } from "./digest"
import { Log } from "@/util/log"

const log = Log.create({ service: "learn.auto" })
export const RUN_EXIT_TIMEOUT_MS = 60_000

export interface AutoReflectOutcome {
  /** One line for the user. */
  line: string
  ok: boolean
  summary?: string
  signals?: number
  usage?: UsageSummary
  /** Set when automatic promotion was attempted for the staged candidate. */
  promotion?: AutoPromoteResult
}

/** `learn.model` (config), overridden by ALTIMATE_LEARN_MODEL; otherwise use the source session's model. */
export function learnModel(cfgModel: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["ALTIMATE_LEARN_MODEL"]?.trim() || cfgModel?.trim() || undefined
}

/** The local lesson cap is enforced during curation; pinned lessons are never evicted. */
export function learnMaxStored(configured?: number, env: NodeJS.ProcessEnv = process.env): number {
  const override = env["ALTIMATE_LEARN_MAX_STORED"]?.trim()
  const value = override ? Number(override) : (configured ?? DEFAULT_MAX_STORED)
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("learn.max_stored / ALTIMATE_LEARN_MAX_STORED must be a positive integer.")
  return value
}

export function describeOutcome(
  summary: string,
  signals: number,
  candidate: string | undefined,
  promotion?: AutoPromoteResult,
): string {
  const head = `learn: ${signals} signal${signals === 1 ? "" : "s"} -> ${summary}`
  if (promotion?.status === "promoted")
    return `${head}; auto-promoted${promotion.archived ? ` (previous lessons archived as v${promotion.archived})` : ""}. Undo with \`altimate-code learn rollback\`` +
      (promotion.warning ? ` (warning: ${promotion.warning})` : "")
  if (!candidate) return head
  if (promotion?.status === "held")
    return `${head}; staged ${candidate} for review (not auto-promoted: ${promotion.reason}), review with \`altimate-code learn show\``
  return `${head}; staged ${candidate}, review with \`altimate-code learn show\``
}

/** Runs inside the instance context (after `run`'s session has completed). Returns undefined when disabled or idle. */
export async function autoReflectSession(
  sessionID: string,
  options: Partial<ReflectionOptions> & { context?: InstanceContext; waitForScheduled?: boolean } = {},
): Promise<AutoReflectOutcome | undefined> {
  if (!options.waitForScheduled) return runReflection(sessionID, options)
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + RUN_EXIT_TIMEOUT_MS)
  const abort = new AbortController()
  const abortSignal = options.abortSignal ? AbortSignal.any([options.abortSignal, abort.signal]) : abort.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<AutoReflectOutcome>((resolve) => {
    timer = setTimeout(() => {
      abort.abort()
      // Publication may already be completing; the deadline cannot promise signals remain open.
      const line = "learn: auto-reflect deadline reached; check learn status before retrying"
      log.warn(line, { sessionID })
      resolve({ ok: false, line })
    }, Math.max(0, deadline - Date.now()))
  })
  try {
    return await Promise.race([
      runReflection(sessionID, { ...options, deadline, abortSignal, recoverPending: false }),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function runReflection(
  sessionID: string,
  options: Partial<ReflectionOptions> & { context?: InstanceContext; waitForScheduled?: boolean; recoverPending?: boolean },
): Promise<AutoReflectOutcome | undefined> {
  let root: string | undefined
  const tracker = createUsageTracker()
  const ready = () => !options.abortSignal?.aborted && (options.shouldContinue?.() ?? true) &&
    (options.deadline === undefined || Date.now() < options.deadline)
  try {
    const { Config } = await import("@/config/config")
    const learn = options.context ? Config.peek(options.context)?.learn : (await Config.get()).learn
    if (captureEnabled(learn)) await flushCapture()
    if (!autoReflectEnabled(learn) || !ready()) return undefined
    const { Instance } = await import("@/project/instance")
    const context = options.context ?? Instance.current
    root = context.worktree !== "/" ? context.worktree : context.directory
    // `run` may reach its end while an idle-triggered reflection owns the batch. Finish that
    // session's work before disposal invalidates it. Startup recovery is not part of this wait.
    const scheduled = options.waitForScheduled
      ? await import("./schedule").then((m) => m.drainScheduledReflections(root!, sessionID, options.abortSignal))
      : undefined
    if (!ready()) return scheduled
    if (((await readScheduleState(root)).recoveries[sessionID]?.retryAt ?? 0) > Date.now()) return scheduled
    const modelArg = learnModel(learn?.model)
    const modelLabel = modelArg ? `model ${modelArg}` : undefined
    const out = await reflectSessionSignals({
      root,
      name: Playbook.DEFAULT_NAME,
      sessionID,
      signalIDs: options.signalIDs,
      shouldContinue: ready,
      recoverPending: options.recoverPending,
      loadSource: (id) => sourceFromSession(id, context),
      maxStored: learnMaxStored(learn?.max_stored),
      modelLabel,
      getGenerate: async (source) => {
        const { Provider } = await import("@/provider/provider")
        const { AppRuntime } = await import("@/effect/app-runtime")
        const model = modelArg ? Provider.parseModel(modelArg) : source.model
        const deadlineSignal = options.deadline === undefined ? undefined : AbortSignal.timeout(Math.max(1, options.deadline - Date.now()))
        const abortSignal = options.abortSignal && deadlineSignal
          ? AbortSignal.any([options.abortSignal, deadlineSignal])
          : options.abortSignal ?? deadlineSignal
        return AppRuntime.runPromise(providerGenerate(model, DEFAULT_TIMEOUT_MS, abortSignal, tracker.add).pipe(Effect.provideService(InstanceRef, context)))
      },
    })
    if (out.status === "none") return scheduled
    const { curated } = out.result
    // Candidate/history and signal consumption have committed; status must not change that outcome.
    await recordReflection(root, sessionID, "success", summarize(curated), undefined, undefined, out.result.usage)
      .catch((e) => log.warn("auto-reflect status update failed", { error: redactSecrets(errText(e)) }))
    // Only the candidate this reflection staged is eligible; promotion never throws.
    let promotion: AutoPromoteResult | undefined
    if (out.result.candidateHash !== undefined && autoPromoteEnabled(learn)) {
      // A fired deadline or abort (checked again under the learn lock) leaves the candidate staged.
      try {
        promotion = await autoPromote({
          root,
          name: Playbook.DEFAULT_NAME,
          expectedCandidateHash: out.result.candidateHash,
          signals: out.signals.length,
          signalKinds: out.signals.map((signal) => signal.kind),
          session: sessionID,
          flaggedFeedback: out.result.flagged,
          previousCandidate: out.result.previousCandidate,
          limits: resolveAutoPromoteLimits(learn),
          shouldContinue: ready,
          deadline: options.deadline,
        })
      } catch (e) {
        promotion = { status: "held", reason: redactSecrets(errText(e)) }
      }
    }
    const line = describeOutcome(
      summarize(curated),
      out.signals.length,
      curated.applied.length > 0 ? candidatePath(root, Playbook.DEFAULT_NAME) : undefined,
      promotion,
    )
    if (promotion) log.info(line, { sessionID })
    return {
      ok: true,
      summary: summarize(curated),
      signals: out.signals.length,
      usage: out.result.usage,
      line,
      ...(promotion ? { promotion } : {}),
    }
  } catch (e) {
    if (options.abortSignal?.aborted) return undefined
    const error = redactSecrets(errText(e))
    log.warn("auto-reflect skipped", { error })
    if (root) await recordReflection(root, sessionID, "failure", error, undefined, undefined, tracker.usage).catch(() => {})
    return { ok: false, line: `learn: auto-reflect skipped (${error}); signals stay open for \`learn reflect --session ${sessionID}\`` }
  }
}
