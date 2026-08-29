// altimate_change start — dialect-guard lint
/**
 * Dialect-guard lint.
 *
 * A project that has to run against more than one warehouse establishes a
 * convention for it: warehouse-specific SQL sits behind a `target.type` Jinja
 * guard (or behind a dispatched macro, which resolves to no raw
 * warehouse-specific function text at all). Sessions routinely reach for a
 * function they know from one warehouse and drop it in unguarded; the model
 * compiles and runs on the development target and breaks everywhere else.
 *
 * This lint flags warehouse-specific function usage in the models the session
 * edited that is not inside a `target.type` guard.
 *
 * It only speaks when the project actually prescribes the convention. Evidence
 * is that `target.type` already appears somewhere under `models/` or
 * `macros/`; alternatively `ALTIMATE_VALIDATORS_DIALECT_GUARD=1` forces it on.
 * A single-warehouse project never sees this validator, because there
 * warehouse-specific SQL is simply correct SQL.
 *
 * Grep-level by design. The function list is curated for precision rather
 * than coverage: only functions whose availability genuinely differs across
 * the warehouses this product targets, matched with a call-shaped pattern so
 * a same-named column cannot trigger them. A project macro that happens to
 * share a name with a listed function is the known residual false positive,
 * which is why the message is advisory and names the guard to add.
 */

import { promises as fs } from "fs"
import { join } from "path"
import type { Validator, ValidatorContext, ValidatorResult } from "../../session/validators/types"
import {
  findDbtProjectRoot,
  modelsModifiedSince,
  modelNameFromPath,
  stripSqlComments,
} from "./validator-utils"

/** Env flag that forces the lint on for a project with no guards yet. */
const OPT_IN_ENV = "ALTIMATE_VALIDATORS_DIALECT_GUARD"

/** One warehouse-specific construct and where it is available. */
interface DialectFunction {
  /** Display name used in the message. */
  name: string
  /** Warehouses that provide it. */
  dialects: string
  /** Call-shaped matcher. */
  pattern: RegExp
}

/**
 * Curated list. Each entry is a construct that is unavailable — or means
 * something different — on at least one warehouse this product targets, so
 * using it unguarded is a portability defect rather than a style choice.
 */
