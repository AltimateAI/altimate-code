import z from "zod"
import { Tool } from "../../tool/tool"
import { zodToJsonSchema } from "../tool-zod-compat"
import * as Precedence from "../workspace/precedence"
import * as Registry from "../native/connections/registry"
import { classifyAndCheck, isSingleQuery } from "./sql-classify"
import { maskSql, tokenizeSql } from "./sql-tokenize"
import { sqlFunctionCalls } from "./sql-functions"
import { hasSideEffectFunction } from "./sql-function-policy"
import { executeQuery, type QueryContext } from "../native/query-execution"

const column = z
  .string()
  .min(1)
  .refine((s) => !s.includes("\0"), "Column names cannot contain NUL")
const parameters = z
  .object({
    warehouse: z.string().min(1),
    check: z.enum(["fanout", "keys", "grain", "nulls", "coverage"]),
    sql: z.string().optional().describe("Read-only SELECT for grain, nulls or coverage"),
    columns: z.array(column).min(1).max(20).optional().describe("Output column names for grain or nulls (up to 20)"),
    column: column.optional().describe("Output column name for coverage"),
    pattern: z.string().optional().describe("Regex on DuckDB/Postgres; SQL LIKE pattern on SQLite (no REGEXP)"),
    left_sql: z.string().optional().describe("Left SELECT for fanout or keys, run in warehouse"),
    right_sql: z.string().optional().describe("Right SELECT for fanout or keys, run in the same warehouse"),
    on: z
      .array(z.tuple([column, column]))
      .min(1)
      .max(20)
      .optional()
      .describe("Required for fanout: pairs of [left output column, right output column] for equality joins"),
    join: z.enum(["inner", "left"]).optional().default("inner"),
    left_col: column.optional().describe("Left output column for keys; compared as text, with type differences reported"),
    right_col: column.optional().describe("Right output column for keys"),
    left_warehouse: z.string().optional().describe("Optional assertion: must equal warehouse"),
    right_warehouse: z.string().optional().describe("Optional assertion: must equal warehouse"),
    query_timeout_ms: z.number().int().min(1).max(3_600_000).optional(),
  })
  .strict()

export type SqlCheckInput = z.input<typeof parameters>

// Models driven by strict tool schemas (OpenAI Responses API) must send every property, so they
// fill the ones a check does not use with "" or [] — 49 of 56 gpt-5.6-sol calls were rejected for
// that. The published schema therefore tolerates empty values and dropEmpty() removes them before
// the strict parse above validates what remains.
const publicParameters = z
  .object({
    warehouse: z.string().min(1),
    check: z.enum(["fanout", "keys", "grain", "nulls", "coverage"]),
    sql: z.string().optional().describe("Read-only SELECT for grain, nulls or coverage"),
    columns: z.array(z.string()).max(20).optional().describe("Output column names for grain or nulls (up to 20)"),
    column: z.string().optional().describe("Output column name for coverage"),
    pattern: z.string().optional().describe("Regex on DuckDB/Postgres; SQL LIKE pattern on SQLite (no REGEXP)"),
    left_sql: z.string().optional().describe("Left SELECT for fanout or keys, run in warehouse"),
    right_sql: z.string().optional().describe("Right SELECT for fanout or keys, run in the same warehouse"),
    on: z
      .array(z.tuple([z.string(), z.string()]))
      .max(20)
      .optional()
      .describe("Required for fanout: pairs of [left output column, right output column] for equality joins"),
    join: z.string().optional().describe('"inner" (default) or "left"'),
    left_col: z.string().optional().describe("Left output column for keys; compared as text, with type differences reported"),
    right_col: z.string().optional().describe("Right output column for keys"),
    left_warehouse: z.string().optional().describe("Optional assertion: must equal warehouse"),
    right_warehouse: z.string().optional().describe("Optional assertion: must equal warehouse"),
    query_timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(3_600_000)
      .optional()
      .describe("Query deadline in ms; omitted or 0 uses the common connection policy"),
  })
  .strict()

export type SqlCheckPublicInput = z.input<typeof publicParameters>

