import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { SqlExplainResult } from "../native/types"

/**
 * Detect SQL input that cannot be meaningfully EXPLAIN'd.
 *
 * `sql_explain` does not support parameterized queries — the warehouse will
 * reject a bare `?`, `:name`, or `$1` because nothing substitutes the bind
 * value. Users of this tool must inline their values.
 *
 * Returns an error string to surface to the caller, or `null` when the SQL
 * passes the pre-flight checks.
 */
function validateSqlInput(sql: unknown): string | null {
  if (typeof sql !== "string") {
    return "sql must be a string"
  }
  const trimmed = sql.trim()
  if (trimmed.length === 0) {
    return "sql is empty — pass the full query text to run EXPLAIN against"
  }
  // Detect queries that consist only of placeholder tokens. These come from
  // LLMs that generated a parameterized query (e.g. `SELECT ... WHERE id = ?`)
  // and dropped the surrounding SQL, or from templating mistakes. This check
  // must run before the length check so a bare `?` is classified correctly.
  //
  // We intentionally do NOT scan mid-query for stray `?` characters because
  // PostgreSQL JSONB uses `?`, `?|`, `?&` as legitimate "key exists" operators
  // (e.g. `SELECT * FROM t WHERE data ? 'key'`). Flagging those would break
  // real queries. Callers who pass unsubstituted binds inside an otherwise
  // complete statement will get a translated error from the warehouse.
  if (/^[?$:@][\w]*$/.test(trimmed)) {
    return (
      "sql contains only a placeholder token (" +
      JSON.stringify(trimmed) +
      "). sql_explain does not support parameterized queries — inline the actual values into the SQL text."
    )
  }
  if (trimmed.length < 6) {
    // "SELECT" is 6 chars; anything shorter cannot be a real EXPLAIN-able query
    return `sql is too short to be a valid query: ${JSON.stringify(trimmed)}`
  }
  return null
}

/**
 * Validate a warehouse name supplied by the caller.
 *
 * Empty strings and placeholder tokens slip through the optional-parameter
 * contract and produce unhelpful "Connection X not found" errors from the
 * Registry. Catch these here with a pointer to `warehouse_list`.
 */
function validateWarehouseName(warehouse: string | undefined): string | null {
  if (warehouse === undefined) return null
  if (typeof warehouse !== "string") {
    return "warehouse must be a string"
  }
  const trimmed = warehouse.trim()
  if (trimmed.length === 0) {
    return "warehouse is an empty string — omit the parameter to use the default warehouse, or pass a configured connection name"
  }
  if (/^[?$:@]/.test(trimmed)) {
    return (
      "warehouse name looks like an unsubstituted placeholder (" +
      JSON.stringify(trimmed) +
      "). Use `warehouse_list` to see configured warehouses."
    )
  }
  return null
}

/**
 * Guard EXPLAIN ANALYZE — on PostgreSQL, MySQL, DuckDB, and Trino it actually
 * executes the statement. A DML statement under `analyze: true` would mutate
 * data while bypassing the `sql_execute_write` permission, so analyze mode is
 * restricted to plain read-only statements. String literals and comments are
 * stripped before keyword matching; false positives just fall back to the
 * estimated plan (`analyze: false`), which is always safe.
 *
 * Returns an error string, or `null` when the SQL is safe to analyze.
 */
/**
 * Single left-to-right lexer pass that masks string literals and comments.
 *
 * Regex-based masking is order-dependent and defeatable by alternating quote
 * and comment markers (`SELECT '/*'; DELETE ...; SELECT '*​/'` beats
 * comments-first; `SELECT /*'*​/ ; DELETE ...; /*'*​/` beats strings-first).
 * A lexer has no ordering: at every position exactly one state decides how the
 * next character is consumed, so markers inside literals/comments can never
 * hide code and quotes inside comments can never open a phantom string.
 *
 * Handles: 'single' (with '' escape), "double" (with "" escape), -- line
 * comments, block comments, and PostgreSQL dollar-quotes with identifier-rule
 * tags ($$, $tag1$ — digits allowed after the first char). Backslash escapes
 * are treated as ordinary characters (safe direction: `\'` ends the string
 * early, leaving MORE text visible to the keyword scan, never less).
 *
 * Returns the SQL with literal/comment contents removed, or null when a
 * construct is unterminated (fail closed).
 */
