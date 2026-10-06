// altimate_change start — dbt schema-verify validator (harness-side enforcement)
/**
 * dbt schema-verify validator.
 *
 * Fires after the agent declares done. Detects whether the session touched
 * any dbt models, runs `altimate-dbt schema-verify` against each touched
 * model, and reports the disagreements between the built table and the YAML
 * that declares its columns that dbt's own semantics establish as problems:
 * an enforced contract that the table does not match, or a declared column
 * that has tests attached but is not produced.
 *
 * It deliberately says nothing about columns the model produces that the YAML
 * does not list (YAML commonly documents only some columns), and never tells
 * the agent to remove or add columns. See `packages/dbt-tools/src/commands/
 * schema-verify.ts` for the rule.
 *
 * The agent does not see this validator existing — it runs in the harness
 * AFTER `finishReason === "stop"`. Its output is surfaced to the agent only
 * if there is a mismatch, via a synthetic user message the framework injects
 * to force one more turn. This is the only enforcement layer not bypassable
 * by the agent — see types.ts header for the rationale.
 */

import { spawn } from "child_process"
import type { Validator, ValidatorContext, ValidatorResult } from "../../session/validators/types"
import {
  VALIDATOR_TIMEOUT_MS,
  VALIDATOR_CONCURRENCY,
  findDbtProjectRoot,
  modelsModifiedSince,
  modelNameFromPath,
  extractLastJsonObject,
  runWithConcurrencyLimit,
  retryErroredSerially,
} from "./validator-utils"

interface SchemaVerifyFinding {
  kind?: string
  columns?: string[]
  /** Which YAML declares what, and why it is a problem. Written by altimate-dbt. */
  evidence?: string
}

interface SchemaVerifyOutput {
  model?: string
  verdict?: "match" | "mismatch" | "no-spec"
  /** Present from the altimate-dbt that classifies findings; absent from older builds. */
  findings?: SchemaVerifyFinding[]
  notes?: string[]
  columns_extra?: string[]
  columns_missing?: string[]
  columns_reordered?: unknown[]
  type_mismatches?: unknown[]
  error?: string
}

/**
 * Established problems for one result. Only `findings` count: the raw
 * extra/missing/reordered/type lists are an unfiltered diff against the YAML
 * and prove nothing on their own. An older altimate-dbt that does not emit
 * `findings` cannot say whether a contract or a test is involved, so its
 * "mismatch" verdict is not treated as established.
 */
function establishedFindings(r: SchemaVerifyOutput): SchemaVerifyFinding[] {
  return r.verdict === "mismatch" && Array.isArray(r.findings) ? r.findings.filter((f) => f.evidence) : []
}

/**
 * Extract a SchemaVerifyOutput JSON object from mixed stdout.
 * `altimate-dbt schema-verify` may emit dbt log noise (ANSI codes, parser
 * warnings) before the verdict JSON. Delegates to the shared
 * extractLastJsonObject utility which already handles noisy stdout and
 * validates the envelope shape.
 */
function parseSchemaVerifyOutput(stdout: string): SchemaVerifyOutput | null {
  const obj = extractLastJsonObject(stdout)
  if (!obj) return null
  return obj as SchemaVerifyOutput
}

/**
 * Run `altimate-dbt schema-verify --model <name>` and parse its JSON output.
 *
 * Times out after ALTIMATE_VALIDATORS_TIMEOUT_MS (default 60 s) and kills the
 * subprocess to prevent the agent loop from hanging indefinitely on stalled
 * warehouse connections or DuckDB file-lock contention.
 *
 * Returns null on spawn failure so the caller can track it separately.
 */
