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

import fs from "fs/promises"
import path from "path"
import { Log } from "../util/log"

const log = Log.create({ service: "pre-execution-scope" })

/** Files that mark a directory as a dbt project root. */
const PROJECT_FILES = ["dbt_project.yml", "dbt_project.yaml"] as const

/**
 * Subdirectories never considered candidates for a nested dbt project, mirroring
 * `findDbtProjectRoot`'s skip list so a fixture project shipped inside
 * `node_modules/foo/` or a compiled artifact in `target/` is not mistaken for
 * the user's real project.
 */
const SKIP_DIRS = new Set(["node_modules", "target"])

/**
 * How far up from a candidate directory to look for a project root. A session
 * is routinely started inside `models/` or `models/marts/` of a dbt project,
 * and on a non-git project the worktree is the same directory (or the
 * filesystem root), so the ancestor walk is the only thing that finds it.
 */
const MAX_ANCESTOR_LEVELS = 8

/**
 * The `errno` code of a filesystem rejection, when it carries one.
 *
 * `ENOENT` and `ENOTDIR` are real answers — nothing is there. Every other code,
 * and an error carrying no code at all, means the question went unanswered.
 */
function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined
  const code = err.code
  return typeof code === "string" ? code : undefined
}

/** True when a rejection means "nothing is there", rather than "could not tell". */
function meansAbsent(err: unknown): boolean {
  const code = errnoCode(err)
  return code === "ENOENT" || code === "ENOTDIR"
}

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
 * Does `dir` itself contain a dbt project file?
 *
 * Returns `undefined` — not `false` — when the filesystem could not answer.
 * ENOENT and ENOTDIR are real answers ("nothing there"); anything else (EACCES,
 * EIO, a transient network mount failure) is not, and must not be read as
 * "no dbt project here".
 */
async function hasProjectFile(dir: string): Promise<boolean | undefined> {
  let sawUnknown = false
  for (const name of PROJECT_FILES) {
    try {
      if ((await fs.stat(path.join(dir, name))).isFile()) return true
    } catch (err) {
      if (meansAbsent(err)) continue
      log.warn("project-file probe failed", { dir, name, code: errnoCode(err) })
      sawUnknown = true
    }
  }
  return sawUnknown ? undefined : false
}

/**
 * Classify a workspace by the presence of a dbt project.
 *
 * `dbt` requires an actual `dbt_project.yml` (or `.yaml`) FILE at, above, or
 * one level below a candidate directory:
 *
 *   - **at** the candidate,
 *   - **above** it, walking up to `MAX_ANCESTOR_LEVELS` parents — a session
 *     started inside `models/` is still a dbt session, and on a non-git project
 *     the worktree candidate does not rescue that case,
 *   - **one level below** it, which is how benchmark and monorepo layouts nest
 *     a project (the same rule, and the same skip list, as
 *     `findDbtProjectRoot`).
 *
 * `non-dbt` requires at least one candidate the scan could examine COMPLETELY —
 * every ancestor probe answered, and the candidate's own children enumerated —
 * with no project found anywhere. Everything else is `unknown`: a candidate
 * that cannot be enumerated, a stat failing for any reason other than "not
 * there", the filesystem root (whose children are deliberately not scanned),
 * and an empty candidate list. The caller reads `unknown` as "keep the
 * protocol", so folding a filesystem failure into "no dbt project" would drop
 * it silently on a workspace nothing ever managed to look inside.
 */
export async function classifyWorkspace(candidates: (string | undefined)[]): Promise<WorkspaceShape> {
  const dirs = [...new Set(candidates.filter((d): d is string => !!d))]
  let sawCompleteAnswer = false
  let sawIncomplete = false

  for (const dir of dirs) {
    let complete = true

    // At the candidate, then upwards.
    let current = path.resolve(dir)
    for (let level = 0; level <= MAX_ANCESTOR_LEVELS; level++) {
      const found = await hasProjectFile(current)
      if (found === true) return "dbt"
      if (found === undefined) complete = false
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }

    // One level below. The filesystem root is a legitimate stop rather than a
    // directory to enumerate — a non-git project sets worktree to it, and
    // scanning its children is meaningless and can be slow or permission-denied
    // — so the root on its own never yields a complete answer.
    if (path.resolve(dir) === path.parse(path.resolve(dir)).root) {
      complete = false
    } else {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (err) {
        if (!meansAbsent(err)) log.warn("workspace enumeration failed", { dir, code: errnoCode(err) })
        entries = undefined
      }
      if (entries === undefined) {
        complete = false
      } else {
        const children = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
          // Deterministic order: fs.readdir's order varies across filesystems.
          .sort((a, b) => a.name.localeCompare(b.name))
        for (const child of children) {
          const found = await hasProjectFile(path.join(dir, child.name))
          if (found === true) return "dbt"
          if (found === undefined) complete = false
        }
      }
    }

    if (complete) sawCompleteAnswer = true
    else sawIncomplete = true
  }

  return sawCompleteAnswer && !sawIncomplete ? "non-dbt" : "unknown"
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
