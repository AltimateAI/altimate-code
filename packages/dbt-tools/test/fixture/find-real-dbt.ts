import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

export function findRealDbt(): string | undefined {
  if (process.platform === "win32" || process.env.DBT_E2E_SKIP === "1") return
  const pinned = join(import.meta.dir, "../.dbt-venvs/1.10/bin/dbt")
  const dbt = existsSync(pinned) ? pinned : Bun.which("dbt")
  if (!dbt) return
  const version = spawnSync(dbt, ["--version"], { encoding: "utf8", timeout: 20_000 })
  if (version.status === 0 && /duckdb/i.test(version.stdout + version.stderr)) return dbt
}
