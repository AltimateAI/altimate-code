import type { DBTProjectIntegrationAdapter, CommandProcessResult } from "@altimateai/dbt-integration"
import { installPackagesLocked } from "../packages"

// Explicit requests always run `dbt deps`, but under the same lock the automatic
// install uses so they cannot interleave with another process's install.
export async function deps(adapter: DBTProjectIntegrationAdapter, projectRoot: string) {
  const result = await installPackagesLocked(projectRoot, () => adapter.installDeps())
  return format(result)
}

export async function add(adapter: DBTProjectIntegrationAdapter, args: string[], projectRoot: string) {
  const raw = flag(args, "packages")
  if (!raw) return { error: "Missing --packages" }
  const result = await installPackagesLocked(projectRoot, () => adapter.installDbtPackages(raw.split(",")))
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
