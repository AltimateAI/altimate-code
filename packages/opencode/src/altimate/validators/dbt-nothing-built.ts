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
  findTaskInstructionFiles,
  extractRequiredDeliverables,
  readRunResults,
  isFailedRunStatus,
  resolveDbtSourcePaths,
  runResultsProducedNodes,
  collectProducedNodeNames,
  resolveWithinRoot,
  sanitizeForPrompt,
  MODEL_NODE_EXTENSIONS,
  SEED_NODE_EXTENSIONS,
  type RequiredDeliverables,
} from "./validator-utils"

/** Env flag that forces the gate on regardless of task-file discovery. */
const OPT_IN_ENV = "ALTIMATE_VALIDATORS_REQUIRE_ARTIFACTS"

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
 *
 * `operation.` is excluded for the same reason: an `on-run-end` hook or a
 * `dbt run-operation` records a successful operation row while materialising
 * nothing, so accepting it hands an otherwise-empty session a free pass. A
 * `dbt run` that did build something records model rows too, so nothing
 * legitimate depends on the operation row.
 */
const BUILDABLE_NODE_PREFIXES = ["model.", "seed.", "snapshot."]

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
  // Keep looking past a task document that states no contract: an
  // informational `TASK.md` sitting beside the `REQUIREMENTS.md` that carries
  // the real obligations would otherwise mask it and skip this gate entirely.
  for (const task of await findTaskInstructionFiles(cwd, dbtRoot)) {
    const required = extractRequiredDeliverables(task.content)
    if (required) return { kind: "task-file", taskFile: task.path, required }
  }
  if (process.env[OPT_IN_ENV] === "1") return { kind: "opt-in" }
  return null
}

/** What a session authored under the project during its lifetime. */
interface AuthoredWork {
  /** True when anything at all was written. */
  any: boolean
  /** Bare, lowercased base names of authored files (`fct_orders.sql` → `fct_orders`). */
  names: Set<string>
  /** Authored paths relative to the project root, lowercased, `/`-separated. */
  relPaths: Set<string>
}

/** Normalise a project-relative path for comparison against a task contract. */
function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()
}

/**
 * Collect what the session authored under the project.
 *
 * Returns the names as well as the bare boolean, because "did you write
 * anything at all" is too coarse a bar once the task names deliverables: a
 * session asked for `fct_orders` that writes only `macros/helper.sql` has
 * produced nothing the task asked for, and answering the coarse question lets
 * it through.
 */
