// altimate_change - new file
//
// Auto-reflect from the scheduler or the end of `altimate-code run`: open learning signals use the
// same claimed reflect path in-process and report one line. Edits are only staged as the candidate; promotion
// stays explicit (`learn promote`). Never throws: learning must not change a run's outcome.
import * as Playbook from "./playbook"
import { DEFAULT_MAX_STORED, summarize } from "./curator"
import { autoReflectEnabled, captureEnabled, flushCapture } from "./capture"
import { DEFAULT_TIMEOUT_MS, providerGenerate } from "./reflect"
import { candidatePath, errText, reflectSessionSignals, sourceFromSession } from "./session-reflect"
import { readScheduleState, recordReflection } from "./schedule-state"
import type { InstanceContext } from "@/project/instance-context"
import type { ReflectionOptions } from "./schedule"
import { Effect } from "effect"
import { InstanceRef } from "@/effect/instance-ref"

export interface AutoReflectOutcome {
  /** One line for the user. */
  line: string
  ok: boolean
  summary?: string
  signals?: number
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

export function describeOutcome(summary: string, signals: number, candidate: string | undefined): string {
  return `learn: ${signals} signal${signals === 1 ? "" : "s"} -> ${summary}${candidate ? `; staged ${candidate}, review with \`altimate-code learn show\`` : ""}`
}

/** Runs inside the instance context (after `run`'s session has completed). Returns undefined when disabled or idle. */
export async function autoReflectSession(
  sessionID: string,
  options: Partial<ReflectionOptions> & { context?: InstanceContext; waitForScheduled?: boolean } = {},
): Promise<AutoReflectOutcome | undefined> {
  let root: string | undefined
  const ready = () => (options.shouldContinue?.() ?? true) && (options.deadline === undefined || Date.now() < options.deadline)
  try {
    const { Config } = await import("@/config/config")
    const learn = options.context ? Config.peek(options.context)?.learn : (await Config.get()).learn
    if (captureEnabled(learn)) await flushCapture()
    if (!autoReflectEnabled(learn) || !ready()) return undefined
    const { Instance } = await import("@/project/instance")
    const context = options.context ?? Instance.current
    root = context.worktree !== "/" ? context.worktree : context.directory
    // `run` may reach its end while an idle-triggered reflection owns the batch. Finish that
    // background work before instance disposal invalidates it, and retain its one-line report.
    const scheduled = options.waitForScheduled
      ? await import("./schedule").then((m) => m.drainScheduledReflections(root!, sessionID))
      : undefined
    if (((await readScheduleState(root)).recoveries[sessionID]?.retryAt ?? 0) > Date.now()) return scheduled
    const modelArg = learnModel(learn?.model)
    const modelLabel = modelArg ? `model ${modelArg}` : undefined
    const out = await reflectSessionSignals({
      root,
      name: Playbook.DEFAULT_NAME,
      sessionID,
      signalIDs: options.signalIDs,
      shouldContinue: ready,
      loadSource: (id) => sourceFromSession(id, context),
      maxStored: learnMaxStored(learn?.max_stored),
      modelLabel,
      getGenerate: async (source) => {
        const { Provider } = await import("@/provider/provider")
        const { AppRuntime } = await import("@/effect/app-runtime")
        const model = modelArg ? Provider.parseModel(modelArg) : source.model
        const abortSignal = options.deadline === undefined ? undefined : AbortSignal.timeout(Math.max(1, options.deadline - Date.now()))
        return AppRuntime.runPromise(providerGenerate(model, DEFAULT_TIMEOUT_MS, abortSignal).pipe(Effect.provideService(InstanceRef, context)))
      },
    })
    if (out.status === "none") return scheduled
    const { curated } = out.result
    await recordReflection(root, sessionID, "success", summarize(curated))
    return {
      ok: true,
      summary: summarize(curated),
      signals: out.signals.length,
      line: describeOutcome(
        summarize(curated),
        out.signals.length,
        curated.applied.length > 0 ? candidatePath(root, Playbook.DEFAULT_NAME) : undefined,
      ),
    }
  } catch (e) {
    if (root) await recordReflection(root, sessionID, "failure", errText(e)).catch(() => {})
    return { ok: false, line: `learn: auto-reflect skipped (${errText(e)}); signals stay open for \`learn reflect --session ${sessionID}\`` }
  }
}
