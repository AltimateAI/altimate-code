import type { DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"
import { formatCommandResult } from "../failure-text"
import { installPackagesLocked } from "../packages"

// Explicit requests always run `dbt deps`, but under the same lock the automatic
// install uses so they cannot interleave with another process's install.
export async function deps(adapter: DBTProjectIntegrationAdapter, projectRoot: string) {
  const result = await installPackagesLocked(projectRoot, () => adapter.installDeps())
  return formatCommandResult(result)
}

export async function add(adapter: DBTProjectIntegrationAdapter, args: string[], projectRoot: string) {
  const raw = flag(args, "packages")
  if (!raw) return { error: "Missing --packages" }
  const result = await installPackagesLocked(projectRoot, () => adapter.installDbtPackages(raw.split(",")))
  return formatCommandResult(result)
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