const DIALECT_FUNCTIONS: DialectFunction[] = [
  { name: "iff()", dialects: "Snowflake", pattern: /\biff\s*\(/gi },
  { name: "zeroifnull()", dialects: "Snowflake", pattern: /\bzeroifnull\s*\(/gi },
  { name: "div0()", dialects: "Snowflake", pattern: /\bdiv0\s*\(/gi },
  { name: "nvl2()", dialects: "Snowflake / Redshift", pattern: /\bnvl2\s*\(/gi },
  { name: "try_to_number()", dialects: "Snowflake", pattern: /\btry_to_(?:number|date|timestamp)\s*\(/gi },
  { name: "object_construct()", dialects: "Snowflake", pattern: /\bobject_construct\s*\(/gi },
  { name: "parse_json()", dialects: "Snowflake", pattern: /\bparse_json\s*\(/gi },
  { name: "to_varchar()", dialects: "Snowflake", pattern: /\bto_varchar\s*\(/gi },
  { name: "listagg()", dialects: "Snowflake / Redshift / Oracle", pattern: /\blistagg\s*\(/gi },
  { name: "safe_cast()", dialects: "BigQuery", pattern: /\bsafe_cast\s*\(/gi },
  { name: "safe_divide()", dialects: "BigQuery", pattern: /\bsafe_divide\s*\(/gi },
  { name: "generate_date_array()", dialects: "BigQuery", pattern: /\bgenerate_date_array\s*\(/gi },
  { name: "approx_quantiles()", dialects: "BigQuery", pattern: /\bapprox_quantiles\s*\(/gi },
  { name: "_TABLE_SUFFIX", dialects: "BigQuery", pattern: /\b_table_suffix\b/gi },
  { name: "read_csv_auto()", dialects: "DuckDB", pattern: /\bread_csv_auto\s*\(/gi },
  { name: "read_parquet()", dialects: "DuckDB", pattern: /\bread_parquet\s*\(/gi },
  { name: "list_transform()", dialects: "DuckDB", pattern: /\blist_(?:transform|aggregate|value)\s*\(/gi },
  { name: "epoch_ms()", dialects: "DuckDB", pattern: /\bepoch_ms\s*\(/gi },
  { name: "getdate()", dialects: "Redshift / SQL Server", pattern: /\bgetdate\s*\(/gi },
]

/** A Jinja `if` whose condition mentions `target.type`, through its `endif`. */
const TARGET_TYPE_GUARD_RE = /\{%-?\s*if\b[^%]*target\.type[\s\S]*?\{%-?\s*endif\s*-?%\}/gi
/** Bare mention of the guard variable, used as the project-convention probe. */
const TARGET_TYPE_RE = /target\.type/i

/** Depth limit mirroring the other project scans in this lane. */
const SCAN_MAX_DEPTH = 8

/** One unguarded construct in one model. */
interface Finding {
  model: string
  function: string
  dialects: string
}

/**
 * True when the project already guards on `target.type` anywhere under
 * `models/` or `macros/` — the evidence that this project prescribes the
 * convention this lint enforces.
 */
async function projectPrescribesGuards(dbtRoot: string): Promise<boolean> {
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
      } else if (stat.isFile() && entry.name.toLowerCase().endsWith(".sql")) {
        try {
          if (TARGET_TYPE_RE.test(await fs.readFile(full, "utf8"))) return true
        } catch {
          // unreadable — keep scanning
        }
      }
    }
    return false
  }
  for (const dir of ["models", "macros"]) {
    if (await scan(join(dbtRoot, dir), 0)) return true
  }
  return false
}

/** Blank out every `target.type`-guarded Jinja block. */
function stripGuardedBlocks(sql: string): string {
  return sql.replace(TARGET_TYPE_GUARD_RE, (m) => " ".repeat(m.length))
}

export const DbtDialectGuardValidator: Validator = {
  name: "dbt-dialect-guard",
  description:
    "After the agent declares done, flags warehouse-specific SQL functions used in the models the session edited without the project's prescribed `target.type` Jinja guard. Only active in projects that already establish the guard convention.",

  async appliesTo(ctx: ValidatorContext): Promise<boolean> {
    const dbtRoot = await findDbtProjectRoot(ctx.workingDirectory)
    if (!dbtRoot) return false
    if (process.env[OPT_IN_ENV] === "1") return true
    return await projectPrescribesGuards(dbtRoot)
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

    const findings: Finding[] = []
    for (const path of touched) {
      let raw: string
      try {
        raw = await fs.readFile(path, "utf8")
      } catch {
        continue
      }
      const sql = stripGuardedBlocks(stripSqlComments(raw))
      const model = modelNameFromPath(path)
      for (const fn of DIALECT_FUNCTIONS) {
        fn.pattern.lastIndex = 0
        if (fn.pattern.test(sql)) {
          findings.push({ model, function: fn.name, dialects: fn.dialects })
        }
      }
    }

    const details = {
      models_touched: touched.length,
      findings,
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
      for (const f of list) hintLines.push(`  • ${f.function} — ${f.dialects} only`)
    }
    hintLines.push("")
    hintLines.push(
      "This project guards warehouse-specific SQL on `target.type`. Either put the call behind that guard with a portable branch for the other targets:",
    )
    hintLines.push(
      "    {% if target.type == 'snowflake' %} … {% else %} … {% endif %}",
    )
    hintLines.push(
      "or replace it with the portable equivalent (`case when` for conditionals, `coalesce` for null handling, `cast` for conversions), or move the branch into a dispatched macro. If the name is a project macro rather than the warehouse builtin, no change is needed.",
    )

    return {
      ok: false,
      reason: `${findings.length} unguarded warehouse-specific construct(s) in ${byModel.size} model(s) you edited: ${Array.from(byModel.keys()).join(", ")}.`,
      fixHint: hintLines.join("\n"),
      details,
    }
  },
}
// altimate_change end
