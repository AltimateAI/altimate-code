import type { DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"
import { execDbtCompile, execDbtCompileInline } from "../dbt-cli"

export async function compile(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }
  try {
    const sql = await adapter.unsafeCompileNode(model)
    return { sql }
  } catch (e) {
    // Use TypeError check (not message strings) to work across V8 and Bun/JavaScriptCore
    if (e instanceof TypeError) {
      return execDbtCompile(model)
    }
    throw e
  }
}

export async function query(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const sql = flag(args, "query")
  if (!sql) return { error: "Missing --query" }
  const model = flag(args, "model")
  try {
    const result = await adapter.unsafeCompileQuery(sql, model)
    return { sql: result }
  } catch (e) {
    if (e instanceof TypeError) {
      return execDbtCompileInline(sql, model)
    }
    throw e
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
