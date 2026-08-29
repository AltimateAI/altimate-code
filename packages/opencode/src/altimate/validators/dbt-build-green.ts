// altimate_change start — build-green completion gate
/**
 * Build-green completion gate.
 *
 * Refuses to let a session finish claiming success when the models it edited
 * were never successfully built. Three distinct end-states are caught, all of
 * them observed in evaluation traces as "declared done, nothing usable on
 * disk":
 *
 *   1. Models were edited but no build artifact exists at all.
 *   2. A `run_results.json` exists but predates the session — the agent is
 *      reading someone else's green build.
 *   3. A fresh `run_results.json` exists but the edited models are absent
 *      from it, are older than the last edit, or built with a failing status.
 *
 * Everything is read off the filesystem: `<target>/run_results.json` plus
 * model mtimes. No subprocess, no warehouse connection, no knowledge of the
 * expected answer.
 *
 * Conservative by construction:
 *   - When the session edited nothing and no fresh artifact exists, this gate
 *     stays out of the way (that is `dbt-nothing-built`'s question, and only
 *     when the task demanded artifacts).
 *   - When the session edited models, failures on nodes it did not touch are
 *     reported in telemetry but never block, so a pre-existing broken model
 *     elsewhere in the project cannot trap the session in a retry loop. When
 *     the session edited nothing, the fresh artifact IS this session's own
 *     build, so every failure in it is in scope.
 *   - Models dbt legitimately omits from `run_results` — `ephemeral` (compiled
 *     into its consumers) and `enabled=false` (retired on purpose) — are
 *     exempt from the coverage assertion. Requiring a row that dbt will never
 *     write is a gate no agent can clear.
 *
 * `run_results.json` is a single file that every dbt command overwrites, so a
 * session whose last command was `dbt test` leaves an artifact with test nodes
 * only. Coverage is therefore established from two sources: the run artifact,
 * plus the model DDL dbt writes under `<target>/run/`, which a test invocation
 * does not touch. When neither source can speak, the verdict is recorded as
 * `coverage-inconclusive` rather than passing silently.
 */

import { promises as fs } from "fs"
import type { Validator, ValidatorContext, ValidatorResult } from "../../session/validators/types"
import {
  findDbtProjectRoot,
  modelsModifiedSince,
  modelNameFromPath,
  readRunResults,
  isFailedRunStatus,
  collectExecutedModelNames,
  collectRunResultExemptModels,
  sourceExemptsFromRunResults,
  type RunResultsArtifact,
} from "./validator-utils"

/**
 * Slack allowed between a model's mtime and the build artifact's mtime before
 * the model counts as "edited after the last build".
 *
 * Sized from observed agent behaviour rather than from filesystem granularity.
 * "Build, then tidy the file, then summarise" is a common trajectory, and a
 * trailing newline or a reflowed comment landing a few seconds after a green
 * build cannot change the compiled SQL — but at a one-second tolerance it
 * blocked the session anyway. A minute covers the tidy-up window; a
 * substantive rewrite the agent means to ship is followed by a rebuild, not by
 * a minute of silence.
 *
 * The exact fix is a content comparison against what was built, which needs a
 * pre-build snapshot this gate does not have.
 */
const BUILD_FRESHNESS_TOLERANCE_MS = 60_000

/** A touched model and what the build artifact says about it. */
interface ModelBuildState {
  name: string
  path: string
  mtimeMs: number
  /** dbt status, or null when the model is absent from the artifact. */
  status: string | null
  message: string | null
}

/** Model-node names present in a run_results artifact. */
function modelNodeNames(artifact: RunResultsArtifact): Set<string> {
  const out = new Set<string>()
  for (const r of artifact.results) {
    if (r.uniqueId.startsWith("model.")) out.add(r.name)
  }
  return out
}

/**
 * Every spelling under which a run-result row can be matched to a file on
 * disk. A dbt versioned model is `model.pkg.dim_accounts.v2` in the artifact
 * and `dim_accounts_v2.sql` on disk, so both have to be offered or a
 * successfully-built versioned model reads as never built.
 */