// Coverage requires a pattern, and an empty pattern is meaningful for that check.
const toolParameters = z.discriminatedUnion("check", [
  publicParameters.extend({ check: z.literal("coverage"), pattern: publicParameters.shape.pattern.unwrap() }),
  publicParameters.extend({ check: z.enum(["fanout", "keys", "grain", "nulls"]) }),
])

/**
 * Treat "", [] and null as absent so strict-schema callers can leave unused fields empty.
 * A coverage check's `pattern` is the one field where "" is a value (match empty strings).
 */
export function dropEmpty(input: SqlCheckPublicInput): SqlCheckInput {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === "pattern" && input.check === "coverage" && value === "") {
      out[key] = value
      continue
    }
    if (value === "" || value === null || (Array.isArray(value) && value.length === 0)) continue
    out[key] = value
  }
  return out as SqlCheckInput
}

type Dialect = "sqlite" | "duckdb" | "postgres"
type Row = Record<string, any>

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`
const number = (value: unknown) => Number(value ?? 0)
const share = (count: number, total: number) => (total ? count / total : null)
const display = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))?.slice(0, 180)
const ratio = (value: number | null) => (value === null ? "n/a (empty input)" : value.toFixed(2))

// altimate_change start — warn when a join keeps under half of the left side
/** Below this matched share of the left side, a join loses most of the population it started from. */
export const LOW_COVERAGE_SHARE = 0.5

/** A leading warning when most of the left side has no match, so a large silent loss is not reported as fact. */
function coverageLoss(matched: number, total: number, unit: string, effect: string): string[] {
  if (!total || matched / total >= LOW_COVERAGE_SHARE) return []
  const lost = total - matched
  return [
    `WARNING coverage loss: ${lost} of ${total} ${unit} (${((lost / total) * 100).toFixed(1)}%) have no match; ${effect}. ` +
      "Before reporting results over the joined rows, confirm this loss is expected (e.g. the other table covers only some entities) " +
      "and state it in the answer, or look for a different key, column or source that covers the population the question asks about.",
  ]
}
// altimate_change end

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`sql_check requires ${name} for this check`)
  return value
}

/** Ignore quoted content while checking structure; preserve the original SELECT and its LIMIT. */
export function readSql(sql: string, dialect?: string): string {
  const { queryType, blocked } = classifyAndCheck(sql, dialect)
  // Independently reject write CTEs, SELECT INTO and statement/CTE escapes before
  // embedding user SQL, even when the parser reports a query category.
  const { tokens, complete } = tokenizeSql(sql, dialect)
  const masked = maskSql(tokens)
  // Keep sql_check's existing stricter ban on dynamic query(), even when the
  // classifier can prove a literal body read-only. All calls use real code '(' tokens.
  const unsafeFunction = sqlFunctionCalls(sql, dialect).some(
    (call) => call.escaped || call.name === "query" || hasSideEffectFunction(call.name),
  )
  const body = masked.trim().replace(/;$/, "").trim()
  let depth = 0
  let balanced = true
  for (const char of body) {
    if (char === "(") depth++
    if (char === ")" && --depth < 0) balanced = false
  }
  if (
    blocked ||
    queryType !== "read" ||
    !isSingleQuery(sql, dialect) ||
    !complete ||
    unsafeFunction ||
    !balanced ||
    depth !== 0 ||
    !/^(SELECT|WITH)\b/i.test(body) ||
    body.includes(";") ||
    /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|COPY|ATTACH|DETACH|PRAGMA|VACUUM|CALL|DO|INTO|INSTALL|LOAD|EXPORT|IMPORT|GRANT|REVOKE)\b/i.test(
      body,
    ) ||
    /\bREPLACE\b(?!\s*\()/i.test(body)
  ) {
    throw new Error(
      "sql_check only accepts a single read-only SELECT (or WITH ... SELECT); it never writes or fixes data.",
    )
  }
  const semicolon = masked.indexOf(";")
  return semicolon < 0 ? sql : sql.slice(0, semicolon) + sql.slice(semicolon + 1)
}

function result(check: string, metadata: Row, lines: string[]): { title: string; metadata: Row; output: string } {
  return { title: `SQL check: ${check}`, metadata: { check, ...metadata }, output: lines.join("\n") }
}

/** Counts run in the warehouse; only aggregate rows and at most five samples per side leave it. */
export function checkSql(input: SqlCheckPublicInput, context?: QueryContext) {
  return executeQuery(Registry.getConfig(input.warehouse), { queryTimeoutMs: input.query_timeout_ms }, context,
    (options) => checkWithinDeadline(input, { ...context, signal: options.signal }))
}

async function checkWithinDeadline(input: SqlCheckPublicInput, context: QueryContext) {
  context?.signal?.throwIfAborted()
  const parsed = parameters.safeParse(dropEmpty(input))
  if (!parsed.success) {
    throw new Error(
      `sql_check invalid input: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    )
  }
  const args = parsed.data
  if ([args.left_warehouse, args.right_warehouse].some((w) => w !== undefined && w !== args.warehouse)) {
    throw new Error("sql_check runs in one warehouse; use sql_materialize to put both sides in scratch first.")
  }
  const sourceDialect = Registry.canonicalType(Registry.getConfig(args.warehouse)?.type) ?? undefined
  // Validate every supplied SQL field, even one unused by the selected mode.
  const sql = args.sql === undefined ? undefined : readSql(args.sql, sourceDialect)
  const left = args.left_sql === undefined ? undefined : readSql(args.left_sql, sourceDialect)
  const right = args.right_sql === undefined ? undefined : readSql(args.right_sql, sourceDialect)
  // Keep internal CTEs from shadowing any relation in the supplied queries.
  let scope = "__sql_check_0_"
  for (let i = 1; [sql, left, right].some((s) => s?.toLowerCase().includes(scope)); i++) scope = `__sql_check_${i}_`
  const rawType = Registry.getConfig(args.warehouse)?.type.toLowerCase()
  const dialect = rawType === "postgresql" ? "postgres" : rawType
  if (dialect !== "sqlite" && dialect !== "duckdb" && dialect !== "postgres") {
    throw new Error(
      "sql_check supports SQLite, DuckDB and Postgres; use sql_materialize to bring other sources into scratch first.",
    )
  }
  const connector = await Registry.get(args.warehouse)
  async function run(query: string): Promise<Row[]> {
    const response = await executeQuery(Registry.getConfig(args.warehouse), {
      noLimit: true,
      readOnly: true,
      queryTimeoutMs: args.query_timeout_ms,
    }, context, (options) => connector.execute(query, undefined, undefined, options))
    if (response.truncated) throw new Error("sql_check received truncated aggregates; no verdict is available")
    return response.rows.map((row) => Object.fromEntries(response.columns.map((col, i) => [col, row[i]])))
  }
  const one = () => `WITH ${scope}source AS (\n${required(sql, "sql")}\n)`
  const two = () =>
    `WITH ${scope}lhs AS (\n${required(left, "left_sql")}\n), ${scope}rhs AS (\n${required(right, "right_sql")}\n)`

  if (args.check === "fanout") {
    const on = required(args.on, "on")
    const names = on.map((_pair, i) => `k${i}`)
    const keys = names.join(", ")
    const group = (side: number) => on.map((pair, i) => `src.${ident(pair[side])} AS ${names[i]}`).join(", ")
    const equality = names.map((name) => `l.${name} = r.${name}`).join(" AND ")
    // Keep right rows separate: their own collation/grouping can differ from the
    // join's equality (e.g. a binary left key and a NOCASE right key in SQLite).
    const rows = await run(`${two()},
      ${scope}lk AS (SELECT ${group(0)}, COUNT(*) AS n FROM ${scope}lhs src GROUP BY ${on.map(([col]) => `src.${ident(col)}`).join(", ")}),
      ${scope}rk AS (SELECT ${group(1)}, 1 AS n FROM ${scope}rhs src),
      ${scope}matches AS (SELECT ${names.map((n) => `l.${n}`).join(", ")}, l.n AS left_n, COALESCE(SUM(r.n), 0) AS right_n
        FROM ${scope}lk l LEFT JOIN ${scope}rk r ON ${equality} GROUP BY ${names.map((n) => `l.${n}`).join(", ")}, l.n),
      ${scope}summary AS (SELECT (SELECT COUNT(*) FROM ${scope}lhs) AS left_rows, (SELECT COUNT(*) FROM ${scope}rhs) AS right_rows,
        COALESCE(SUM(left_n * ${args.join === "left" ? "CASE WHEN right_n = 0 THEN 1 ELSE right_n END" : "right_n"}), 0) AS joined_rows,
        COUNT(*) AS left_keys, COALESCE(SUM(CASE WHEN right_n > 1 THEN 1 ELSE 0 END), 0) AS multiplying_keys,
        COALESCE(SUM(CASE WHEN right_n = 0 THEN left_n ELSE 0 END), 0) AS unmatched_left_rows FROM ${scope}matches),
      ${scope}samples AS (SELECT ${keys}, right_n FROM ${scope}matches WHERE right_n > 1 ORDER BY right_n DESC, ${keys} LIMIT 5)
      SELECT summary.*, samples.* FROM ${scope}summary summary LEFT JOIN ${scope}samples samples ON 1 = 1`)
    const first = rows[0]
    const leftRows = number(first.left_rows)
    const multiplying = number(first.multiplying_keys)
    const samples = rows
      .filter((r) => r.right_n != null)
      .map((r) => ({ key: names.map((n) => r[n]), matches: number(r.right_n) }))
    const metadata = {
      left_rows: leftRows,
      right_rows: number(first.right_rows),
      joined_rows: number(first.joined_rows),
      fanout_ratio: share(number(first.joined_rows), leftRows),
      left_keys: number(first.left_keys),
      multiplying_keys: multiplying,
      unmatched_left_rows: number(first.unmatched_left_rows),
      matched_left_share: share(leftRows - number(first.unmatched_left_rows), leftRows),
      samples,
    }
    const loss = coverageLoss(
      leftRows - metadata.unmatched_left_rows,
      leftRows,
      "left rows",
      args.join === "left" ? "they stay as unmatched rows with NULL right columns" : "the inner join drops them",
    )
    return result(args.check, metadata, [
      ...loss,
      `fan-out: ${ratio(metadata.fanout_ratio)} (${multiplying ? `${multiplying} of ${metadata.left_keys} left keys match multiple right rows` : "no multiplication"})`,
      `rows: left ${leftRows}; right ${metadata.right_rows}; ${args.join} joined ${metadata.joined_rows}; left rows without a match ${metadata.unmatched_left_rows}`,
      `multiplying keys (up to 5): ${samples.map(display).join(", ") || "none"}`,
    ])
  }

  if (args.check === "keys") return checkKeys(args, dialect, two(), scope, run)

  if (args.check === "grain") {
    const cols = required(args.columns, "columns")
    const names = cols.map((_col, i) => `k${i}`)
    const rows =
      await run(`${one()}, ${scope}groups AS (SELECT ${cols.map((col, i) => `src.${ident(col)} AS ${names[i]}`).join(", ")}, COUNT(*) AS n
      FROM ${scope}source src GROUP BY ${cols.map((c) => `src.${ident(c)}`).join(", ")}),
      ${scope}summary AS (SELECT COALESCE(SUM(n), 0) AS total_rows, COUNT(*) AS distinct_combinations FROM ${scope}groups),
      ${scope}samples AS (SELECT * FROM ${scope}groups WHERE n > 1 ORDER BY n DESC, ${names.join(", ")} LIMIT 5)
      SELECT summary.*, samples.* FROM ${scope}summary summary LEFT JOIN ${scope}samples samples ON 1 = 1`)
    const total = number(rows[0].total_rows)
    const distinct = number(rows[0].distinct_combinations)
    const samples = rows.filter((r) => r.n != null).map((r) => ({ key: names.map((n) => r[n]), count: number(r.n) }))
    return result(
      args.check,
      { total_rows: total, distinct_combinations: distinct, duplicate_count: total - distinct, samples },
      [
        `grain: ${total === distinct ? "unique" : `${total - distinct} duplicate rows beyond the first per key`}`,
        `rows: ${total}; distinct combinations (including NULL): ${distinct}`,
        `duplicates (up to 5): ${samples.map(display).join(", ") || "none"}`,
      ],
    )
  }

  if (args.check === "nulls") {
    const cols = required(args.columns, "columns")
    const [row] = await run(
      `${one()} SELECT COUNT(*) AS n, ${cols
        .map(
          (col, i) =>
            `COUNT(*) - COUNT(src.${ident(col)}) AS null_${i}, COUNT(DISTINCT src.${ident(col)}) AS distinct_${i}`,
        )
        .join(", ")} FROM ${scope}source src`,
    )
    const total = number(row.n)
    const columns = cols.map((column, i) => ({
      column,
      null_count: number(row[`null_${i}`]),
      null_share: share(number(row[`null_${i}`]), total),
      distinct_count: number(row[`distinct_${i}`]),
    }))
    return result(args.check, { total_rows: total, columns }, [
      `nulls: ${columns.some((c) => c.null_count) ? "NULL values found" : "no NULL values"}; rows: ${total}`,
      ...columns.map(
        (c) =>
          `${display(c.column)}: nulls ${c.null_count}; share ${ratio(c.null_share)}; distinct non-null ${c.distinct_count}`,
      ),
    ])
  }

  const col = `src.${ident(required(args.column, "column"))}`
  const pattern = required(args.pattern, "pattern")
  if (pattern.includes("\0")) throw new Error("Patterns cannot contain NUL")
  // E strings make backslashes unambiguous even with standard_conforming_strings off.
  const quoted = dialect === "postgres" ? `E${literal(pattern.replace(/\\/g, "\\\\"))}` : literal(pattern)
  const value = `CAST(${col} AS ${dialect === "postgres" ? "TEXT" : "VARCHAR"})`
  const predicate =
    dialect === "duckdb"
      ? `regexp_matches(${value}, ${quoted})`
      : dialect === "postgres"
        ? `${value} ~ ${quoted}`
        : `${value} LIKE ${quoted}`
  const rows =
    await run(`${one()}, ${scope}checked AS (SELECT ${col} AS value, CASE WHEN ${predicate} THEN 1 ELSE 0 END AS matched FROM ${scope}source src),
    ${scope}summary AS (SELECT COUNT(*) AS n, COALESCE(SUM(matched), 0) AS matching FROM ${scope}checked),
    ${scope}samples AS (SELECT DISTINCT value, 1 AS present FROM ${scope}checked WHERE matched = 0 ORDER BY value LIMIT 5)
    SELECT summary.*, samples.* FROM ${scope}summary summary LEFT JOIN ${scope}samples samples ON 1 = 1`)
  const total = number(rows[0].n)
  const matching = number(rows[0].matching)
  const mode = dialect === "sqlite" ? "like" : "regex"
  return result(
    args.check,
    {
      rows: total,
      matching_rows: matching,
      share: share(matching, total),
      pattern_mode: mode,
      samples: rows.filter((r) => r.present != null).map((r) => r.value),
    },
    [
      `coverage: ${total ? `${matching}/${total} rows match (${((100 * matching) / total).toFixed(2)}%); ${total - matching} non-matching` : "n/a (empty input)"}`,
      `pattern mode: ${mode}${mode === "like" ? " (SQLite has no REGEXP by default; supply a LIKE pattern using % and _)" : ""}; NULL counts as non-matching`,
      `non-matching values (up to 5): ${
        rows
          .filter((r) => r.present != null)
          .map((r) => display(r.value))
          .join(", ") || "none"
      }`,
    ],
  )
}

