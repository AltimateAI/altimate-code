// altimate_change start — nothing-built inverse completion gate
/**
 * "Nothing was built" inverse gate.
 *
 * Every other validator in this lane starts from the set of files the session
 * modified. That leaves a blind spot at the bottom of the lane: a session
 * that wrote *nothing at all* touches no models, so every model-scoped gate
 * has an empty work list and passes trivially. Evaluation traces show this is
 * not a hypothetical — the dominant end-state of a lost session is an empty
 * workspace plus a confident summary, which the lane waves through.
 *
 * This validator inverts the question: instead of "is what you wrote
 * correct?", it asks "the task required artifacts — where are they?".
 *
 * False-positive safety is the whole design problem here, because plenty of
 * legitimate sessions are read-only (analysis, code reading, cost review) and
 * must be allowed to finish having written nothing. So the gate never fires
 * on the mere absence of writes. It requires positive evidence that the task
 * demanded artifacts:
 *
 *   - a task/instruction document in the workspace that literally names
 *     required models or files (see `extractRequiredDeliverables`), or
 *   - explicit opt-in via `ALTIMATE_VALIDATORS_REQUIRE_ARTIFACTS=1`.
 *
 * With neither present, `appliesTo` returns false and the session is never
 * even inspected.
 */

import { promises as fs } from "fs"
import { join } from "path"
import type { Validator, ValidatorContext, ValidatorResult } from "../../session/validators/types"
import {
  findDbtProjectRoot,
  findTaskInstructionFile,
  extractRequiredDeliverables,
  readRunResults,
  isFailedRunStatus,
  type RequiredDeliverables,
} from "./validator-utils"

/** Env flag that forces the gate on regardless of task-file discovery. */
const OPT_IN_ENV = "ALTIMATE_VALIDATORS_REQUIRE_ARTIFACTS"

/**
 * Directories whose contents count as "the session produced something". Wider
 * than `models/` on purpose: editing a seed, a snapshot, a macro or a schema
 * file is real work, and this gate must only fire on a session that produced
 * nothing whatsoever.
 */
const AUTHORED_DIRS = ["models", "seeds", "snapshots", "data", "analyses", "macros", "tests"]
/**
 * Root-level project files whose edit is also real work. A session that only
 * had to change `dbt_project.yml` or add a package produced something, and
 * reporting it as having written nothing would be a false accusation.
 */
const AUTHORED_ROOT_FILES = [
  "dbt_project.yml",
  "packages.yml",
  "dependencies.yml",
  "selectors.yml",
  "profiles.yml",
]
/** Depth limit mirroring the other project scans in this lane. */
const SCAN_MAX_DEPTH = 8
/**
 * `unique_id` prefixes for nodes that materialise something. A `dbt test` run
 * overwrites `run_results.json` with test rows only, and counting those as a
 * build would let a session that produced no deliverable clear this gate —
 * the exact end-state the validator exists to catch.
 */
const BUILDABLE_NODE_PREFIXES = ["model.", "seed.", "snapshot.", "operation."]

/** Evidence that this session was expected to produce artifacts. */
interface ArtifactExpectation {
  /** Why the gate considers itself applicable. */
  kind: "task-file" | "opt-in"
  /** Path of the task document, when that is the source of the expectation. */
  taskFile?: string
  /** Deliverables the document named, when it named any. */
  required?: RequiredDeliverables
}

/**
 * Decide whether this session was expected to produce artifacts. Returns null
 * when there is no such evidence, which makes the validator skip entirely.
 */
async function artifactExpectation(
  cwd: string,
  dbtRoot: string,
): Promise<ArtifactExpectation | null> {
  const task = await findTaskInstructionFile(cwd, dbtRoot)
  if (task) {
    const required = extractRequiredDeliverables(task.content)
    if (required) return { kind: "task-file", taskFile: task.path, required }
  }
  if (process.env[OPT_IN_ENV] === "1") return { kind: "opt-in" }
  return null
}

/**
 * True as soon as any authored file under the project was written during this
 * session. Short-circuits on the first hit so the common case is cheap.
 */