async function runSchemaVerify(model: string, cwd: string): Promise<SchemaVerifyOutput | null> {
  const debug = process.env.ALTIMATE_VALIDATORS_DEBUG === "1"
  return new Promise((resolve) => {
    const child = spawn("altimate-dbt", ["schema-verify", "--model", model], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ error: `timed out after ${VALIDATOR_TIMEOUT_MS}ms` })
    }, VALIDATOR_TIMEOUT_MS)
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr.on("data", (chunk) => (stderr += String(chunk)))
    child.on("error", (e) => {
      clearTimeout(timer)
      if (debug) {
        // eslint-disable-next-line no-console
        console.error(
          "[altimate-validators] " +
            JSON.stringify({ kind: "spawn_error", model, message: e.message }),
        )
      }
      resolve(null)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (debug) {
        // eslint-disable-next-line no-console
        console.error(
          "[altimate-validators] " +
            JSON.stringify({
              kind: "spawn_close",
              model,
              code,
              stdoutLen: stdout.length,
              stderrLen: stderr.length,
              stdoutHead: stdout.slice(0, 400),
              stderrHead: stderr.slice(0, 400),
            }),
        )
      }
      const parsed = parseSchemaVerifyOutput(stdout)
      if (parsed) {
        resolve(parsed)
      } else if (stderr) {
        resolve({ error: stderr.slice(0, 500) })
      } else if (stdout) {
        resolve({ error: `non-json stdout: ${stdout.slice(-400)}` })
      } else {
        resolve(null)
      }
    })
  })
}

/**
 * Format established findings. States the evidence (which YAML declares what)
 * and leaves the decision to the agent: no instruction to add, remove or
 * reorder anything, because an absence alone never says which side is wrong.
 */
function formatFixHint(mismatches: SchemaVerifyOutput[]): string {
  const lines: string[] = []
  for (const m of mismatches) {
    if (!m.model) continue
    lines.push(`Model \`${m.model}\`:`)
    for (const f of establishedFindings(m)) lines.push(`  • ${f.evidence}`)
  }
  return lines.join("\n")
}