async function authoredWorkSince(dbtRoot: string, sinceMs: number): Promise<AuthoredWork> {
  const out: AuthoredWork = { any: false, names: new Set(), relPaths: new Set() }
  // Realpaths of directories already scanned. `fs.stat` follows symlinks, so
  // a directory symlink pointing back at an ancestor makes this recurse into
  // the same tree again; the depth cap alone only slows that (bounding it to
  // MAX_DEPTH copies of the cycle), and with several such links the
  // traversal multiplies at every level. This makes a revisit a no-op
  // instead.
  const visitedDirs = new Set<string>()
  /**
   * `nameExtensions` gates only the NAME index, two ways:
   *   - `null` — this file is under a non-relation-producing directory
   *     (macros/analyses/tests). Editing `macros/fct_orders.sql` is real
   *     work — it counts towards `any` and is recorded in `relPaths` — but it
   *     does not define a model called `fct_orders`, so letting its stem
   *     satisfy a required model would recreate the vacuous pass this
   *     correlation exists to close.
   *   - an extension list — this file is under a relation-producing
   *     directory, but only counts towards the name index when its extension
   *     is one dbt actually loads there (`.sql`/`.py` for models/snapshots,
   *     `.csv` for seeds). Writing `models/orders.txt` under an inert
   *     extension must not satisfy "update the model `orders`": the required
   *     `.sql` file was never touched, and every gate would otherwise clear
   *     having built nothing.
   */
  const record = (full: string, nameExtensions: string[] | null): void => {
    out.any = true
    if (nameExtensions) {
      const lower = full.toLowerCase()
      const ext = nameExtensions.find((e) => lower.endsWith(e))
      if (ext) {
        const base = full.split(/[\\/]/).pop() ?? ""
        const stem = base.slice(0, base.length - ext.length).toLowerCase()
        if (stem.length > 0) out.names.add(stem)
      }
    }
    const rel = full.startsWith(dbtRoot) ? full.slice(dbtRoot.length).replace(/^[\\/]+/, "") : full
    out.relPaths.add(normalizeRelPath(rel))
  }
  async function scan(dir: string, depth: number, nameExtensions: string[] | null): Promise<void> {
    if (depth > SCAN_MAX_DEPTH) return
    let realDir: string
    try {
      realDir = await fs.realpath(dir)
    } catch {
      return
    }
    if (visitedDirs.has(realDir)) return
    visitedDirs.add(realDir)
    let entries: import("fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
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
        await scan(full, depth + 1, nameExtensions)
      } else if (stat.isFile() && stat.mtimeMs >= sinceMs) {
        record(full, nameExtensions)
      }
    }
  }
  // Directories come from `dbt_project.yml`, so a project on custom
  // `model-paths` is not reported as having authored nothing.
  const sourcePaths = await resolveDbtSourcePaths(dbtRoot)
  // Only these three define relations, so only these contribute names — and
  // only under the extension dbt actually loads for that directory kind.
  for (const dir of [...sourcePaths.models, ...sourcePaths.snapshots]) {
    await scan(dir, 0, MODEL_NODE_EXTENSIONS)
  }
  for (const dir of sourcePaths.seeds) {
    await scan(dir, 0, SEED_NODE_EXTENSIONS)
  }
  // Real work, but not a relation definition.
  for (const dir of [...sourcePaths.analyses, ...sourcePaths.macros, ...sourcePaths.tests]) {
    await scan(dir, 0, null)
  }
  for (const name of AUTHORED_ROOT_FILES) {
    const full = join(dbtRoot, name)
    try {
      const stat = await fs.stat(full)
      if (stat.isFile() && stat.mtimeMs >= sinceMs) record(full, null)
    } catch {
      // absent — keep looking
    }
  }
  return out
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

    const authoredWork = await authoredWorkSince(dbtRoot, ctx.sessionStartMs)
    const authored = authoredWork.any
    const runResults = await readRunResults(dbtRoot)
    // A `dbt compile` artifact records every model as `success` without
    // building anything, so it is not evidence a deliverable was produced.
    //
    // `runResultsProducedNodes`, not `runResultsExecutedModels`: this gate
    // asks whether a DELIVERABLE was produced, and a task can require a seed
    // or a snapshot. The model-coverage predicate denies `seed`/`snapshot`/
    // `clone` — correct for `dbt-build-green`, wrong here, where it made a
    // successful `dbt seed` of the required name read as nothing built.
    const runResultsAreABuild =
      runResults !== null && runResultsProducedNodes(runResults.command)
    const builtNodeNames = new Set<string>()
    if (runResults !== null && runResultsAreABuild && runResults.mtimeMs >= ctx.sessionStartMs) {
      for (const r of runResults.results) {
        if (!BUILDABLE_NODE_PREFIXES.some((prefix) => r.uniqueId.startsWith(prefix))) continue
        if (isFailedRunStatus(r.status)) continue
        builtNodeNames.add(r.name)
      }
    }
    const freshRun = builtNodeNames.size > 0

    // When the task names deliverables, the evidence has to be about THOSE
    // names. Asking only "was anything written" lets a session asked for
    // `fct_orders` clear the gate by touching `macros/helper.sql`. That is
    // normally masked by `dbt-deliverable-names`, but under the
    // require-artifacts opt-in this gate stands alone.
    const namedModels = expectation.required?.models ?? []
    const namedFiles = expectation.required?.files ?? []
    const hasNamedDeliverables = namedModels.length > 0 || namedFiles.length > 0
    // A deliverable that already exists on disk satisfies the contract even
    // when this session did not touch it.
    //
    // Without this, a task document is a permanent trap: a workspace whose
    // TASK.md names `fct_orders` — delivered in some earlier session, and the
    // document never cleaned up — would block every later session that did
    // unrelated work, and no action the agent can take inside the session
    // clears it short of editing the task document itself. It would then burn
    // the whole shared retry budget every time.
    //
    // Existence rather than authorship is also what `dbt-deliverable-names`
    // already asserts, so the two contract gates now agree on what "delivered"
    // means instead of disagreeing by one session.
    const existingNodes = hasNamedDeliverables
      ? await collectProducedNodeNames(dbtRoot)
      : new Set<string>()
    // Same modification/creation split as `modificationModels`: "Update the
    // file `models/schema.yml`" cannot be satisfied by the file merely
    // existing from before this session — the task is asking for a change to
    // its content, and existence proves nothing about whether that happened.
    const modificationFileSet = new Set(expectation.required?.modificationFiles ?? [])
    const matchedFiles: string[] = []
    for (const file of namedFiles) {
      if (authoredWork.relPaths.has(normalizeRelPath(file))) {
        matchedFiles.push(file)
        continue
      }
      // Same existence escape hatch as for named models, and resolved from
      // both roots exactly as `dbt-deliverable-names` does. With the dbt
      // project nested below the workspace, a required `reports/output.yml`
      // written at the workspace root satisfies that gate and failed this one,
      // so a correct session was blocked by one of two gates that are supposed
      // to agree on what "delivered" means.
      let found = false
      let foundMtimeMs: number | null = null
      for (const root of new Set([dbtRoot, ctx.workingDirectory])) {
        // A task-required file path is repository content and the extractor's
        // shape check allows `.`/`/` freely (`../../outside/secret.yml`
        // matches it). Resolving through `resolveWithinRoot` refuses to
        // `stat` outside either allowed root, so a task naming a path that
        // escapes the workspace cannot satisfy this gate with an unrelated
        // file elsewhere on disk.
        const safePath = await resolveWithinRoot(root, file)
        if (!safePath) continue
        try {
          const stat = await fs.stat(safePath)
          if (stat.isFile()) {
            found = true
            foundMtimeMs = stat.mtimeMs
            break
          }
        } catch {
          // absent under this root — keep looking
        }
      }
      if (!found) continue
      if (modificationFileSet.has(file)) {
        // A modification target still cannot be satisfied by mere pre-session
        // existence — but `authoredWork.relPaths` only covers the dbt source
        // paths (models/seeds/snapshots/analyses/macros/tests) plus a small
        // root-file allowlist. A required file OUTSIDE all of those
        // (`reports/output.yml`) never appears there even when the session
        // genuinely edited it this run, so the relPaths check above can never
        // catch it — falling through to a blanket skip made the contract
        // permanently unsatisfiable for a legitimately-updated file living
        // outside the scanned directories. `mtime` is the fallback session-
        // evidence signal for exactly that case: a fresh mtime (>=
        // sessionStartMs) is genuine authorship even for an unscanned path: a
        // stale one means the file only pre-existed, same as before.
        if (foundMtimeMs !== null && foundMtimeMs >= ctx.sessionStartMs) matchedFiles.push(file)
        continue
      }
      matchedFiles.push(file)
    }
    // A name the task asked to be MODIFIED (update/fix/rename/…) cannot be
    // satisfied by mere pre-session existence: "Update the model `orders`"
    // asks for a change, and the model being on disk from before this
    // session proves nothing about whether this session made it. Without
    // this, a session that touches nothing and builds nothing clears this
    // gate — the exact zero-write end-state it exists to catch — the moment
    // the target of an "update" contract already happens to exist.
    const modificationSet = new Set(
      (expectation.required?.modificationModels ?? []).map((m) => m.toLowerCase()),
    )
    const matchedDeliverables = hasNamedDeliverables
      ? [
          ...namedModels.filter((name) => {
            const lower = name.toLowerCase()
            const sessionEvidence = authoredWork.names.has(lower) || builtNodeNames.has(lower)
            if (modificationSet.has(lower)) return sessionEvidence
            return sessionEvidence || existingNodes.has(lower)
          }),
          ...matchedFiles,
        ]
      : []
    const satisfied = hasNamedDeliverables
      ? matchedDeliverables.length > 0
      : // No named deliverables (the bare opt-in): the coarse bar is all there
        // is to go on, and it is the right one — any project write counts.
        authored || freshRun

    const details = {
      expectation: expectation.kind,
      task_file: expectation.taskFile ?? null,
      required_models: namedModels,
      required_files: namedFiles,
      required_source: expectation.required?.source ?? null,
      authored_files: authored,
      fresh_run_results: freshRun,
      matched_deliverables: matchedDeliverables,
      run_results_path: runResults?.path ?? null,
      run_results_command: runResults?.command ?? null,
      dbt_root: dbtRoot,
      session_id: ctx.sessionID,
      elapsed_ms: Date.now() - startedAt,
    }

    if (satisfied) return { ok: true, details }

    const named = namedModels
    // Every value below is repository-controlled — a deliverable name parsed
    // out of a task document, and the task document's own path — and `reason`
    // / `fixHint` are concatenated by dispatch into a synthetic `role: "user"`
    // turn that the next tool-capable turn reads. Interpolated verbatim, a
    // name or filename carrying a newline breaks out of the sentence it is
    // quoted in and lands at instruction position. `dbt-build-green` already
    // routes every untrusted string through `sanitizeForPrompt`; this gate
    // builds the same kind of turn and must do the same.
    const safeNames = named.map((n) => sanitizeForPrompt(n, 80))
    const safeTaskFile = sanitizeForPrompt(expectation.taskFile ?? "", 160)
    const namedText = safeNames.length > 0 ? `: ${safeNames.join(", ")}` : ""
    const wroteSomethingElse = hasNamedDeliverables && authored
    const reason =
      expectation.kind === "task-file"
        ? wroteSomethingElse
          ? `The task document at ${safeTaskFile} names required deliverables${namedText}, and this session wrote project files but none of them is any of those deliverables. The named work was not done.`
          : freshRun
            ? // Evidence exists, it just is not about the named deliverables.
              // Reporting "no fresh build artifact" here is simply false, and
              // a retry prompt that misdescribes the workspace teaches the
              // agent to distrust the gate.
              `The task document at ${safeTaskFile} names required deliverables${namedText}, but this session built other deliverables and none of them matched those names. The named work was not done.`
            : `The task document at ${safeTaskFile} names required deliverables${namedText}, but this session wrote no project files and produced no fresh successful build artifact. Nothing was built, so the task is not done.`
        : `This session wrote no project files and produced no fresh successful build artifact, but the workspace is configured to require artifacts. Nothing was built, so the task is not done.`

    return {
      ok: false,
      reason,
      fixHint:
        [
          "Do the work before declaring done:",
          safeNames.length > 0
            ? `  • Create each required deliverable under \`models/\` using the literal name given: ${safeNames.join(", ")}.`
            : "  • Create the model files the task asks for under `models/`.",
          "  • Build them (`dbt build` / `dbt run`) so a successful `run_results.json` exists.",
          "  • If you believe the work is already present, re-read the task document and name the file you produced for each deliverable.",
        ].join("\n"),
      details,
    }
  },
}
// altimate_change end