async function anyAuthoredFileSince(dbtRoot: string, sinceMs: number): Promise<boolean> {
  async function scan(dir: string, depth: number): Promise<boolean> {
    if (depth > SCAN_MAX_DEPTH) return false
    let entries: import("fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target") {
        continue
      }
      const full = join(dir, entry.name)
      let stat: import("fs").Stats
      try {
        stat = await fs.stat(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (await scan(full, depth + 1)) return true
      } else if (stat.isFile() && stat.mtimeMs >= sinceMs) {
        return true
      }
    }
    return false
  }
  for (const dir of AUTHORED_DIRS) {
    if (await scan(join(dbtRoot, dir), 0)) return true
  }
  for (const name of AUTHORED_ROOT_FILES) {
    try {
      const stat = await fs.stat(join(dbtRoot, name))
      if (stat.isFile() && stat.mtimeMs >= sinceMs) return true
    } catch {
      // absent — keep looking
    }
  }
  return false
}

export const DbtNothingBuiltValidator: Validator = {
  name: "dbt-nothing-built",
  description:
    "Inverse completion gate. When the workspace carries a task document that literally names required models or files (or the require-artifacts opt-in is set), refuses to terminate a session that authored no project files and produced no fresh successful build artifact.",

  async appliesTo(ctx: ValidatorContext): Promise<boolean> {
    const dbtRoot = await findDbtProjectRoot(ctx.workingDirectory)
    if (!dbtRoot) return false
    return (await artifactExpectation(ctx.workingDirectory, dbtRoot)) !== null
  },

  async check(ctx: ValidatorContext): Promise<ValidatorResult> {
    const startedAt = Date.now()
    const dbtRoot = await findDbtProjectRoot(ctx.workingDirectory)
    if (!dbtRoot) {
      return { ok: true, details: { skipped: "no dbt project", session_id: ctx.sessionID } }
    }
    const expectation = await artifactExpectation(ctx.workingDirectory, dbtRoot)
    if (!expectation) {
      return {
        ok: true,
        details: { skipped: "no artifact expectation", session_id: ctx.sessionID },
      }
    }

    const authored = await anyAuthoredFileSince(dbtRoot, ctx.sessionStartMs)
    const runResults = await readRunResults(dbtRoot)
    const freshRun =
      runResults !== null &&
      runResults.mtimeMs >= ctx.sessionStartMs &&
      runResults.results.some(
        (r) =>
          BUILDABLE_NODE_PREFIXES.some((prefix) => r.uniqueId.startsWith(prefix)) &&
          !isFailedRunStatus(r.status),
      )

    const details = {
      expectation: expectation.kind,
      task_file: expectation.taskFile ?? null,
      required_models: expectation.required?.models ?? [],
      required_source: expectation.required?.source ?? null,
      authored_files: authored,
      fresh_run_results: freshRun,
      run_results_path: runResults?.path ?? null,
      dbt_root: dbtRoot,
      session_id: ctx.sessionID,
      elapsed_ms: Date.now() - startedAt,
    }

    if (authored || freshRun) return { ok: true, details }

    const named = expectation.required?.models ?? []
    const namedText = named.length > 0 ? `: ${named.join(", ")}` : ""
    const reason =
      expectation.kind === "task-file"
        ? `The task document at ${expectation.taskFile} names required deliverables${namedText}, but this session wrote no project files and produced no fresh successful build artifact. Nothing was built, so the task is not done.`
        : `This session wrote no project files and produced no fresh successful build artifact, but the workspace is configured to require artifacts. Nothing was built, so the task is not done.`

    return {
      ok: false,
      reason,
      fixHint:
        [
          "Do the work before declaring done:",
          named.length > 0
            ? `  • Create each required deliverable under \`models/\` using the literal name given: ${named.join(", ")}.`
            : "  • Create the model files the task asks for under `models/`.",
          "  • Build them (`dbt build` / `dbt run`) so a successful `run_results.json` exists.",
          "  • If you believe the work is already present, re-read the task document and name the file you produced for each deliverable.",
        ].join("\n"),
      details,
    }
  },
}
// altimate_change end
