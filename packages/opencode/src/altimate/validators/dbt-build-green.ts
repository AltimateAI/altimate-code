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
 * `run_results.json` is a single file that every dbt command overwrites, and it
 * does not say what a row means on its own. Two things follow.
 *
 * First, provenance is checked before status is believed. `dbt compile` writes
 * a complete set of `status: "success"` model rows having executed nothing —
 * including for a model that cannot run at all — so an artifact from a command
 * that does not execute model SQL is not build evidence.
 *
 * Second, a session whose last command was `dbt test` leaves an artifact with
 * test nodes only. Coverage is therefore established from two sources: the run
 * artifact, plus the model DDL dbt writes under `<target>/run/`, which a test
 * invocation does not overwrite.
 *
 * The verdict says which of those held, because "passed" and "was actually
 * verified" are different claims and the telemetry has to tell them apart:
 *
 *   - `fresh-build` — every in-scope model has a success row from a
 *     model-executing command. This is the only verified pass.
 *   - `build-unproven` — coverage rests on `<target>/run/` DDL alone, or a
 *     model was edited inside the freshness grace window. dbt writes that DDL
 *     *before* execution, so it survives a model that then failed; it proves
 *     the model was attempted, not that it succeeded.
 *   - `coverage-inconclusive` — neither evidence source can speak.
 *   - `nothing-verified` / `exempt-only` — the scope was empty, or everything
 *     in it was legitimately exempt. Nothing was checked, and the verdict says
 *     so rather than reading as a verified build.
 *   - `non-executing-artifact` / `no-fresh-build` — blocking states.
 *
 * Only `fresh-build` may be read as "this session's models were built green".
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
  sourceDeclaresNonEphemeral,
  sourceDeclaresEnabled,
  runResultsExecutedModels,
  runResultsCarriesNoBuildEvidence,
  sanitizeForPrompt,
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
    // `run_results.json` is one file that every dbt command overwrites, and a
    // `success` row in it means "this command finished this node", not "this
    // model was built". `dbt compile` writes a complete set of model rows with
    // `status: "success"` having executed nothing — including for a model that
    // cannot run at all. So provenance is checked before status is believed.
    const noBuildEvidence = artifact !== null && runResultsCarriesNoBuildEvidence(artifact.command)
    const artifactIsFresh =
      artifact !== null && artifact.mtimeMs >= ctx.sessionStartMs && !noBuildEvidence
    /** A fresh artifact that exists but proves nothing (a `dbt compile` run). */
    const freshButNotABuild =
      artifact !== null && artifact.mtimeMs >= ctx.sessionStartMs && noBuildEvidence

    const baseDetails = {
      models_touched: touchedPaths.length,
      run_results_path: artifact?.path ?? null,
      run_results_fresh: artifactIsFresh,
      run_results_command: artifact?.command ?? null,
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
          : freshButNotABuild
            ? `You edited ${touchedPaths.length} model(s) and the only fresh artifact (${sanitizeForPrompt(artifact.path, 160)}) was written by the dbt command ${sanitizeForPrompt(artifact.command ?? "", 40)}, which does not execute any model SQL. That command records every model as "success" without building it, so it is not evidence your edits work.`
            : `You edited ${touchedPaths.length} model(s) but the only build artifact (${sanitizeForPrompt(artifact.path, 160)}) predates this session. Your edits have never been built.`
      return {
        ok: false,
        reason,
        fixHint: freshButNotABuild
          ? `That command only parses and renders SQL — it never runs it against the warehouse. Run \`dbt build\` for the models you changed and confirm it finishes without errors before declaring done.`
          : "Run `dbt build` for the models you changed, confirm it finishes without errors, then declare done. If the build fails, fix the model SQL — do not delete the failing model or narrow the selector to hide it.",
        details: {
          ...baseDetails,
          verdict: freshButNotABuild ? "non-executing-artifact" : "no-fresh-build",
        },
      }
    }

    // From here on there IS a fresh artifact that carries build evidence.
    const fresh = artifact as RunResultsArtifact
    // Only a command that actually executed model SQL can speak to a model's
    // status. A `test` artifact reaches here (it is the normal successor to a
    // build, and this lane's own `dbt-tests-pass` writes one on every pass),
    // but it carries no model rows, so coverage falls to the `<target>/run/`
    // DDL below.
    const artifactExecutedModels = runResultsExecutedModels(fresh.command)
    const modelNodes = artifactExecutedModels ? modelNodeNames(fresh) : new Set<string>()
    // Statuses come from model rows only. A singular test can carry the same
    // bare name as the model it tests, and letting its row stand in for the
    // model's would both fabricate coverage and mis-attribute its failure.
    const statusByName = new Map<string, { status: string; message: string | null }>()
    if (artifactExecutedModels) {
      for (const r of fresh.results) {
        if (!r.uniqueId.startsWith("model.")) continue
        for (const key of resultKeys(r)) {
          statusByName.set(key, { status: r.status, message: r.message })
        }
      }
    }

    // Second, independent build-evidence source: the model DDL dbt writes
    // under `<target>/run/`. A `dbt test` invocation overwrites
    // `run_results.json` but does not touch these, so this is what keeps the
    // coverage assertion alive after the agent's last command was a test run.
    //
    // Both scans below walk the project tree, which is the expensive part of
    // this gate on a large repo. With nothing touched there is no per-model
    // question to answer, so neither is worth paying for.
    const executed =
      touchedPaths.length > 0
        ? await collectExecutedModelNames(dbtRoot, ctx.sessionStartMs)
        : new Map<string, number>()
    // Models dbt never records a run-result row for. Requiring one for these
    // is a gate the agent cannot clear by doing anything correct.
    const exemptFromManifest =
      touchedPaths.length > 0
        ? await collectRunResultExemptModels(dbtRoot)
        : { ephemeral: new Set<string>(), disabled: new Set<string>() }

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
      // The model's own source is the newer of the two sources of truth and
      // is read first. `manifest.json` reflects the last `dbt parse`, so a
      // session that has just turned an ephemeral model into a table, or
      // re-enabled a disabled one, still appears exempt there — and the gate
      // would skip the very relation the session was asked to create.
      let exempt = false
      let saysNonEphemeral = false
      let saysEnabled = false
      try {
        const source = await fs.readFile(path, "utf8")
        exempt = sourceExemptsFromRunResults(source)
        saysNonEphemeral = sourceDeclaresNonEphemeral(source)
        saysEnabled = sourceDeclaresEnabled(source)
      } catch {
        // Unreadable model — leave it to the coverage assertion, which is
        // the conservative direction for a file we cannot inspect.
      }
      // The manifest still speaks for config set in `dbt_project.yml` rather
      // than in the model, which the source cannot show — but only when the
      // source contradicts it on the SAME axis. The axes are independent: a
      // model disabled in the project file may still set `materialized`, and
      // an ephemeral model may set `enabled=true`. Letting either declaration
      // discard both exemptions would demand a `run_results` row dbt is never
      // going to write.
      if (!exempt && exemptFromManifest.ephemeral.has(name) && !saysNonEphemeral) exempt = true
      if (!exempt && exemptFromManifest.disabled.has(name) && !saysEnabled) exempt = true
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
    // Staleness is measured against the artifact that actually covered the
    // model. For a model whose only evidence is its `<target>/run/` DDL, that
    // is the DDL's own mtime — `run_results.json` is rewritten by a later
    // `dbt test`, and dating the build from it would forgive every edit made
    // between the build and the test.
    //
    // A model that HAS a status row was covered by this artifact's own
    // invocation, and `run_results.json` is written when that invocation
    // finishes — so `fresh.mtimeMs` is the build-completion time. The DDL
    // under `<target>/run/` is written per model as the build walks the DAG,
    // which for a long build is minutes earlier. `Math.min` of the two always
    // picked the DDL, so the 60 s tolerance started ticking at compile time
    // and a tidy-up edit seconds after a long green build read as stale and
    // blocked the session. The DDL's own mtime remains the right answer for
    // the `status === null` case, where the DDL is the only evidence there is.
    const builtAtFor = (s: ModelBuildState): number | undefined => {
      return s.status !== null ? fresh.mtimeMs : executed.get(s.name)
    }
    const staleBuild = states.filter((s) => {
      const builtAt = builtAtFor(s)
      if (builtAt === undefined) return false
      return s.mtimeMs > builtAt + BUILD_FRESHNESS_TOLERANCE_MS
    })
    // Edited after the build but inside the grace window. The tolerance exists
    // because a formatter or a trailing-newline fix landing seconds after a
    // green build was blocking healthy sessions, and it stays — but it is a
    // heuristic about *why* the file changed, not evidence that what was built
    // still matches what is on disk. A substantive rewrite inside the window
    // lands here too, so these are reported as unproven rather than folded
    // silently into a verified pass. Closing this properly needs a content
    // hash taken at build time (follow-up 4).
    const editedWithinGrace = states.filter((s) => {
      const builtAt = builtAtFor(s)
      if (builtAt === undefined) return false
      return s.mtimeMs > builtAt && s.mtimeMs <= builtAt + BUILD_FRESHNESS_TOLERANCE_MS
    })

    // Models whose only evidence is `<target>/run/` DDL. dbt writes that DDL
    // *before* the warehouse executes the statement, so it survives a model
    // that then errored — it proves the model was attempted, never that it
    // succeeded. Reporting these as `fresh-build` is what let a failed build
    // followed by `dbt test` record as green, and it contaminates the shadow
    // telemetry this lane exists to collect. They are labelled distinctly so
    // the measurement is honest; the pass/fail decision is unchanged, because
    // narrowing it would block the healthy `dbt run` / `dbt test` sequence
    // (see follow-up 8).
    const unprovenModels = [
      ...states.filter((s) => s.status === null && executed.has(s.name)),
      ...editedWithinGrace,
    ].filter((s, i, all) => all.findIndex((o) => o.name === s.name) === i)
    // `nothing-verified` rather than `fresh-build` when the scope emptied out:
    // no touched models at all, or every touched model exempted. Both used to
    // report the same verdict as a genuinely verified build, which is the
    // "zero models checked" observability bug this lane exists to avoid.
    const verdict =
      states.length === 0
        ? touchedPaths.length === 0
          ? "nothing-verified"
          : "exempt-only"
        : !coverageAssertable
          ? "coverage-inconclusive"
          : unprovenModels.length > 0
            ? "build-unproven"
            : "fresh-build"

    const details = {
      ...baseDetails,
      verdict,
      coverage_assertable: coverageAssertable,
      models_verified: states.filter((s) => s.status !== null).length,
      unproven_models: unprovenModels.map((s) => s.name),
      edited_within_grace: editedWithinGrace.map((s) => s.name),
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
    // Node names and dbt messages are repository content and end up inside a
    // synthetic user turn, so they are quoted as data rather than spliced into
    // the instruction text. See `sanitizeForPrompt`.
    if (failedInScope.length > 0) {
      reasonParts.push(
        `${failedInScope.length} node(s) failed in the last build: ${failedInScope.map((r) => `${sanitizeForPrompt(r.name, 80)} (${sanitizeForPrompt(r.status, 40)})`).join(", ")}`,
      )
    }
    if (notBuilt.length > 0) {
      reasonParts.push(
        `${notBuilt.length} model(s) you edited were never built: ${notBuilt.map((s) => sanitizeForPrompt(s.name, 80)).join(", ")}`,
      )
    }
    if (staleBuild.length > 0) {
      reasonParts.push(
        `${staleBuild.length} model(s) were edited after the last build: ${staleBuild.map((s) => sanitizeForPrompt(s.name, 80)).join(", ")}`,
      )
    }

    const hintLines: string[] = []
    for (const failure of failedInScope.slice(0, 10)) {
      const msg = failure.message ? sanitizeForPrompt(failure.message, 200) : ""
      hintLines.push(
        `  • ${sanitizeForPrompt(failure.name, 80)} — ${sanitizeForPrompt(failure.status, 40)}${msg ? `: ${msg}` : ""}`,
      )
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