function maskLiteralsAndComments(sql: string): string | null {
  let out = ""
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const next = i + 1 < n ? sql[i + 1] : ""
    if (c === "'") {
      out += "''"
      i++
      for (;;) {
        if (i >= n) return null
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i] === "'") break
        else i++
      }
      i++
    } else if (c === '"') {
      out += '""'
      i++
      for (;;) {
        if (i >= n) return null
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2
        else if (sql[i] === '"') break
        else i++
      }
      i++
    } else if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i)
      out += " "
      if (nl === -1) break
      i = nl
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2)
      if (end === -1) return null
      out += " "
      i = end + 2
    } else if (c === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        if (close === -1) return null
        out += "''"
        i = close + tag[0].length
      } else {
        out += c
        i++
      }
    } else {
      out += c
      i++
    }
  }
  return out
}

function validateAnalyzeSafety(sql: string, analyze: boolean | undefined): string | null {
  if (!analyze) return null
  const blocked =
    "analyze:true runs EXPLAIN ANALYZE, which actually executes the statement — it is only allowed for a single plain SELECT query. " +
    "Re-run with analyze:false for an estimated plan."
  const masked = maskLiteralsAndComments(sql)
  if (masked === null) return blocked
  const stripped = masked.trim()
  // Exactly one executable statement: any semicolon other than a trailing one
  // means a multi-statement payload.
  if (stripped.replace(/;\s*$/, "").includes(";")) return blocked
  const readOnlyStart = /^(select|with|show|describe|desc|values|table)\b/i.test(stripped)
  // Data-modifying CTEs (`WITH x AS (...) INSERT INTO ...`) and similar mean a
  // read-only prefix is not enough — reject write keywords anywhere.
  // `into` covers PostgreSQL `SELECT ... INTO new_table`, which creates a table
  // despite starting as a SELECT. `nextval`/`setval` are sequence-mutating
  // functions that hide inside a read-shaped SELECT.
  // A keyword immediately followed by `(` is the read-only FUNCTION form
  // (REPLACE(str,..), COPY(x)) — statement forms (CALL proc(..), COPY table,
  // INSERT INTO ..) never abut `(` — so it is exempted to avoid blocking
  // legitimate analysis. This guard is best-effort against write STATEMENTS;
  // arbitrary side-effecting UDFs cannot be proven safe from text alone.
  const alwaysWrite =
    /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|vacuum|into|nextval|setval)\b/i
  // replace/copy/call/set double as read-only functions (REPLACE(str,..)); the
  // function form abuts `(`, the statement form (CALL proc(..), COPY t FROM,
  // SET x=1) never does — so only the non-`(` form counts as a write.
  const statementFormOnly = /\b(replace|copy|call|set)\b(?!\s*\()/i
  if (!readOnlyStart || alwaysWrite.test(stripped) || statementFormOnly.test(stripped)) return blocked
  return null
}

