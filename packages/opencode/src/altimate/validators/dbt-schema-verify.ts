// altimate_change start — dbt schema-verify validator (harness-side enforcement)
/**
 * dbt schema-verify validator.
 *
 * Fires after the agent declares done. Detects whether the session touched
 * any dbt models, runs `altimate-dbt schema-verify` against each touched
 * model, and reports a mismatch if the produced column shape diverges from
 * the schema.yml spec.
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
} from "./validator-utils"

interface SchemaVerifyOutput {
  model?: string
  verdict?: "match" | "mismatch" | "no-spec"
  columns_extra?: string[]
  columns_missing?: string[]
  columns_reordered?: unknown[]
  type_mismatches?: unknown[]
  error?: string
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

/** Format a list of mismatches into a single concise synthetic-message block. */
function formatFixHint(mismatches: SchemaVerifyOutput[]): string {
  const lines: string[] = []
  for (const m of mismatches) {
    if (!m.model) continue
    lines.push(`Model \`${m.model}\`:`)
    if (m.columns_extra && m.columns_extra.length > 0) {
      lines.push(`  • Columns in your model NOT in spec — REMOVE: ${m.columns_extra.join(", ")}`)
    }
    if (m.columns_missing && m.columns_missing.length > 0) {
      lines.push(`  • Columns in spec NOT in your model — ADD: ${m.columns_missing.join(", ")}`)
    }
    if (m.columns_reordered && m.columns_reordered.length > 0) {
      lines.push(`  • Columns in wrong order — REORDER the SELECT to match schema.yml`)
    }
    if (m.type_mismatches && m.type_mismatches.length > 0) {
      lines.push(`  • Type mismatches — CAST or change the upstream source`)
    }
  }
  return lines.join("\n")
}

export const DbtSchemaVerifyValidator: Validator = {
  name: "dbt-schema-verify",
  description:
    "After the agent declares done, runs `altimate-dbt schema-verify` on every dbt model the agent modified during this session and refuses to terminate if any model's actual columns diverge from the schema.yml spec (extra, missing, reordered, or type-mismatched).",

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
    const outputs = await runWithConcurrencyLimit(
      touched,
      (path) => runSchemaVerify(modelNameFromPath(path), dbtRoot),
      VALIDATOR_CONCURRENCY,
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

    const mismatches = results.filter((r) => r.verdict === "mismatch")
    const noSpec = results.filter((r) => r.verdict === "no-spec").length
    const matches = results.filter((r) => r.verdict === "match").length
    const errored = results.filter((r) => r.error).length

    const baseDetails = {
      models_touched: touched.length,
      verified: results.length,
      match: matches,
      no_spec: noSpec,
      errored,
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
    const reason =
      mismatches.length > 0
        ? `${mismatches.length} of ${results.length} models you edited have a column-shape mismatch against schema.yml${mismatchNames.length ? `: ${mismatchNames.join(", ")}` : ""}. The build may be green, but equality tests will fail.`
        : `${errored} model(s) could not be schema-verified (spawn or tool errors) — schema drift cannot be ruled out. Investigate before declaring done.`

    return {
      ok: false,
      reason,
      fixHint:
        mismatches.length > 0
          ? formatFixHint(mismatches) +
            `\n\nFix the model SQL to match the schema.yml spec (do not edit the spec), rebuild, and the harness will re-check before declaring done.`
          : `Run \`altimate-dbt schema-verify <model>\` manually to diagnose the error. Check that altimate-dbt is on PATH and that the dbt project compiles cleanly.`,
      details: {
        ...baseDetails,
        mismatch: mismatches.length,
        mismatch_models: mismatchNames,
      },
    }
  },
}
// altimate_change end
