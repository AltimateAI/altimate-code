import type { DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"
import { execDbtShow } from "../dbt-cli"

export async function execute(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const sql = flag(args, "query")
  if (!sql) return { error: "Missing --query" }
  const model = flag(args, "model") ?? ""
  const raw = flag(args, "limit")
  const limit = raw !== undefined ? parseInt(raw, 10) : undefined
  try {
    if (limit !== undefined && !Number.isNaN(limit)) return await adapter.immediatelyExecuteSQLWithLimit(sql, model, limit)
    return await adapter.immediatelyExecuteSQL(sql, model)
  } catch (e) {
    // Library's dbt show parsing may fail with newer dbt versions — fall back to direct CLI
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("Cannot read properties of undefined") || msg.includes("Could not find previewLine")) {
      return execDbtShow(sql, limit)
    }
    throw e
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