export const SqlExplainTool = Tool.define("sql_explain", {
  description:
    "Run EXPLAIN on a SQL query to get the execution plan. Shows how the database engine will process the query — useful for diagnosing slow queries, identifying full table scans, and understanding join strategies. Requires a warehouse connection. IMPORTANT: inline all values into the SQL text — parameterized queries with `?`, `:name`, or `$1` placeholders are not supported.",
  parameters: z.object({
    sql: z
      .string()
      .describe(
        "SQL query to explain. Must be fully materialized — no bind placeholders like `?`, `:name`, or `$1`.",
      ),
    warehouse: z
      .string()
      .optional()
      .describe("Warehouse connection name. Omit to use the first configured warehouse."),
    analyze: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run EXPLAIN ANALYZE (actually executes the query, slower but more accurate). Not supported by Snowflake.",
      ),
  }),
  async execute(args, ctx) {
    // Pre-flight validation — reject bad input before hitting the warehouse
    // so we return an actionable message instead of a verbatim DB error.
    const sqlError = validateSqlInput(args.sql)
    if (sqlError) {
      return {
        title: "Explain: INVALID INPUT",
        metadata: {
          success: false,
          analyzed: false,
          warehouse_type: "unknown",
          error: sqlError,
          error_class: "input_validation",
        },
        output: `Invalid input: ${sqlError}`,
      }
    }
    const warehouseError = validateWarehouseName(args.warehouse)
    if (warehouseError) {
      return {
        title: "Explain: INVALID INPUT",
        metadata: {
          success: false,
          analyzed: false,
          warehouse_type: "unknown",
          error: warehouseError,
          error_class: "input_validation",
        },
        output: `Invalid input: ${warehouseError}`,
      }
    }
    const analyzeError = validateAnalyzeSafety(args.sql, args.analyze)
    if (analyzeError) {
      return {
        title: "Explain: ANALYZE BLOCKED",
        metadata: {
          success: false,
          analyzed: false,
          warehouse_type: "unknown",
          error: analyzeError,
          error_class: "analyze_safety",
        },
        output: `Blocked: ${analyzeError}`,
      }
    }
    // The lexer guard above is text-level hygiene, but text analysis cannot
    // prove a SELECT side-effect-free (dblink_exec, arbitrary UDFs). EXPLAIN
    // ANALYZE executes the statement, so it additionally requires the
    // sql_execute_write permission: agents that deny warehouse writes
    // (analyst/reviewer/dbt-optimizer) cannot run it at all, and write-capable
    // agents prompt per their config.
    if (args.analyze) {
      try {
        await (ctx as any).ask({
          permission: "sql_execute_write",
          patterns: [args.sql],
          metadata: { reason: "EXPLAIN ANALYZE executes the statement on the warehouse" },
        })
      } catch {
        const denied =
          "EXPLAIN ANALYZE executes the statement, which requires the sql_execute_write permission — denied for this agent. Re-run with analyze:false for an estimated plan."
        return {
          title: "Explain: ANALYZE BLOCKED",
          metadata: {
            success: false,
            analyzed: false,
            warehouse_type: "unknown",
            error: denied,
            error_class: "analyze_safety",
          },
          output: `Blocked: ${denied}`,
        }
      }
    }

    try {
      const result = await Dispatcher.call("sql.explain", {
        sql: args.sql,
        warehouse: args.warehouse,
        analyze: args.analyze,
      })

      if (!result.success) {
        const error = result.error ?? "Unknown error"
        return {
          title: "Explain: FAILED",
          metadata: {
            success: false,
            analyzed: false,
            warehouse_type: result.warehouse_type ?? "unknown",
            error,
          },
          output: `Failed to get execution plan: ${error}`,
        }
      }

      return {
        title: `Explain: ${result.analyzed ? "ANALYZE" : "PLAN"} [${result.warehouse_type ?? "unknown"}]`,
        metadata: {
          success: true,
          analyzed: result.analyzed,
          warehouse_type: result.warehouse_type ?? "unknown",
        },
        output: formatPlan(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Explain: ERROR",
        metadata: { success: false, analyzed: false, warehouse_type: "unknown", error: msg },
        output: `Failed to run EXPLAIN: ${msg}\n\nEnsure a warehouse connection is configured and the dispatcher is running.`,
      }
    }
  },
})

// Exported for unit tests.
export const _sqlExplainInternal = {
  validateSqlInput,
  validateWarehouseName,
  validateAnalyzeSafety,
}

function formatPlan(result: SqlExplainResult): string {
  const lines: string[] = []
  lines.push(`Warehouse type: ${result.warehouse_type}`)
  lines.push(`Mode: ${result.analyzed ? "EXPLAIN ANALYZE (actual execution)" : "EXPLAIN (estimated plan)"}`)
  lines.push("")
  lines.push("=== Execution Plan ===")
  lines.push(result.plan_text ?? "(no plan)")
  return lines.join("\n")
}
