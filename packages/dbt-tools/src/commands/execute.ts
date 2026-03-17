import type { DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"

export async function execute(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const sql = flag(args, "query")
  if (!sql) return { error: "Missing --query" }
  const model = flag(args, "model") ?? ""
  const raw = flag(args, "limit")
  const limit = raw !== undefined ? parseInt(raw, 10) : undefined
  if (limit !== undefined && !Number.isNaN(limit)) return adapter.immediatelyExecuteSQLWithLimit(sql, model, limit)
  return adapter.immediatelyExecuteSQL(sql, model)
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