async function checkKeys(
  args: z.output<typeof parameters>,
  dialect: Dialect,
  sources: string,
  scope: string,
  run: (sql: string) => Promise<Row[]>,
) {
  const left = `src.${ident(required(args.left_col, "left_col"))}`
  const right = `src.${ident(required(args.right_col, "right_col"))}`
  const text = (col: string) =>
    `CAST(${col} AS ${dialect === "postgres" ? "TEXT" : "VARCHAR"})${dialect === "sqlite" ? " COLLATE BINARY" : ""}`
  const type = (col: string) => (dialect === "postgres" ? `CAST(pg_typeof(${col}) AS TEXT)` : `typeof(${col})`)
  const integerTypes =
    "'integer', 'smallint', 'bigint', 'tinyint', 'hugeint', 'utinyint', 'usmallint', 'uinteger', 'ubigint', 'uhugeint'"
  // Materialize each normalization once per distinct key, never once per candidate pair.
  const normalized = (side: string) => `${scope}${side}trim AS MATERIALIZED (
      SELECT v, LOWER(v) AS lower_v, LOWER(TRIM(v)) AS trim_v, CASE WHEN TRIM(v) <> v THEN 1 ELSE 0 END AS spaced
      FROM ${scope}${side} WHERE (SELECT integer_keys FROM ${scope}typing) = 0),
    ${scope}${side}base AS MATERIALIZED (SELECT *, ${dialect === "sqlite" ? "trim_v" : "regexp_replace(trim_v, '[^a-z0-9]', '', 'g')"} AS base_v FROM ${scope}${side}trim),
    ${scope}${side}norm AS MATERIALIZED (SELECT *, CASE WHEN base_v = '' THEN '' ELSE COALESCE(NULLIF(${dialect === "sqlite" ? "LTRIM(base_v, '0')" : "regexp_replace(base_v, '^0+', '')"}, ''), '0') END AS zero_v FROM ${scope}${side}base)`
  const edge = (a: string, b: string) =>
    `(LENGTH(${a}) > 0 AND LENGTH(${b}) > LENGTH(${a}) AND (SUBSTR(${b}, 1, LENGTH(${a})) = ${a} OR SUBSTR(${b}, LENGTH(${b}) - LENGTH(${a}) + 1) = ${a}))`
  // Group the right forms before joining so normalization collisions cannot multiply rows.
  const rows = await run(`${sources},
    ${scope}l AS MATERIALIZED (SELECT DISTINCT ${text(left)} AS v FROM ${scope}lhs src WHERE ${left} IS NOT NULL),
    ${scope}r AS MATERIALIZED (SELECT DISTINCT ${text(right)} AS v FROM ${scope}rhs src WHERE ${right} IS NOT NULL),
    ${scope}lt AS (SELECT DISTINCT ${type(left)} AS t FROM ${scope}lhs src WHERE ${left} IS NOT NULL),
    ${scope}rt AS (SELECT DISTINCT ${type(right)} AS t FROM ${scope}rhs src WHERE ${right} IS NOT NULL),
    ${scope}typing AS (SELECT CASE WHEN EXISTS (SELECT 1 FROM ${scope}lt) AND EXISTS (SELECT 1 FROM ${scope}rt)
      AND NOT EXISTS (SELECT 1 FROM ${scope}lt WHERE LOWER(t) NOT IN (${integerTypes}))
      AND NOT EXISTS (SELECT 1 FROM ${scope}rt WHERE LOWER(t) NOT IN (${integerTypes})) THEN 1 ELSE 0 END AS integer_keys,
      CASE WHEN EXISTS (SELECT t FROM ${scope}lt EXCEPT SELECT t FROM ${scope}rt)
        OR EXISTS (SELECT t FROM ${scope}rt EXCEPT SELECT t FROM ${scope}lt) THEN 1 ELSE 0 END AS type_diff),
    ${normalized("l")}, ${normalized("r")},
    ${scope}rcase AS (SELECT lower_v AS k, MIN(v) AS min_v, MAX(v) AS max_v FROM ${scope}rnorm GROUP BY lower_v),
    ${scope}rtrimmed AS (SELECT trim_v AS k, MIN(v) AS min_v, MAX(v) AS max_v, MAX(spaced) AS spaced FROM ${scope}rnorm GROUP BY trim_v),
    ${scope}rnormalized AS (SELECT DISTINCT base_v AS k FROM ${scope}rnorm),
    ${scope}rzero AS (SELECT zero_v AS k, MIN(base_v) AS min_v, MAX(base_v) AS max_v FROM ${scope}rnorm GROUP BY zero_v),
    ${scope}probes AS (SELECT COUNT(t.k) AS matched_trim_lower,
      ${dialect === "sqlite" ? "NULL" : "COUNT(n.k)"} AS matched_normalized, COUNT(z.k) AS matched_without_leading_zeros,
      MAX(CASE WHEN l.v <> c.min_v OR l.v <> c.max_v THEN 1 ELSE 0 END) AS case_only,
      MAX(CASE WHEN (l.v <> t.min_v OR l.v <> t.max_v) AND (l.spaced = 1 OR t.spaced = 1) THEN 1 ELSE 0 END) AS whitespace,
      MAX(CASE WHEN l.base_v <> z.min_v OR l.base_v <> z.max_v THEN 1 ELSE 0 END) AS leading_zeros
      FROM ${scope}lnorm l LEFT JOIN ${scope}rcase c ON l.lower_v = c.k
      LEFT JOIN ${scope}rtrimmed t ON l.trim_v = t.k
      LEFT JOIN ${scope}rnormalized n ON l.base_v = n.k
      LEFT JOIN ${scope}rzero z ON l.zero_v = z.k),
    ${scope}lu AS MATERIALIZED (SELECT l.v FROM ${scope}l l LEFT JOIN ${scope}r r ON l.v = r.v WHERE r.v IS NULL),
    ${scope}ru AS (SELECT r.v FROM ${scope}r r LEFT JOIN ${scope}l l ON r.v = l.v WHERE l.v IS NULL ORDER BY r.v LIMIT 5),
    ${scope}lp AS MATERIALIZED (SELECT LOWER(TRIM(v)) AS v FROM ${scope}lu WHERE (SELECT integer_keys FROM ${scope}typing) = 0 ORDER BY v LIMIT 100),
    ${scope}rp AS MATERIALIZED (SELECT LOWER(TRIM(v)) AS v FROM ${scope}r WHERE (SELECT integer_keys FROM ${scope}typing) = 0 ORDER BY v LIMIT 100),
    ${scope}summary AS (SELECT (SELECT COUNT(*) FROM ${scope}l) AS distinct_left, (SELECT COUNT(*) FROM ${scope}r) AS distinct_right,
      (SELECT COUNT(*) FROM ${scope}l l JOIN ${scope}r r ON l.v = r.v) AS matched_exact,
      probes.*, typing.*,
      CASE WHEN EXISTS (SELECT 1 FROM ${scope}lp l CROSS JOIN ${scope}rp r WHERE ${edge("l.v", "r.v")} OR ${edge("r.v", "l.v")}) THEN 1 ELSE 0 END AS prefix_suffix
      FROM ${scope}probes probes CROSS JOIN ${scope}typing typing),
    ${scope}lsamples AS (SELECT v FROM ${scope}lu ORDER BY v LIMIT 5),
    ${scope}samples AS (SELECT 'left' AS side, v FROM ${scope}lsamples UNION ALL SELECT 'right' AS side, v FROM ${scope}ru)
    SELECT summary.*, samples.* FROM ${scope}summary summary LEFT JOIN ${scope}samples samples ON 1 = 1`)
  const row = rows[0]
  const integerKeys = number(row.integer_keys) > 0
  const diffs = [
    ["case_only", "case-only"],
    ["whitespace", "whitespace"],
    ["leading_zeros", "leading zeros"],
    ["prefix_suffix", "prefix/suffix"],
    ["type_diff", "type"],
  ]
    .filter(([key]) => number(row[key]) > 0)
    .map(([, label]) => label)
  const metadata = {
    distinct_left: number(row.distinct_left),
    distinct_right: number(row.distinct_right),
    matched_exact: number(row.matched_exact),
    left_coverage: share(number(row.matched_exact), number(row.distinct_left)),
    right_coverage: share(number(row.matched_exact), number(row.distinct_right)),
    matched_trim_lower: integerKeys ? "n/a" : number(row.matched_trim_lower),
    matched_normalized: integerKeys || dialect === "sqlite" ? "n/a" : number(row.matched_normalized),
    matched_without_leading_zeros: integerKeys ? "n/a" : number(row.matched_without_leading_zeros),
    format_differences: diffs,
    prefix_suffix_probe: integerKeys ? "skipped (integer keys)" : "up to 100 unmatched left keys and 100 right keys",
    normalization: integerKeys
      ? "skipped (integer keys)"
      : dialect === "sqlite"
        ? "trim + lower; strip non-alphanumerics: n/a (no regexp_replace)"
        : "trim + lower + strip non-alphanumerics (ASCII)",
    unmatched_left: rows.filter((r) => r.side === "left").map((r) => r.v),
    unmatched_right: rows.filter((r) => r.side === "right").map((r) => r.v),
  }
  const verdict = !metadata.distinct_left
    ? "no left keys"
    : metadata.matched_exact === metadata.distinct_left
      ? "left coverage complete"
      : "unmatched left keys found"
  return result("keys", metadata, [
    ...coverageLoss(metadata.matched_exact, metadata.distinct_left, "distinct left keys", "a join on these keys drops them"),
    `keys: ${verdict}${diffs.includes("type") ? "; type differences require review" : ""}; distinct non-null text left ${metadata.distinct_left}, right ${metadata.distinct_right}`,
    `exact text coverage: left ${metadata.matched_exact}/${metadata.distinct_left}; right ${metadata.matched_exact}/${metadata.distinct_right}; shares: left ${ratio(metadata.left_coverage)}, right ${ratio(metadata.right_coverage)}`,
    `matched left keys: exact text ${metadata.matched_exact}; trim/lower ${metadata.matched_trim_lower}; normalized ${metadata.matched_normalized}; normalized + leading-zero removal ${metadata.matched_without_leading_zeros}`,
    `normalization: ${metadata.normalization}; matches count distinct left text values, not pairs; native join coercion may differ`,
    `format differences (possible, not fixes): ${diffs.join(", ") || "none detected"}`,
    `prefix/suffix probe: ${metadata.prefix_suffix_probe}`,
    `unmatched exact left (up to 5): ${metadata.unmatched_left.map(display).join(", ") || "none"}`,
    `unmatched exact right (up to 5): ${metadata.unmatched_right.map(display).join(", ") || "none"}`,
  ])
}

