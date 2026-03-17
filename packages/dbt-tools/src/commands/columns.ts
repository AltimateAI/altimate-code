import type { DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"

export async function columns(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }
  try {
    const result = await adapter.getColumnsOfModel(model)
    if (!result) return { error: `Model '${model}' not found in manifest. Try: altimate-dbt execute --query "SELECT * FROM ${model} LIMIT 1"` }
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { error: `Failed to get columns for '${model}': ${msg}. Try: altimate-dbt execute --query "SELECT * FROM ${model} LIMIT 1"` }
  }
}

export async function source(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const name = flag(args, "source")
  const table = flag(args, "table")
  if (!name) return { error: "Missing --source" }
  if (!table) return { error: "Missing --table" }
  try {
    const result = await adapter.getColumnsOfSource(name, table)
    if (!result) return { error: `Source '${name}.${table}' not found. Try: altimate-dbt execute --query "SELECT * FROM ${table} LIMIT 1"` }
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { error: `Failed to get columns for source '${name}.${table}': ${msg}` }
  }
}

export async function values(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  const col = flag(args, "column")
  if (!model) return { error: "Missing --model" }
  if (!col) return { error: "Missing --column" }
  return adapter.getColumnValues(model, col)
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
