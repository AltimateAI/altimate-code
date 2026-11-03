// altimate_change start — the dbt project's adapter type, read without starting the adapter
import { existsSync, readFileSync, statSync } from "fs"
import path from "path"

let cached: { key: string; type?: string } | undefined

/** Whether the working directory has a dbt project, and the adapter type its compiled manifest
 * records (`metadata.adapter_type`, undefined before the project is compiled or when the manifest
 * cannot be read). Runs no subprocess (no Python discovery) and starts nothing; the manifest is
 * parsed again only when its path, size or modification time changes. */
export async function dbtProjectAdapterType(): Promise<{ project: boolean; type?: string }> {
  let projectRoot: string | null = null
  try {
    const config = await import("../../../../../dbt-tools/src/config")
    try {
      const saved = config.path()
      if (existsSync(saved)) projectRoot = (JSON.parse(readFileSync(saved, "utf8")) as { projectRoot?: string }).projectRoot ?? null
    } catch {
      // A malformed saved config falls through to discovery, as dbt's own config reader does.
    }
    projectRoot ??= config.findProjectRoot()
  } catch {
    projectRoot = null
  }
  if (!projectRoot) return { project: false }
  try {
    const { resolveDbtTargetPath } = await import("../../validators/validator-utils")
    const manifest = path.join(await resolveDbtTargetPath(projectRoot), "manifest.json")
    const stat = statSync(manifest)
    const key = `${manifest}|${stat.size}|${stat.mtimeMs}`
    if (cached?.key !== key) {
      const raw = JSON.parse(readFileSync(manifest, "utf8"))
      const type = String(raw?.metadata?.adapter_type ?? "").toLowerCase() || undefined
      cached = { key, type }
    }
    return { project: true, ...(cached.type && { type: cached.type }) }
  } catch {
    // A dbt project whose manifest is missing or unreadable: dbt can still take the call, with an
    // adapter type nobody can establish here.
    return { project: true }
  }
}
// altimate_change end
