import type { DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"

export async function compile(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }
  const sql = await adapter.unsafeCompileNode(model)
  return { sql }
}

export async function query(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const sql = flag(args, "query")
  if (!sql) return { error: "Missing --query" }
  const model = flag(args, "model")
  const result = await adapter.unsafeCompileQuery(sql, model)
  return { sql: result }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
