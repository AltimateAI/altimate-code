// altimate_change - new file
//
// Auto-reflect at the end of `altimate-code run`: when the session recorded open learning signals, run the
// same reflect path in-process and report one line. Edits are only staged as the candidate; promotion
// stays explicit (`learn promote`). Never throws: learning must not change a run's outcome.
import * as Playbook from "./playbook"
import { summarize } from "./curator"
import { autoReflectEnabled, captureEnabled, flushCapture } from "./capture"
import { DEFAULT_TIMEOUT_MS, providerGenerate } from "./reflect"
import { candidatePath, errText, reflectSessionSignals } from "./session-reflect"

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

export function describeOutcome(summary: string, signals: number, candidate: string | undefined): string {
  return `learn: ${signals} signal${signals === 1 ? "" : "s"} -> ${summary}${candidate ? `; staged ${candidate}, review with \`altimate-code learn show\`` : ""}`
}

/** Runs inside the instance context (after `run`'s session has completed). Returns undefined when disabled or idle. */
export async function autoReflectSession(sessionID: string): Promise<AutoReflectOutcome | undefined> {
  try {
    const { Config } = await import("@/config/config")
    const learn = (await Config.get()).learn
    if (captureEnabled(learn)) await flushCapture()
    if (!autoReflectEnabled(learn)) return undefined
    const { Instance } = await import("@/project/instance")
    const root = Instance.worktree !== "/" ? Instance.worktree : Instance.directory
    const modelArg = learnModel(learn?.model)
    const modelLabel = modelArg ? `model ${modelArg}` : undefined
    const out = await reflectSessionSignals({
      root,
      name: Playbook.DEFAULT_NAME,
      sessionID,
      modelLabel,
      getGenerate: async (source) => {
        const { Provider } = await import("@/provider/provider")
        const { AppRuntime } = await import("@/effect/app-runtime")
        const model = modelArg ? Provider.parseModel(modelArg) : source.model
        return AppRuntime.runPromise(providerGenerate(model, DEFAULT_TIMEOUT_MS))
      },
    })
    if (out.status === "none") return undefined
    const { curated } = out.result
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
    return { ok: false, line: `learn: auto-reflect skipped (${errText(e)}); signals stay open for \`learn reflect --session ${sessionID}\`` }
  }
}
