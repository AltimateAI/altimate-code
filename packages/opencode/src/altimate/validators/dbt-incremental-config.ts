// altimate_change start — incremental-config consistency lint
/**
 * Incremental-config lint.
 *
 * dbt's incremental materialisation is legitimately flexible: append-only
 * models are normal, keyless models are normal, and a non-deterministic
 * expression in a projected column is normal. So this lint does not flag
 * *absences* — it flags **inconsistencies**, configurations that contradict
 * themselves and therefore cannot be what the author meant:
 *
 *   1. Upsert semantics declared without a key. `incremental_strategy='merge'`
 *      or `'delete+insert'` need a `unique_key` to match rows on. Without one
 *      dbt cannot upsert, and the model silently degrades to appending
 *      duplicates on every run.
 *   2. No `is_incremental()` guard in a model whose task demands idempotent
 *      re-runs. Only raised when the workspace task document literally says
 *      idempotent/idempotency — otherwise dbt's full-refresh-every-run
 *      behaviour is a valid choice and the lint stays quiet.
 *   3. A non-deterministic function inside the `is_incremental()` predicate.
 *      A high-water mark computed from `current_timestamp` / `random()`
 *      selects a different row set on every run, so the model is not
 *      reproducible by construction. The same functions elsewhere in the
 *      model (an `updated_at` audit column, say) are recorded for telemetry
 *      but never block.
 *
 * Grep-level over the model source with comments stripped. Config declared in
 * `dbt_project.yml` rather than in the model is intentionally not resolved:
 * that would require materialising dbt's config inheritance, and guessing it
 * would trade a real inconsistency check for false failures.
 */

import { promises as fs } from "fs"
import type { Validator, ValidatorContext, ValidatorResult } from "../../session/validators/types"
import {
  findDbtProjectRoot,
  findTaskInstructionFile,
  modelsModifiedSince,
  modelNameFromPath,
  stripSqlComments,
} from "./validator-utils"

/** `{{ config(...) }}` call, capturing its argument text. */
const CONFIG_CALL_RE = /\{\{-?\s*config\s*\(([\s\S]*?)\)\s*-?\}\}/gi
/** In-model incremental materialisation. */
const INCREMENTAL_RE = /materiali[sz]ed\s*=\s*['"]incremental['"]/i
/** Declared incremental strategy. */
const STRATEGY_RE = /incremental_strategy\s*=\s*['"]([a-z0-9_+]+)['"]/i
/** Any `unique_key=` in the config args. */
const UNIQUE_KEY_RE = /unique_key\s*=/i
/** The `is_incremental()` guard call. */
const IS_INCREMENTAL_RE = /is_incremental\s*\(\s*\)/i
/** Body of the first `{% if is_incremental() %} … {% endif %}` block. */
const IS_INCREMENTAL_BLOCK_RE =
  /\{%-?\s*if\s+is_incremental\s*\(\s*\)\s*-?%\}([\s\S]*?)\{%-?\s*endif\s*-?%\}/gi
/** Functions whose value changes between otherwise identical runs. */
const NONDETERMINISTIC_RE =
  /\b(current_timestamp|current_date|localtimestamp|getdate|sysdate|now|random|rand|uuid_string|gen_random_uuid|newid)\b/gi
/** The task literally asks for repeatable re-runs. */
const IDEMPOTENCY_RE = /\bidempoten(?:t|cy|tly)\b/i

/** Strategies whose semantics require a key to match rows on. */
const KEYED_STRATEGIES = new Set(["merge", "delete+insert"])

/** One inconsistency found in one model. */
interface Finding {
  model: string
  kind: "upsert-without-unique-key" | "missing-is-incremental-guard" | "nondeterministic-predicate"
  detail: string
}

/** Concatenate the argument text of every `{{ config() }}` call in a model. */
function configArgs(sql: string): string {
  const parts: string[] = []
  CONFIG_CALL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CONFIG_CALL_RE.exec(sql)) !== null) {
    if (m[1]) parts.push(m[1])
  }
  return parts.join("\n")
}

/** Concatenate the bodies of every `is_incremental()` guard block. */
function incrementalPredicates(sql: string): string {
  const parts: string[] = []
  IS_INCREMENTAL_BLOCK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IS_INCREMENTAL_BLOCK_RE.exec(sql)) !== null) {
    if (m[1]) parts.push(m[1])
  }
  return parts.join("\n")
}

/** Distinct non-deterministic function names appearing in a fragment. */
function nondeterministicCalls(fragment: string): string[] {
  const out = new Set<string>()
  NONDETERMINISTIC_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = NONDETERMINISTIC_RE.exec(fragment)) !== null) {
    if (m[1]) out.add(m[1].toLowerCase())
  }
  return Array.from(out)
}