export const DbtSchemaVerifyValidator: Validator = {
  name: "dbt-schema-verify",
  description:
    "After the agent declares done, runs `altimate-dbt schema-verify` on every dbt model the agent modified during this session and refuses to terminate if the built table contradicts its YAML in a way dbt itself treats as an error: an enforced contract the columns do not match, or a declared column with tests attached that the model does not produce. Columns the model produces that the YAML does not list are not reported.",

  async appliesTo(ctx: ValidatorContext): Promise<boolean> {
    // Only run for sessions that took place inside a dbt project. Quick check.
    return (await findDbtProjectRoot(ctx.workingDirectory)) !== null
  },

  async check(ctx: ValidatorContext): Promise<ValidatorResult> {
    const startedAt = Date.now()
    const dbtRoot = await findDbtProjectRoot(ctx.workingDirectory)
    if (!dbtRoot)
      return {
        ok: true,
        details: {
          models_touched: 0,
          dbt_root: null,
          session_id: ctx.sessionID,
          elapsed_ms: Date.now() - startedAt,
        },
      }

    const touched = await modelsModifiedSince(dbtRoot, ctx.sessionStartMs)
    if (touched.length === 0) {
      // No models touched — nothing to verify.
      return {
        ok: true,
        details: {
          models_touched: 0,
          dbt_root: dbtRoot,
          session_id: ctx.sessionID,
          elapsed_ms: Date.now() - startedAt,
        },
      }
    }

    // Run schema-verify calls with a bounded concurrency limit to prevent
    // resource contention from too many simultaneous dbt processes.
    let spawnFailures = 0
    const parallel = await runWithConcurrencyLimit(
      touched,
      (path) => runSchemaVerify(modelNameFromPath(path), dbtRoot),
      VALIDATOR_CONCURRENCY,
    )
    // An error from a parallel run may be the processes contending for the warehouse
    // (single-writer DuckDB), not a fact about the model: retry those one at a time.
    const { outputs, retried } = await retryErroredSerially(
      touched,
      parallel,
      (path) => runSchemaVerify(modelNameFromPath(path), dbtRoot),
      (o) => (o.verdict ? undefined : o.error),
    )
    const results: SchemaVerifyOutput[] = []
    for (let i = 0; i < outputs.length; i++) {
      const out = outputs[i]!
      const name = modelNameFromPath(touched[i]!)
      if (out !== null) {
        results.push({ ...out, model: out.model ?? name })
      } else {
        spawnFailures++
        // Track spawn failures as errored results so they appear in telemetry
        // and detail counts rather than being silently dropped (fails open).
        results.push({ model: name, error: "spawn failed: subprocess did not start" })
      }
    }

    const mismatches = results.filter((r) => establishedFindings(r).length > 0)
    const noSpec = results.filter((r) => r.verdict === "no-spec").length
    // "match" or a mismatch verdict with nothing established (nothing to act on).
    const matches = results.filter((r) => !r.error && (r.verdict === "match" || r.verdict === "mismatch") && establishedFindings(r).length === 0).length
    const unestablished = results.filter((r) => !r.error && r.verdict === "mismatch" && establishedFindings(r).length === 0).length
    const errored = results.filter((r) => r.error).length

    const baseDetails = {
      models_touched: touched.length,
      verified: results.length,
      match: matches,
      no_spec: noSpec,
      // Results whose raw diff differs from the YAML but where nothing is established
      // (unlisted columns, untested declared-but-absent columns). Telemetry only.
      diff_not_established: unestablished,
      errored,
      retried_serially: retried,
      spawn_failures: spawnFailures,
      dbt_root: dbtRoot,
      session_id: ctx.sessionID,
      concurrency_limit: VALIDATOR_CONCURRENCY,
      elapsed_ms: Date.now() - startedAt,
    }

    // Fail closed: return ok only when every model was verified and none mismatched.
    // Errors (spawn failures, schema-verify tool errors) prevent a clean pass because
    // we cannot rule out drift on models we failed to inspect.
    if (mismatches.length === 0 && errored === 0) {
      return { ok: true, details: baseDetails }
    }

    const mismatchNames = mismatches.map((m) => m.model).filter(Boolean) as string[]
    // altimate_change start — surface the affected model names in the errored-path
    // reason too (not just the mismatch path). The errored results carry `.model`
    // (set at push time), so the operator can see WHICH models couldn't be verified
    // instead of an anonymous count.
    const erroredNames = results.filter((r) => r.error).map((r) => r.model).filter(Boolean) as string[]
    // The cause, not just a count: the first error, trimmed to one line.
    const firstError = results.find((r) => r.error)?.error?.replace(/\s+/g, " ").trim().slice(0, 240)
    const reason =
      mismatches.length > 0
        ? `${mismatches.length} of ${results.length} models you edited contradict the YAML that declares their columns${mismatchNames.length ? `: ${mismatchNames.join(", ")}` : ""}.`
        : `${errored} model(s) could not be schema-verified (spawn or tool errors)${erroredNames.length ? `: ${erroredNames.join(", ")}` : ""} — schema drift cannot be ruled out${firstError ? ` (first error: ${firstError})` : ""}. Investigate before declaring done.`
    // altimate_change end

    return {
      ok: false,
      reason,
      fixHint:
        mismatches.length > 0
          ? formatFixHint(mismatches) +
            `\n\nThese are facts about the built table and the YAML, not a verdict on which side is wrong: change the model if the YAML is right, or the YAML if its entry is stale. A column the model produces that the YAML does not list is not an error unless a contract is enforced.`
          : `Run \`altimate-dbt schema-verify <model>\` manually to diagnose the error. Check that altimate-dbt is on PATH and that the dbt project compiles cleanly.`,
      details: {
        ...baseDetails,
        mismatch: mismatches.length,
        mismatch_models: mismatchNames,
        // altimate_change: expose errored model names alongside mismatch names
        errored_models: erroredNames,
      },
    }
  },
}
// altimate_change end
