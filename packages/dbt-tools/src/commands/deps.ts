import type { DBTProjectIntegrationAdapter, CommandProcessResult } from "@altimateai/dbt-integration"

export async function deps(adapter: DBTProjectIntegrationAdapter) {
  const result = await adapter.installDeps()
  return format(result)
}

export async function add(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const raw = flag(args, "packages")
  if (!raw) return { error: "Missing --packages" }
  const result = await adapter.installDbtPackages(raw.split(","))
  return format(result)
}

// TODO: dbt writes info/progress logs to stderr even on success — checking stderr
// alone causes false failures. CommandProcessResult has no exit_code field, so we
// can't distinguish real errors yet. Revisit when the type is extended.
function format(result?: CommandProcessResult) {
  if (result?.stderr) return { error: result.stderr, stdout: result.stdout }
  return { stdout: result?.stdout ?? "" }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
