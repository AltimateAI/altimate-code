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
import { join } from "path"
import type { Validator, ValidatorContext, ValidatorResult } from "../../session/validators/types"
import {
  findDbtProjectRoot,
  findTaskInstructionFile,
  modelsModifiedSince,
  modelNameFromPath,
  stripSqlComments,
  maskSqlStringLiterals,
} from "./validator-utils"

/** `{{ config(...) }}` call, capturing its argument text. */
const CONFIG_CALL_RE = /\{\{-?\s*config\s*\(([\s\S]*?)\)\s*-?\}\}/gi
/** In-model incremental materialisation. */
const INCREMENTAL_RE = /materiali[sz]ed\s*=\s*['"]incremental['"]/i
/** Declared incremental strategy. */
const STRATEGY_RE = /incremental_strategy\s*=\s*['"]([a-z0-9_+]+)['"]/i
/**
 * A `unique_key=` in the config args with a value dbt can actually match rows
 * on. `unique_key=None`, `unique_key=null` and `unique_key=''` are spelled
 * assignments that leave dbt with no key, so they read as absent.
 */
const UNIQUE_KEY_RE = /unique_key\s*=\s*(?!(?:None|null|''|""|\[\s*\])\s*(?:[,)]|$))/i
/** `unique_key` mentioned anywhere in `dbt_project.yml`. */
const PROJECT_UNIQUE_KEY_RE = /^\s*\+?unique_key\s*:/m
/** The `is_incremental()` guard call. */
const IS_INCREMENTAL_RE = /is_incremental\s*\(\s*\)/i
/** Body of the first `{% if is_incremental() %} … {% endif %}` block. */
const IS_INCREMENTAL_BLOCK_RE =
  /\{%-?\s*if\s+is_incremental\s*\(\s*\)\s*-?%\}([\s\S]*?)\{%-?\s*endif\s*-?%\}/gi
/** Start of the `{% else %}` / `{% elif %}` arm — the full-refresh branch. */
const ELSE_ARM_RE = /\{%-?\s*el(?:se|if)\b/i
/** Where a row-selection predicate starts inside a guard body. */
const PREDICATE_START_RE = /\b(?:where|and|or|on|having|qualify)\b/i
/**
 * Clock and randomness constructs whose value changes between otherwise
 * identical runs.
 *
 * Split by shape on purpose. The keyword forms are SQL reserved words and
 * cannot plausibly be a column; the function forms need a call shape, because
 * `random`, `now` and `rand` are all perfectly ordinary column names and
 * `where random < 0.5` is not a defect.
 */
const NONDETERMINISTIC_KEYWORD_RE =
  /\b(current_timestamp|current_date|localtimestamp|sysdate)\b/gi
const NONDETERMINISTIC_CALL_RE =
  /\b(getdate|now|random|rand|uuid_string|gen_random_uuid|newid)\s*\(/gi
/** The task literally asks for repeatable re-runs. */
const IDEMPOTENCY_RE = /\bidempoten(?:t|ce|cy|tly)\b/i
/**
 * Negation in the same clause as the idempotency word. "Idempotency is not
 * required" must not switch the guard check on.
 */
const IDEMPOTENCY_NEGATION_RE = /\b(?:not|no|never|without|isn't|aren't|un)\b/i

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

/**
 * Concatenate the **row-selection predicates** of every `is_incremental()`
 * guard block.
 *
 * Two narrowings, both there to keep the blocking finding on the thing it
 * claims to be about:
 *
 *   - The `{% else %}` / `{% elif %}` arm is the full-refresh branch. A clock
 *     call there belongs to the initial load and says nothing about whether
 *     incremental runs are reproducible.
 *   - Only the part of the incremental arm from the first `where`/`and`/`on`
 *     onwards is a predicate. A guard body that conditionally *projects*
 *     `current_timestamp as loaded_at` does not make row selection vary, and
 *     is left to the advisory list.
 */
function incrementalPredicates(sql: string): string {
  const parts: string[] = []
  IS_INCREMENTAL_BLOCK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IS_INCREMENTAL_BLOCK_RE.exec(sql)) !== null) {
    const body = m[1]
    if (!body) continue
    const elseAt = ELSE_ARM_RE.exec(body)
    const incrementalArm = elseAt ? body.slice(0, elseAt.index) : body
    const predicateAt = PREDICATE_START_RE.exec(incrementalArm)
    if (predicateAt) parts.push(incrementalArm.slice(predicateAt.index))
  }
  return parts.join("\n")
}

/** Distinct non-deterministic constructs appearing in a fragment. */
function nondeterministicCalls(fragment: string): string[] {
  const out = new Set<string>()
  for (const re of [NONDETERMINISTIC_KEYWORD_RE, NONDETERMINISTIC_CALL_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(fragment)) !== null) {
      if (m[1]) out.add(m[1].toLowerCase())
    }
  }
  return Array.from(out)
}

