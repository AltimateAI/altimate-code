/**
 * Direct dbt CLI fallbacks for when the library's output parsing fails.
 *
 * Newer dbt versions (1.11+) may produce JSON log output that the
 * @altimateai/dbt-integration library cannot parse. These functions run dbt
 * commands directly and parse the output with more resilient logic.
 */

import { execFile } from "child_process"

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("dbt", args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
  })
}

/**
 * Parse structured JSON log lines from dbt CLI output.
 * dbt emits one JSON object per line when --log-format json is used.
 */
function parseJsonLines(stdout: string): any[] {
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line.trim())
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/**
 * Execute SQL via `dbt show` and return results in QueryExecutionResult shape.
 */
export async function execDbtShow(sql: string, limit?: number) {
  const args = ["show", "--inline", sql, "--output", "json", "--log-format", "json"]
  if (limit !== undefined) args.push("--limit", String(limit))

  const { stdout } = await run(args)
  const lines = parseJsonLines(stdout)

  // Try multiple known dbt output formats for the preview data
  const previewLine =
    lines.find((l) => l.data?.preview) ??
    lines.find((l) => l.data?.rows) ??
    lines.find((l) => l.result?.preview)

  const sqlLine =
    lines.find((l) => l.data?.sql) ??
    lines.find((l) => l.data?.compiled_sql)

  if (!previewLine) {
    // Last resort: try agate table format from non-JSON output
    throw new Error(
      "Could not parse dbt show output. Ensure dbt supports --output json. " +
        `Got ${lines.length} JSON lines, none with preview data.`,
    )
  }

  const preview = previewLine.data?.preview ?? previewLine.data?.rows ?? previewLine.result?.preview
  const rows: Record<string, unknown>[] = typeof preview === "string" ? JSON.parse(preview) : preview

  const columnNames = rows.length > 0 && rows[0] ? Object.keys(rows[0]) : []
  const compiledSql = sqlLine?.data?.sql ?? sqlLine?.data?.compiled_sql ?? sql

  return {
    columnNames,
    columnTypes: columnNames.map(() => "string"),
    data: rows,
    rawSql: sql,
    compiledSql,
  }
}

/**
 * Compile a model via `dbt compile --select <model>` and return compiled SQL.
 */
export async function execDbtCompile(model: string): Promise<{ sql: string }> {
  const args = ["compile", "--select", model, "--output", "json", "--log-format", "json"]
  const { stdout } = await run(args)
  const lines = parseJsonLines(stdout)

  const compiledLine =
    lines.find((l) => l.data?.compiled) ??
    lines.find((l) => l.data?.compiled_code) ??
    lines.find((l) => l.result?.node?.compiled_code)

  if (compiledLine) {
    const sql =
      compiledLine.data?.compiled ??
      compiledLine.data?.compiled_code ??
      compiledLine.result?.node?.compiled_code
    return { sql }
  }

  // Fallback: try plain text output
  const { stdout: plainOut } = await run(["compile", "--select", model])
  return { sql: plainOut.trim() }
}

/**
 * Compile an inline query via `dbt compile --inline <sql>`.
 */
export async function execDbtCompileInline(
  sql: string,
  model?: string | null,
): Promise<{ sql: string }> {
  const args = ["compile", "--inline", sql, "--output", "json", "--log-format", "json"]
  const { stdout } = await run(args)
  const lines = parseJsonLines(stdout)

  const compiledLine =
    lines.find((l) => l.data?.compiled) ??
    lines.find((l) => l.data?.compiled_code) ??
    lines.find((l) => l.result?.node?.compiled_code)

  if (compiledLine) {
    const result =
      compiledLine.data?.compiled ??
      compiledLine.data?.compiled_code ??
      compiledLine.result?.node?.compiled_code
    return { sql: result }
  }

  const { stdout: plainOut } = await run(["compile", "--inline", sql])
  return { sql: plainOut.trim() }
}

/**
 * List children or parents of a model via `dbt ls`.
 */
export async function execDbtLs(
  model: string,
  direction: "children" | "parents",
): Promise<{ table: string; label: string }[]> {
  const selector = direction === "children" ? `${model}+` : `+${model}`
  const args = ["ls", "--select", selector, "--resource-types", "model", "--output", "json"]

  const { stdout } = await run(args)
  const lines = parseJsonLines(stdout)

  return lines
    .filter((l) => {
      const name = l.name ?? l.unique_id?.split(".").pop()
      return name && name !== model
    })
    .map((l) => ({
      table: l.name ?? l.unique_id?.split(".").pop() ?? "unknown",
      label: l.name ?? l.unique_id?.split(".").pop() ?? "unknown",
    }))
}
