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
  findTaskInstructionFiles,
  modelsModifiedSince,
  modelNameFromPath,
  stripSqlComments,
  maskSqlStringLiterals,
  extractJinjaIfBlocks,
  jinjaIfBranchHead,
  dbtConfigArgs,
  sanitizeForPrompt,
} from "./validator-utils"

/** In-model incremental materialisation. */
const INCREMENTAL_RE = /materiali[sz]ed\s*=\s*['"]incremental['"]/i
/** Declared incremental strategy. */
const STRATEGY_RE = /incremental_strategy\s*=\s*['"]([a-z0-9_+]+)['"]/i
/**
 * A `unique_key=` in the config args with a value dbt can actually match rows
 * on. `unique_key=None`, `unique_key=null` and `unique_key=''` are spelled
 * assignments that leave dbt with no key, so they read as absent.
 *
 * The whitespace before the value lives *inside* the lookahead deliberately. A
 * greedy `\s*` outside it can backtrack to zero width once the lookahead
 * matches, so the lookahead is then re-tested against " None" instead of
 * "None", fails to match, and the negative lookahead wrongly succeeds — which
 * made `unique_key = None` (spaced) read as a real key while the unspaced form
 * was correctly rejected.
 */
const UNIQUE_KEY_RE = /unique_key\s*=(?!\s*(?:None|null|''|""|\[\s*\])\s*(?:[,)]|$))/i
/** `unique_key` mentioned anywhere in `dbt_project.yml`. */
const PROJECT_UNIQUE_KEY_RE = /^\s*\+?unique_key\s*:/m
/**
 * The `is_incremental()` guard call.
 *
 * Bounded on the left so a project macro named `my_is_incremental()` — or a
 * namespaced `utils.is_incremental()` — is not mistaken for dbt's builtin and
 * used to block a valid model.
 */
const IS_INCREMENTAL_RE = /(?<![\w.])is_incremental\s*\(\s*\)/i
/**
 * Condition of a Jinja `if` that branches on `is_incremental()`.
 *
 * Matched against the opening tag rather than requiring it to be the whole
 * condition: `{% if is_incremental() and not full_refresh %}` is an ordinary
 * dbt guard, and demanding the bare call hid such a block's predicate from the
 * non-determinism check entirely.
 */
const IS_INCREMENTAL_CONDITION_RE = /(?<![\w.])is_incremental\s*\(\s*\)/i
/**
 * Where a row-selection predicate starts inside a guard body.
 *
 * Two tiers. A real clause keyword is authoritative. A bare `and` / `or` is the
 * fallback for the dominant dbt idiom, where the guard body is a fragment
 * appended to a `where` that lives outside the block — but only when no clause
 * keyword appears anywhere in the arm, because otherwise the `and` inside a
 * projected boolean (`(is_active and random() > 0.5)`) would be taken as the
 * predicate start and turn a deterministic `where` into a blocking finding.
 */
const CLAUSE_START_RE = /\b(?:where|on|having|qualify)\b/i
const CONJUNCTION_START_RE = /\b(?:and|or)\b/i
/**
 * A guard body that OPENS with `and` / `or` is the fragment idiom: the whole
 * arm is the predicate, appended to a `where` outside the block.
 *
 * Checked before `CLAUSE_START_RE`, because a clause keyword can sit inside a
 * nested subquery further along the same fragment
 * (`and ts > (select max(ts) from {{ this }} where ok)`). Slicing from that
 * inner `where` drops the outer high-water-mark comparison, and a clock in it
 * is never seen — the gate passes having examined the wrong half of the
 * predicate. Anchoring keeps the narrowing that motivated the clause tier: an
 * arm that merely PROJECTS `(is_active and random() > 0.5)` does not open with
 * a conjunction, so it still starts at its real `where`.
 */
const LEADING_CONJUNCTION_RE = /^\s*(?:and|or)\b/i
/**
 * `is_incremental()` negated inside the arm's own condition.
 *
 * `{% if not is_incremental() %}` is the valid inverse spelling, and its first
 * arm is the FULL-REFRESH branch. Reading it as the incremental predicate
 * reports a clock that belongs to the initial load as a blocking
 * non-determinism, which rejects a correct model.
 *
 * Such an arm is skipped rather than swapped for its complement: identifying
 * the real incremental branch means evaluating the complement of an arbitrary
 * Jinja condition across `elif` chains, and getting that half-right would turn
 * this miss into a new blocking false positive. Skipping leaves the inverse
 * form unchecked — the same under-fire the gate already has for a model with
 * no guard at all — and takes the false positive away.
 */
const NEGATED_IS_INCREMENTAL_RE = /\bnot\s+(?<![\w.])is_incremental\s*\(\s*\)/i
/**
 * Clock and randomness constructs whose value changes between otherwise
 * identical runs.
 *
 * Split by shape on purpose. The keyword forms are SQL reserved words and
 * cannot plausibly be a bare column; the function forms need a call shape,
 * because `random`, `now` and `rand` are all perfectly ordinary column names
 * and `where random < 0.5` is not a defect.
 *
 * The keyword form additionally refuses a *qualified* reference:
 * `src.current_timestamp` and `"current_timestamp"` name a column on a
 * relation, not the clock, and blocking on one would reject a correct model.
 */
const NONDETERMINISTIC_KEYWORD_RE =
  /(?<![.\w"`\]])(current_timestamp|current_date|localtimestamp|sysdate)\b/gi
const NONDETERMINISTIC_CALL_RE =
  /\b(getdate|now|random|rand|uuid_string|gen_random_uuid|newid)\s*\(/gi
/** The task literally asks for repeatable re-runs. */
const IDEMPOTENCY_RE = /\bidempoten(?:t|ce|cy|tly)\b/i
/**
 * A statement that idempotency is **not** wanted, scoped to the idempotency
 * word itself.
 *
 * Testing the whole line for any negation word was the bug this replaces:
 * "The model must be idempotent and must not depend on the current time" both
 * demands idempotency and contains "not", so the demand was discarded and the
 * missing-guard check never ran. Only a negation that qualifies the
 * idempotency word — before it ("not idempotent", "need not be idempotent") or
 * immediately after it ("idempotency is not required") — disclaims it.
 */
const IDEMPOTENCY_NEGATION_BEFORE_RE =
  /(?:\bnon-?|\b(?:not|never|no|without|isn'?t|aren'?t|doesn'?t|don'?t|need\s+not)\b)(?:\s+\w+){0,2}\s*$/i
const IDEMPOTENCY_NEGATION_AFTER_RE =
  /^\w*\s*(?:(?:is|are|was|were)\s+(?:not|never)|isn'?t|aren'?t|wasn'?t|weren'?t)\b/i

/** Strategies whose semantics require a key to match rows on. */
const KEYED_STRATEGIES = new Set(["merge", "delete+insert"])

/**
 * Incremental strategies whose re-runs converge without an `is_incremental()`
 * guard, because the adapter itself bounds what each run replaces.
 *
 * `insert_overwrite` replaces whole partitions rather than appending, so a
 * re-run rewrites the same partitions with the same rows. `microbatch`
 * (dbt 1.9+) derives its own batch boundaries from `event_time` and
 * `batch_size`. Demanding a guard on either is a false positive on a correct,
 * idiomatic model — and the remediation it prescribes (add a guard, or add a
 * `unique_key`) changes what the model does rather than fixing a defect.
 */
const SELF_IDEMPOTENT_STRATEGIES = new Set(["insert_overwrite", "microbatch"])

/** One inconsistency found in one model. */
interface Finding {
  model: string
  kind: "upsert-without-unique-key" | "missing-is-incremental-guard" | "nondeterministic-predicate"
  detail: string
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
  for (const block of extractJinjaIfBlocks(sql, IS_INCREMENTAL_CONDITION_RE)) {
    if (NEGATED_IS_INCREMENTAL_RE.test(block.opener)) continue
    const incrementalArm = jinjaIfBranchHead(block.body)
    if (LEADING_CONJUNCTION_RE.test(incrementalArm)) {
      parts.push(incrementalArm)
      continue
    }
    const predicateAt =
      CLAUSE_START_RE.exec(incrementalArm) ?? CONJUNCTION_START_RE.exec(incrementalArm)
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
    const m = IDEMPOTENCY_RE.exec(line)
    if (!m) continue
    const before = line.slice(0, m.index)
    const after = line.slice(m.index + m[0].length)
    if (IDEMPOTENCY_NEGATION_BEFORE_RE.test(before)) continue
    if (IDEMPOTENCY_NEGATION_AFTER_RE.test(after)) continue
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

    // Every task document, not just the first readable one — an informational
    // `TASK.md` sitting ahead of the `REQUIREMENTS.md` that states the
    // idempotency demand would otherwise silence the guard check, while the
    // contract-driven gates correctly read past it.
    const tasks = await findTaskInstructionFiles(ctx.workingDirectory, dbtRoot)
    const idempotencyDemanded = tasks.some((t) => demandsIdempotency(t.content))
    // A `unique_key` set in `dbt_project.yml` is inherited by the model, and
    // this lint does not resolve dbt's config inheritance. Rather than report
    // an inconsistency that is not one, the keyed-strategy finding is
    // suppressed for the whole project when the key could come from there.
    const projectKey = await projectDeclaresUniqueKey(dbtRoot)

    const findings: Finding[] = []
    const advisories: Array<{ model: string; functions: string[] }> = []
    let incrementalModels = 0

    // A model we could not read is not a model we checked; see the same
    // tracking in `dbt-dialect-guard`.
    const unreadable: string[] = []
    for (const path of touched) {
      let raw: string
      try {
        raw = await fs.readFile(path, "utf8")
      } catch {
        unreadable.push(modelNameFromPath(path))
        continue
      }
      // Config parsing reads the literals (`materialized='incremental'`), so
      // it runs on comment-stripped source. The non-determinism scan runs on
      // a further copy with literal bodies masked, so a value such as
      // `'now'` in a projected string cannot produce a blocking finding.
      const sql = stripSqlComments(raw)
      const scanSql = maskSqlStringLiterals(sql)
      const args = dbtConfigArgs(sql)
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
      // Masked source, like every other scan here: an `is_incremental()`
      // inside a projected string (`select 'is_incremental()' as note`) is not
      // a guard, and counting it suppresses a real finding.
      const hasGuard = IS_INCREMENTAL_RE.test(scanSql)
      const selfIdempotent = strategy !== null && SELF_IDEMPOTENT_STRATEGIES.has(strategy)
      if (idempotencyDemanded && !hasGuard && !(keyed && hasUniqueKey) && !selfIdempotent) {
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
      models_scanned: touched.length - unreadable.length,
      unreadable_models: unreadable,
      coverage_complete: unreadable.length === 0,
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
      hintLines.push(`Model \`${sanitizeForPrompt(model, 80)}\`:`)
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
      // Model names come from repository filenames and reach a synthetic
      // `role: "user"` turn through dispatch, so they are sanitized exactly as
      // `dbt-build-green` sanitizes node names and artifact paths.
      reason: `${findings.length} incremental-configuration inconsistency(ies) in ${byModel.size} model(s) you edited: ${Array.from(byModel.keys()).map((m) => sanitizeForPrompt(m, 80)).join(", ")}.`,
      fixHint: hintLines.join("\n"),
      details,
    }
  },
}
// altimate_change end
