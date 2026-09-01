// Fork-only module — owns the PRE-EXECUTION PROTOCOL SCOPING CONTRACT.
//
// The protocol below used to sit statically in `altimate/prompts/builder.txt`.
// builder is a PRIMARY agent, so a static section there governs every builder
// surface at once: dbt authoring, interactive chat, and headless
// question-answering runs. A pre-registered paired ablation (540 trials on a
// public data-question benchmark, one binary across both arms) measured what
// the section costs on the question-answering surface:
//
//   macro Pass@1  control 0.6667 → treatment 0.6807
//   delta +0.0140, query-blocked permutation p = 0.7358,
//   cluster-bootstrap 95% CI [-0.0400, +0.0674]   → no score effect
//   wall clock  440.9s → 319.4s  (-27.6%)
//   model turns -27.7%, generation time -32.2%
//   `altimate_core_validate` + `sql_analyze` calls  2,805 → 0
//   `sql_execute` calls  +49%   (the freed budget went into real querying)
//
// The 2,805 → 0 is the one number directly attributable to this text: the
// ritual is prompt-ordered, and deleting the order deletes it completely. The
// latency win is NOT attributable to this section alone — that treatment arm
// bundled five coupled changes and the experiment declined to attribute.
//
// So this module SCOPES rather than deletes. The measurement covers exactly
// one cell — headless question-answering in a workspace with no dbt project —
// and that is the only cell where the protocol is dropped. dbt work and
// interactive chat, where a pre-execution discipline may genuinely earn its
// place, are unmeasured and keep it. Anything that cannot be classified
// confidently keeps it too: the cost of keeping it is latency on one workload,
// the cost of wrongly dropping it is unmeasured.
//
// Directive text lives here (not at the call site) so any wording-change review
// covers ONE file, mirroring session/termination.ts.

import path from "path"
import { Filesystem } from "../util/filesystem"
import { findDbtProjectRoot } from "../altimate/validators/validator-utils"
import { Log } from "../util/log"

const log = Log.create({ service: "pre-execution-scope" })

/**
 * How a workspace classifies for the purpose of this gate.
 *
 * `unknown` is a real, load-bearing state, not a placeholder: it is what we
 * report when the filesystem could not answer the question, and it keeps the
 * protocol. `findDbtProjectRoot` collapses "no project here" and "could not
 * read the directory" into the same `null`, so the readability check happens
 * here, before it is consulted.
 */
export type WorkspaceShape = "dbt" | "non-dbt" | "unknown"

/**
 * The mandatory pre-execution sequence, verbatim as it shipped in
 * `builder.txt`. Prompt-visible text — changes need extra review.
 *
 * Kept byte-identical to the previous static section so that in every case
 * where the gate injects it, the resolved prompt is unchanged from before.
 */
export const PRE_EXECUTION_PROTOCOL = [
  "## Pre-Execution Protocol",
  "",
  "Before executing ANY SQL via sql_execute, follow this mandatory sequence:",
  "",
  "1. **Analyze first**: Run `sql_analyze` on the query. Check for HIGH severity anti-patterns.",
  "   - If HIGH severity issues found (SELECT *, cartesian products, missing WHERE on DELETE/UPDATE, full table scans on large tables): FIX THEM before executing. Show the user what you found and the fixed query.",
  "   - If MEDIUM severity issues found: mention them and proceed unless the user asks to fix.",
  "",
  "2. **Validate syntax**: Run `altimate_core_validate` to catch syntax errors and schema issues BEFORE hitting the warehouse.",
  "",
  "3. **Execute**: Only after steps 1-2 pass, run `sql_execute`.",
  "",
  "This sequence is NOT optional. Skipping it means the user pays for avoidable mistakes. You are the customer's cost advocate — every credit saved is trust earned. If the user explicitly requests skipping the protocol, note the risk and proceed.",
  "",
  "For trivial queries (e.g., `SELECT 1`, `SHOW TABLES`), use judgment — skip the full sequence but still validate syntax.",
].join("\n")

/**
 * Classify a workspace by the presence of a dbt project.
 *
 * `dbt` requires an actual `dbt_project.yml` file at one of the candidate
 * directories or one level below it (`findDbtProjectRoot`'s existing rule —
 * benchmark and monorepo layouts nest the project one level deep).
 *
 * `non-dbt` is only reported when at least one candidate directory was
 * readable AND no project was found in any readable candidate. If no candidate
 * could be read, the answer is `unknown`, never `non-dbt`.
 */
export async function classifyWorkspace(candidates: (string | undefined)[]): Promise<WorkspaceShape> {
  // A non-git project sets worktree to the filesystem root; scanning that is
  // never meaningful and can be slow or permission-denied.
  const dirs = [...new Set(candidates.filter((d): d is string => !!d && d !== path.parse(d).root))]
  let sawReadableDir = false
  for (const dir of dirs) {
    if (!(await Filesystem.isDir(dir))) continue
    sawReadableDir = true
    try {
      if (await findDbtProjectRoot(dir)) return "dbt"
    } catch (err) {
      // findDbtProjectRoot already swallows its own errors; this is belt and
      // braces so a future change there cannot turn a throw into a silent drop.
      log.warn("dbt project scan failed", { dir, err })
      return "unknown"
    }
  }
  return sawReadableDir ? "non-dbt" : "unknown"
}

/**
 * The sole gate for injecting the pre-execution protocol into a prompt.
 *
 * Returns the protocol text to inject, or `undefined` to drop it. The ONLY
 * dropping case is the one the ablation measured:
 *
 *   run mode (headless / CI, the `run` CLI)  AND
 *   the builder agent (the only prompt that ever carried the section)  AND
 *   a workspace confidently classified as having no dbt project.
 *
 * Everything else keeps it, including `unknown`. Note the asymmetry is
 * deliberate: run mode is not itself a task-shape signal, it is the surface the
 * evidence covers. Widening this to interactive chat needs its own measurement.
 *
 * Classification is only performed when the cheap conditions already hold, so
 * an interactive session pays no filesystem cost for this gate.
 */
export async function preExecutionInstruction(input: {
  runMode: boolean
  agent: string
  /** Candidate directories to classify — typically the cwd and the worktree root. */
  directories: (string | undefined)[]
}): Promise<string | undefined> {
  // Only builder ever carried this section; analyst and reviewer never did.
  if (input.agent !== "builder") return undefined
  if (!input.runMode) return PRE_EXECUTION_PROTOCOL
  const shape = await classifyWorkspace(input.directories)
  if (shape !== "non-dbt") return PRE_EXECUTION_PROTOCOL
  log.info("pre-execution protocol scoped out", { agent: input.agent, shape })
  return undefined
}

export * as SessionPreExecution from "./pre-execution"
