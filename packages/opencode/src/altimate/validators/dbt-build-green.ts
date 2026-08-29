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
 *   - Failures on nodes the session did not touch are reported in telemetry
 *     but never block, so a pre-existing broken model elsewhere in the
 *     project cannot trap the session in a retry loop.
 *   - When the fresh artifact contains no model nodes at all (the last
 *     command was `dbt test`, which overwrites `run_results.json` with test
 *     nodes only), build coverage cannot be established, so the coverage
 *     assertion is skipped rather than guessed.
 */

import { promises as fs } from "fs"
import type { Validator, ValidatorContext, ValidatorResult } from "../../session/validators/types"
import {
  findDbtProjectRoot,
  modelsModifiedSince,
  modelNameFromPath,
  readRunResults,
  isFailedRunStatus,
  type RunResultsArtifact,
} from "./validator-utils"

/**
 * Slack allowed between a model's mtime and the build artifact's mtime before
 * the model counts as "edited after the last build". Absorbs filesystem
 * timestamp granularity and the ordering of writes inside a single dbt
 * invocation; it is not a correctness knob.
 */
const BUILD_FRESHNESS_TOLERANCE_MS = 1_000

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
    const statusByName = new Map<string, { status: string; message: string | null }>()
    for (const r of fresh.results) {
      statusByName.set(r.name, { status: r.status, message: r.message })
    }

    const states: ModelBuildState[] = []
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
      const recorded = statusByName.get(name)
      states.push({
        name,
        path,
        mtimeMs,
        status: recorded?.status ?? null,
        message: recorded?.message ?? null,
      })
    }

    const inScope = new Set(states.map((s) => s.name))
    const failedInScope = states.filter((s) => s.status !== null && isFailedRunStatus(s.status))
    // With no edits of our own, the fresh artifact IS this session's build, so
    // every failing node in it is in scope.
    const failedWholeRun =
      touchedPaths.length === 0
        ? fresh.results.filter((r) => isFailedRunStatus(r.status))
        : fresh.results.filter((r) => isFailedRunStatus(r.status) && inScope.has(r.name))
    const failedOutOfScope = fresh.results.filter(
      (r) => isFailedRunStatus(r.status) && !inScope.has(r.name),
    ).length

    // Coverage is only assertable when the artifact actually recorded models.
    const coverageAssertable = modelNodes.size > 0
    const notBuilt = coverageAssertable ? states.filter((s) => s.status === null) : []
    const staleBuild = states.filter(
      (s) => s.status !== null && s.mtimeMs > fresh.mtimeMs + BUILD_FRESHNESS_TOLERANCE_MS,
    )

    const details = {
      ...baseDetails,
      verdict: "fresh-build",
      coverage_assertable: coverageAssertable,
      model_nodes_in_artifact: modelNodes.size,
      failed_in_scope: failedWholeRun.map((r) => r.name),
      failed_out_of_scope: failedOutOfScope,
      not_built: notBuilt.map((s) => s.name),
      stale_build: staleBuild.map((s) => s.name),
    }

    if (failedWholeRun.length === 0 && notBuilt.length === 0 && staleBuild.length === 0) {
      return { ok: true, details }
    }

    const reasonParts: string[] = []
    if (failedWholeRun.length > 0) {
      reasonParts.push(
        `${failedWholeRun.length} node(s) failed in the last build: ${failedWholeRun.map((r) => `${r.name} (${r.status})`).join(", ")}`,
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
    for (const failure of failedWholeRun.slice(0, 10)) {
      const msg = (failure.message ?? "").split("\n")[0]?.slice(0, 200)
      hintLines.push(`  • ${failure.name} — ${failure.status}${msg ? `: ${msg}` : ""}`)
    }
    if (failedWholeRun.length > 10) {
      hintLines.push(`  • …and ${failedWholeRun.length - 10} more`)
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