export const DbtIncrementalConfigValidator: Validator = {
  name: "dbt-incremental-config",
  description:
    "After the agent declares done, lints the incremental models the session edited for self-contradictory configuration: upsert semantics declared without a unique_key, a missing is_incremental() guard where the task demands idempotent re-runs, and non-deterministic functions inside the incremental predicate.",

  async appliesTo(ctx: ValidatorContext): Promise<boolean> {
    return (await findDbtProjectRoot(ctx.workingDirectory)) !== null
  },

  async check(ctx: ValidatorContext): Promise<ValidatorResult> {
    const startedAt = Date.now()
    const dbtRoot = await findDbtProjectRoot(ctx.workingDirectory)
    if (!dbtRoot) {
      return { ok: true, details: { skipped: "no dbt project", session_id: ctx.sessionID } }
    }
    const touched = await modelsModifiedSince(dbtRoot, ctx.sessionStartMs)
    if (touched.length === 0) {
      return { ok: true, details: { models_touched: 0, session_id: ctx.sessionID } }
    }

    const task = await findTaskInstructionFile(ctx.workingDirectory, dbtRoot)
    const idempotencyDemanded = task !== null && IDEMPOTENCY_RE.test(task.content)

    const findings: Finding[] = []
    const advisories: Array<{ model: string; functions: string[] }> = []
    let incrementalModels = 0

    for (const path of touched) {
      let raw: string
      try {
        raw = await fs.readFile(path, "utf8")
      } catch {
        continue
      }
      const sql = stripSqlComments(raw)
      const args = configArgs(sql)
      if (!INCREMENTAL_RE.test(args)) continue
      incrementalModels++
      const model = modelNameFromPath(path)

      const strategyMatch = STRATEGY_RE.exec(args)
      const strategy = strategyMatch?.[1]?.toLowerCase() ?? null
      if (strategy && KEYED_STRATEGIES.has(strategy) && !UNIQUE_KEY_RE.test(args)) {
        findings.push({
          model,
          kind: "upsert-without-unique-key",
          detail: `\`incremental_strategy='${strategy}'\` declares upsert semantics but no \`unique_key\` is configured, so dbt has nothing to match rows on and every run appends instead of updating.`,
        })
      }

      const hasGuard = IS_INCREMENTAL_RE.test(sql)
      if (idempotencyDemanded && !hasGuard) {
        findings.push({
          model,
          kind: "missing-is-incremental-guard",
          detail:
            "The task asks for idempotent re-runs, but this incremental model has no `is_incremental()` guard, so a re-run reprocesses the full source into an existing table.",
        })
      }

      const predicate = incrementalPredicates(sql)
      const predicateCalls = nondeterministicCalls(predicate)
      if (predicateCalls.length > 0) {
        findings.push({
          model,
          kind: "nondeterministic-predicate",
          detail: `The \`is_incremental()\` predicate uses ${predicateCalls.join(", ")}, so each run selects a different row set and the model cannot reproduce its own output.`,
        })
      }

      const elsewhere = nondeterministicCalls(sql).filter((f) => !predicateCalls.includes(f))
      if (elsewhere.length > 0) advisories.push({ model, functions: elsewhere })
    }

    const details = {
      models_touched: touched.length,
      incremental_models: incrementalModels,
      idempotency_demanded: idempotencyDemanded,
      findings: findings.map((f) => ({ model: f.model, kind: f.kind })),
      advisories,
      dbt_root: dbtRoot,
      session_id: ctx.sessionID,
      elapsed_ms: Date.now() - startedAt,
    }

    if (findings.length === 0) return { ok: true, details }

    const byModel = new Map<string, Finding[]>()
    for (const f of findings) {
      const list = byModel.get(f.model) ?? []
      list.push(f)
      byModel.set(f.model, list)
    }
    const hintLines: string[] = []
    for (const [model, list] of byModel) {
      hintLines.push(`Model \`${model}\`:`)
      for (const f of list) hintLines.push(`  • ${f.detail}`)
    }
    hintLines.push("")
    hintLines.push(
      "These are configuration inconsistencies, not style rules — dbt supports append-only and keyless incremental models, so fix the contradiction rather than adding boilerplate:",
    )
    hintLines.push(
      "  • Upsert without a key: add `unique_key=` naming the grain, or state the intent by setting `incremental_strategy='append'`.",
    )
    hintLines.push(
      "  • Missing guard: wrap the incremental filter in `{% if is_incremental() %} … {% endif %}` so a re-run only picks up new rows.",
    )
    hintLines.push(
      "  • Non-deterministic predicate: compare against a value read from the existing table (`select max(col) from {{ this }}`) instead of a clock or random call.",
    )

    return {
      ok: false,
      reason: `${findings.length} incremental-configuration inconsistency(ies) in ${byModel.size} model(s) you edited: ${Array.from(byModel.keys()).join(", ")}.`,
      fixHint: hintLines.join("\n"),
      details,
    }
  },
}
// altimate_change end