function resultKeys(r: { name: string; version: string | null }): string[] {
  return r.version ? [r.name, `${r.name}_${r.version}`] : [r.name]
}

export const DbtBuildGreenValidator: Validator = {
  name: "dbt-build-green",
  description:
    "After the agent declares done, refuses to terminate unless a fresh successful dbt build artifact (`run_results.json` newer than the session start, no failing status) covers every model the session edited.",

  async appliesTo(ctx: ValidatorContext): Promise<boolean> {
    return (await findDbtProjectRoot(ctx.workingDirectory)) !== null
  },

  async check(ctx: ValidatorContext): Promise<ValidatorResult> {
    const startedAt = Date.now()
    const dbtRoot = await findDbtProjectRoot(ctx.workingDirectory)
    if (!dbtRoot) {
      return { ok: true, details: { skipped: "no dbt project", session_id: ctx.sessionID } }
    }

    const touchedPaths = await modelsModifiedSince(dbtRoot, ctx.sessionStartMs)
    const artifact = await readRunResults(dbtRoot)
    const artifactIsFresh = artifact !== null && artifact.mtimeMs >= ctx.sessionStartMs

    const baseDetails = {
      models_touched: touchedPaths.length,
      run_results_path: artifact?.path ?? null,
      run_results_fresh: artifactIsFresh,
      dbt_root: dbtRoot,
      session_id: ctx.sessionID,
      elapsed_ms: Date.now() - startedAt,
    }

    // Nothing edited and no build of our own: there is no claim to check here.
    if (touchedPaths.length === 0 && !artifactIsFresh) {
      return { ok: true, details: { ...baseDetails, verdict: "nothing-to-gate" } }
    }

    if (touchedPaths.length > 0 && !artifactIsFresh) {
      const reason =
        artifact === null
          ? `You edited ${touchedPaths.length} model(s) but this project has no dbt build artifact — the models were never built, so nothing shows they compile or run.`
          : `You edited ${touchedPaths.length} model(s) but the only build artifact (${artifact.path}) predates this session. Your edits have never been built.`
      return {
        ok: false,
        reason,
        fixHint:
          "Run `dbt build` (or `dbt run` followed by `dbt test`) for the models you changed, confirm it finishes without errors, then declare done. If the build fails, fix the model SQL — do not delete the failing model or narrow the selector to hide it.",
        details: { ...baseDetails, verdict: "no-fresh-build" },
      }
    }

    // From here on there IS a fresh artifact.
    const fresh = artifact as RunResultsArtifact
    const modelNodes = modelNodeNames(fresh)
    // Statuses come from model rows only. A singular test can carry the same
    // bare name as the model it tests, and letting its row stand in for the
    // model's would both fabricate coverage and mis-attribute its failure.
    const statusByName = new Map<string, { status: string; message: string | null }>()
    for (const r of fresh.results) {
      if (!r.uniqueId.startsWith("model.")) continue
      for (const key of resultKeys(r)) {
        statusByName.set(key, { status: r.status, message: r.message })
      }
    }

    // Second, independent build-evidence source: the model DDL dbt writes
    // under `<target>/run/`. A `dbt test` invocation overwrites
    // `run_results.json` but does not touch these, so this is what keeps the
    // coverage assertion alive after the agent's last command was a test run.
    const executed = await collectExecutedModelNames(dbtRoot, ctx.sessionStartMs)
    // Models dbt never records a run-result row for. Requiring one for these
    // is a gate the agent cannot clear by doing anything correct.
    const exemptFromManifest = await collectRunResultExemptModels(dbtRoot)

    const states: ModelBuildState[] = []
    const exemptModels: string[] = []
    for (const path of touchedPaths) {
      const name = modelNameFromPath(path).toLowerCase()
      let mtimeMs = 0
      try {
        mtimeMs = (await fs.stat(path)).mtimeMs
      } catch {
        // The file vanished between the scan and now; treat as unknown mtime
        // so it can never be reported as "edited after the build".
        mtimeMs = 0
      }
      let exempt = exemptFromManifest.has(name)
      if (!exempt) {
        try {
          exempt = sourceExemptsFromRunResults(await fs.readFile(path, "utf8"))
        } catch {
          // Unreadable model — leave it to the coverage assertion, which is
          // the conservative direction for a file we cannot inspect.
        }
      }
      if (exempt) {
        exemptModels.push(name)
        continue
      }
      const recorded = statusByName.get(name)
      states.push({
        name,
        path,
        mtimeMs,
        status: recorded?.status ?? null,
        message: recorded?.message ?? null,
      })
    }

    // With no edits of our own, the fresh artifact IS this session's build, so
    // every failing node in it is in scope. Otherwise scope is what we edited,
    // and failures elsewhere — including failures of same-named non-model
    // nodes — are recorded but never block.
    const inScope = new Set(states.map((s) => s.name))
    const allFailed = fresh.results.filter((r) => isFailedRunStatus(r.status))
    const failedInScope =
      touchedPaths.length === 0
        ? allFailed
        : allFailed.filter(
            (r) => r.uniqueId.startsWith("model.") && resultKeys(r).some((k) => inScope.has(k)),
          )
    const failedOutOfScope = allFailed.length - failedInScope.length

    // Coverage is assertable when either evidence source can speak for the
    // models we touched: the run artifact recorded models, or dbt wrote fresh
    // model DDL during this session.
    const coverageAssertable = modelNodes.size > 0 || executed.size > 0
    const notBuilt = coverageAssertable
      ? states.filter((s) => s.status === null && !executed.has(s.name))
      : []
    const staleBuild = states.filter(
      (s) =>
        (s.status !== null || executed.has(s.name)) &&
        s.mtimeMs > fresh.mtimeMs + BUILD_FRESHNESS_TOLERANCE_MS,
    )

    const details = {
      ...baseDetails,
      verdict: coverageAssertable || states.length === 0 ? "fresh-build" : "coverage-inconclusive",
      coverage_assertable: coverageAssertable,
      model_nodes_in_artifact: modelNodes.size,
      executed_models: executed.size,
      exempt_models: exemptModels,
      failed_in_scope: failedInScope.map((r) => r.name),
      failed_out_of_scope: failedOutOfScope,
      not_built: notBuilt.map((s) => s.name),
      stale_build: staleBuild.map((s) => s.name),
    }

    if (failedInScope.length === 0 && notBuilt.length === 0 && staleBuild.length === 0) {
      return { ok: true, details }
    }

    const reasonParts: string[] = []
    if (failedInScope.length > 0) {
      reasonParts.push(
        `${failedInScope.length} node(s) failed in the last build: ${failedInScope.map((r) => `${r.name} (${r.status})`).join(", ")}`,
      )
    }
    if (notBuilt.length > 0) {
      reasonParts.push(
        `${notBuilt.length} model(s) you edited were never built: ${notBuilt.map((s) => s.name).join(", ")}`,
      )
    }
    if (staleBuild.length > 0) {
      reasonParts.push(
        `${staleBuild.length} model(s) were edited after the last build: ${staleBuild.map((s) => s.name).join(", ")}`,
      )
    }

    const hintLines: string[] = []
    for (const failure of failedInScope.slice(0, 10)) {
      const msg = (failure.message ?? "").split("\n")[0]?.slice(0, 200)
      hintLines.push(`  • ${failure.name} — ${failure.status}${msg ? `: ${msg}` : ""}`)
    }
    if (failedInScope.length > 10) {
      hintLines.push(`  • …and ${failedInScope.length - 10} more`)
    }
    hintLines.push(
      "Rebuild the models you changed with `dbt build` and make the run finish clean before declaring done. Fix the model SQL rather than removing the model, disabling the test, or narrowing the selector.",
    )

    return {
      ok: false,
      reason: `The build is not green: ${reasonParts.join("; ")}.`,
      fixHint: hintLines.join("\n"),
      details,
    }
  },
}
// altimate_change end
