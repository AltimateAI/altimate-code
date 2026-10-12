import z from "zod"
import { Tool } from "../../tool/tool"
import * as Registry from "../native/connections/registry"
import { classifyAndCheck } from "./sql-classify"

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
    query_timeout_ms: z.number().int().min(0).max(3_600_000).optional(),
  })
  .strict()

export type SqlCheckInput = z.input<typeof parameters>
type Dialect = "sqlite" | "duckdb" | "postgres"
type Row = Record<string, any>

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`
const number = (value: unknown) => Number(value ?? 0)
const share = (count: number, total: number) => (total ? count / total : null)
const display = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))?.slice(0, 180)
const ratio = (value: number | null) => (value === null ? "n/a (empty input)" : value.toFixed(2))

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`sql_check requires ${name} for this check`)
  return value
}

/** Ignore quoted content while checking structure; preserve the original SELECT and its LIMIT. */
export function readSql(sql: string): string {
  const { queryType, blocked } = classifyAndCheck(sql)
  // The shared classifier can fall back to a permissive WITH heuristic. Also reject
  // write CTEs, SELECT INTO and statement/CTE escapes before embedding user SQL.
  const masked = sql.replace(
    /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]|(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)[\s\S]*?\1/g,
    (text) => " ".repeat(text.length),
  )
  // SELECT alone does not make sequence setters, extension loaders or file writers read-only.
  // Preserve quoted function identifiers while hiding string literals and comments.
  const functions = sql.replace(
    /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)[\s\S]*?\1/g,
    (text) => (text.startsWith('"') ? text.slice(1, -1).replace(/""/g, '"') : " ".repeat(text.length)),
  )
  const body = masked.trim().replace(/;$/, "").trim()
  if (
    blocked ||
    queryType !== "read" ||
    !/^(SELECT|WITH)\b/i.test(body) ||
    body.includes(";") ||
    /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|COPY|ATTACH|DETACH|PRAGMA|VACUUM|CALL|DO|INTO|INSTALL|LOAD|EXPORT|IMPORT|GRANT|REVOKE)\b/i.test(
      body,
    ) ||
    /\bREPLACE\b(?!\s*\()/i.test(body) ||
    /\b(nextval|setval|set_config|load_extension|writefile|dblink_exec|lo_import|lo_export|lo_create|lo_unlink|lo_put|pg_write_file|pg_append_file|pg_file_write|pg_file_rename|pg_file_unlink|pg_advisory_lock|pg_advisory_xact_lock)\s*\(/i.test(
      functions,
    )
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
export async function checkSql(input: SqlCheckInput) {
  const args = parameters.parse(input)
  if ([args.left_warehouse, args.right_warehouse].some((w) => w !== undefined && w !== args.warehouse)) {
    throw new Error("sql_check runs in one warehouse; use sql_materialize to put both sides in scratch first.")
  }
  // Validate every supplied SQL field, even one unused by the selected mode.
  const sql = args.sql === undefined ? undefined : readSql(args.sql)
  const left = args.left_sql === undefined ? undefined : readSql(args.left_sql)
  const right = args.right_sql === undefined ? undefined : readSql(args.right_sql)
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
    const response = await connector.execute(query, undefined, undefined, {
      noLimit: true,
      queryTimeoutMs: args.query_timeout_ms,
    })
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
        COUNT(*) AS left_keys, COALESCE(SUM(CASE WHEN right_n > 1 THEN 1 ELSE 0 END), 0) AS multiplying_keys FROM ${scope}matches),
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
      samples,
    }
    return result(args.check, metadata, [
      `fan-out: ${ratio(metadata.fanout_ratio)} (${multiplying ? `${multiplying} of ${metadata.left_keys} left keys match multiple right rows` : "no multiplication"})`,
      `rows: left ${leftRows}; right ${metadata.right_rows}; ${args.join} joined ${metadata.joined_rows}`,
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
  const trim = (v: string) => `LOWER(TRIM(${v}))`
  const normalize = (v: string) => `regexp_replace(${trim(v)}, '[^a-z0-9]', '', 'g')`
  const base = (v: string) => (dialect === "sqlite" ? trim(v) : normalize(v))
  const zeros = (v: string) =>
    `CASE WHEN ${base(v)} = '' THEN '' ELSE COALESCE(NULLIF(${dialect === "sqlite" ? `LTRIM(${base(v)}, '0')` : `regexp_replace(${base(v)}, '^0+', '')`}, ''), '0') END`
  const count = (condition: string) =>
    `(SELECT COUNT(*) FROM ${scope}l l WHERE EXISTS (SELECT 1 FROM ${scope}r r WHERE ${condition}))`
  const exists = (condition: string) =>
    `CASE WHEN EXISTS (SELECT 1 FROM ${scope}l l WHERE EXISTS (SELECT 1 FROM ${scope}r r WHERE l.v <> r.v AND ${condition})) THEN 1 ELSE 0 END`
  const edge = (a: string, b: string) =>
    `(LENGTH(${a}) > 0 AND LENGTH(${b}) > LENGTH(${a}) AND (SUBSTR(${b}, 1, LENGTH(${a})) = ${a} OR SUBSTR(${b}, LENGTH(${b}) - LENGTH(${a}) + 1) = ${a}))`
  const rows = await run(`${sources},
    ${scope}l AS (SELECT DISTINCT ${text(left)} AS v FROM ${scope}lhs src WHERE ${left} IS NOT NULL),
    ${scope}r AS (SELECT DISTINCT ${text(right)} AS v FROM ${scope}rhs src WHERE ${right} IS NOT NULL),
    ${scope}summary AS (SELECT (SELECT COUNT(*) FROM ${scope}l) AS distinct_left, (SELECT COUNT(*) FROM ${scope}r) AS distinct_right,
      ${count("l.v = r.v")} AS matched_exact, ${count(`${trim("l.v")} = ${trim("r.v")}`)} AS matched_trim_lower,
      ${dialect === "sqlite" ? "NULL" : count(`${normalize("l.v")} = ${normalize("r.v")}`)} AS matched_normalized,
      ${count(`${zeros("l.v")} = ${zeros("r.v")}`)} AS matched_without_leading_zeros,
      ${exists("LOWER(l.v) = LOWER(r.v)")} AS case_only,
      ${exists(`${trim("l.v")} = ${trim("r.v")} AND (TRIM(l.v) <> l.v OR TRIM(r.v) <> r.v)`)} AS whitespace,
      ${exists(`${base("l.v")} <> ${base("r.v")} AND ${zeros("l.v")} = ${zeros("r.v")}`)} AS leading_zeros,
      ${exists(`${edge(trim("l.v"), trim("r.v"))} OR ${edge(trim("r.v"), trim("l.v"))}`)} AS prefix_suffix,
      CASE WHEN EXISTS (SELECT ${type(left)} FROM ${scope}lhs src WHERE ${left} IS NOT NULL EXCEPT SELECT ${type(right)} FROM ${scope}rhs src WHERE ${right} IS NOT NULL)
        OR EXISTS (SELECT ${type(right)} FROM ${scope}rhs src WHERE ${right} IS NOT NULL EXCEPT SELECT ${type(left)} FROM ${scope}lhs src WHERE ${left} IS NOT NULL) THEN 1 ELSE 0 END AS type_diff),
    ${scope}lu AS (SELECT v FROM ${scope}l l WHERE NOT EXISTS (SELECT 1 FROM ${scope}r r WHERE r.v = l.v) ORDER BY v LIMIT 5),
    ${scope}ru AS (SELECT v FROM ${scope}r r WHERE NOT EXISTS (SELECT 1 FROM ${scope}l l WHERE l.v = r.v) ORDER BY v LIMIT 5),
    ${scope}samples AS (SELECT 'left' AS side, v FROM ${scope}lu UNION ALL SELECT 'right' AS side, v FROM ${scope}ru)
    SELECT summary.*, samples.* FROM ${scope}summary summary LEFT JOIN ${scope}samples samples ON 1 = 1`)
  const row = rows[0]
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
    matched_trim_lower: number(row.matched_trim_lower),
    matched_normalized: dialect === "sqlite" ? "n/a" : number(row.matched_normalized),
    matched_without_leading_zeros: number(row.matched_without_leading_zeros),
    format_differences: diffs,
    normalization:
      dialect === "sqlite"
        ? "trim + lower; strip non-alphanumerics: n/a (no regexp_replace)"
        : "trim + lower + strip non-alphanumerics (ASCII)",
    unmatched_left: rows.filter((r) => r.side === "left").map((r) => r.v),
    unmatched_right: rows.filter((r) => r.side === "right").map((r) => r.v),
  }
  return result("keys", metadata, [
    `keys: ${metadata.matched_exact === metadata.distinct_left && metadata.matched_exact === metadata.distinct_right ? "exact text coverage" : "unmatched keys found"}${diffs.includes("type") ? "; type differences require review" : ""}; distinct non-null text left ${metadata.distinct_left}, right ${metadata.distinct_right}`,
    `matched left keys: exact text ${metadata.matched_exact}; trim/lower ${metadata.matched_trim_lower}; normalized ${metadata.matched_normalized}; normalized + leading-zero removal ${metadata.matched_without_leading_zeros}`,
    `normalization: ${metadata.normalization}; matches count distinct left text values, not pairs; native join coercion may differ`,
    `format differences (possible, not fixes): ${diffs.join(", ") || "none detected"}`,
    `unmatched exact left (up to 5): ${metadata.unmatched_left.map(display).join(", ") || "none"}`,
    `unmatched exact right (up to 5): ${metadata.unmatched_right.map(display).join(", ") || "none"}`,
  ])
}

export const SqlCheckTool = Tool.define("sql_check", {
  description:
    "Check SQL result invariants: fanout (join defaults to inner), keys, grain, nulls, or extraction coverage. " +
    "Read-only SELECTs run in one SQLite, DuckDB or Postgres warehouse, with their original LIMITs preserved; samples cap at five. " +
    "Use sql_materialize to put cross-warehouse or other-engine sources into scratch first. " +
    "Key normalization is diagnostic and may collapse unrelated values; no automatic fixes. Coverage uses regex except SQLite's explicit LIKE fallback.",
  parameters,
  async execute(args) {
    try {
      return await checkSql(args)
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