/** True when the task asks for idempotent re-runs and does not disclaim it. */
function demandsIdempotency(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (!IDEMPOTENCY_RE.test(line)) continue
    if (IDEMPOTENCY_NEGATION_RE.test(line)) continue
    return true
  }
  return false
}

/** True when `dbt_project.yml` configures a `unique_key` this lint cannot resolve. */
async function projectDeclaresUniqueKey(dbtRoot: string): Promise<boolean> {
  try {
    return PROJECT_UNIQUE_KEY_RE.test(await fs.readFile(join(dbtRoot, "dbt_project.yml"), "utf8"))
  } catch {
    return false
  }
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
    const idempotencyDemanded = task !== null && demandsIdempotency(task.content)
    // A `unique_key` set in `dbt_project.yml` is inherited by the model, and
    // this lint does not resolve dbt's config inheritance. Rather than report
    // an inconsistency that is not one, the keyed-strategy finding is
    // suppressed for the whole project when the key could come from there.
    const projectKey = await projectDeclaresUniqueKey(dbtRoot)

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
      // Config parsing reads the literals (`materialized='incremental'`), so
      // it runs on comment-stripped source. The non-determinism scan runs on
      // a further copy with literal bodies masked, so a value such as
      // `'now'` in a projected string cannot produce a blocking finding.
      const sql = stripSqlComments(raw)
      const scanSql = maskSqlStringLiterals(sql)
      const args = configArgs(sql)
      if (!INCREMENTAL_RE.test(args)) continue
      incrementalModels++
      const model = modelNameFromPath(path)

      const strategyMatch = STRATEGY_RE.exec(args)
      const strategy = strategyMatch?.[1]?.toLowerCase() ?? null
      const keyed = strategy !== null && KEYED_STRATEGIES.has(strategy)
      const hasUniqueKey = UNIQUE_KEY_RE.test(args) || projectKey
      if (keyed && !hasUniqueKey) {
        findings.push({
          model,
          kind: "upsert-without-unique-key",
          detail: `\`incremental_strategy='${strategy}'\` declares upsert semantics but no \`unique_key\` is configured, so dbt has nothing to match rows on and every run appends instead of updating.`,
        })
      }

      // A keyed upsert re-runs idempotently even without a guard: the merge
      // matches on the key rather than appending, so a full re-scan converges
      // on the same table. Only a guardless model with no such key can
      // duplicate rows on re-run.
      const hasGuard = IS_INCREMENTAL_RE.test(sql)
      if (idempotencyDemanded && !hasGuard && !(keyed && hasUniqueKey)) {
        findings.push({
          model,
          kind: "missing-is-incremental-guard",
          detail:
            "The task asks for idempotent re-runs, but this incremental model has no `is_incremental()` guard, so a re-run reprocesses the full source into an existing table.",
        })
      }

      const predicate = incrementalPredicates(scanSql)
      const predicateCalls = nondeterministicCalls(predicate)
      if (predicateCalls.length > 0) {
        findings.push({
          model,
          kind: "nondeterministic-predicate",
          detail: `The \`is_incremental()\` predicate uses ${predicateCalls.join(", ")}, so each run selects a different row set and the model cannot reproduce its own output.`,
        })
      }

      const elsewhere = nondeterministicCalls(scanSql).filter((f) => !predicateCalls.includes(f))
      if (elsewhere.length > 0) advisories.push({ model, functions: elsewhere })
    }

    const details = {
      models_touched: touched.length,
      incremental_models: incrementalModels,
      idempotency_demanded: idempotencyDemanded,
      findings: findings.map((f) => ({ model: f.model, kind: f.kind })),
      advisories,
      project_unique_key: projectKey,
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