export const SqlCheckTool = Tool.define("sql_check", {
  description:
    "Check SQL result invariants: fanout (join defaults to inner), keys, grain, nulls, or extraction coverage. " +
    "Read-only SELECTs run in one SQLite, DuckDB or Postgres warehouse, with their original LIMITs preserved; samples cap at five. " +
    "Use sql_materialize to put cross-warehouse or other-engine sources into scratch first. " +
    "Key normalization is diagnostic and may collapse unrelated values; no automatic fixes. Coverage uses regex except SQLite's explicit LIKE fallback. " +
    "Leave fields a check does not use empty.",
  parameters: toolParameters,
  // Strict-schema providers require a flat object at the root of the wire schema.
  jsonSchema: zodToJsonSchema(publicParameters),
  async execute(args, ctx) {
    try {
      // altimate_change start — validate and authorize reads before workspace redirects
      const input = dropEmpty(args)
      const dialect = Registry.canonicalType(Registry.getConfig(input.warehouse)?.type) ?? undefined
      const queries = [input.sql, input.left_sql, input.right_sql].filter((sql): sql is string => sql !== undefined)
      for (const sql of queries) readSql(sql, dialect)
      await ctx.ask({
        permission: "sql_execute",
        patterns: queries,
        always: ["*"],
        metadata: { warehouse: input.warehouse },
      })
      const precedence = await Precedence.check(ctx.sessionID, "sql_execute", input.warehouse)
      if (precedence.redirect) return precedence.redirect
      // altimate_change end
      return Precedence.annotate(precedence, await checkSql(args, { signal: ctx.abort, sessionID: ctx.sessionID }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        title: `SQL check: ${args.check} ERROR`,
        metadata: { check: args.check, error: message },
        output: `${args.check}: no verdict — ${message.replace(/\s+/g, " ").slice(0, 1500)}`,
      }
    }
  },
})
