// altimate_change start — the dbt project's adapter type, read without starting the adapter
import { existsSync, readFileSync, statSync } from "fs"
import path from "path"

let cached: { key: string; type?: string } | undefined

/** The project root the dbt adapter was created for (null: none), set once register.ts has resolved
 * its adapter. That result is kept for the process, so the dialects read here follow it, not a
 * saved config changed since. */
export const dbtRoute: { root?: string | null } = {}

/** Whether the working directory has a dbt project; the adapter type its compiled manifest records
 * (`metadata.adapter_type`, undefined before the project is compiled or when the manifest cannot be
 * read); and the types of every target of the project's profile, any of which dbt may connect with.
 * Runs no subprocess (no Python discovery) and starts nothing; the manifest is parsed again only
 * when its path, size or modification time changes. */
export async function dbtProjectAdapterType(): Promise<{ project: boolean; type?: string; targetTypes: string[] }> {
  let projectRoot = dbtRoute.root
  if (projectRoot === undefined) {
    try {
      const config = await import("../../../../../dbt-tools/src/config")
      // The project dbt's routing uses: a readable saved config's root, else discovery from the
      // working directory (a malformed config falls through to discovery, as dbt's config reader does).
      let saved: { projectRoot?: string } | null | undefined
      try {
        if (existsSync(config.path())) saved = JSON.parse(readFileSync(config.path(), "utf8"))
      } catch {}
      if (saved === undefined) projectRoot = config.findProjectRoot()
      else projectRoot = typeof saved?.projectRoot === "string" ? saved.projectRoot : null
    } catch {
      projectRoot = null
    }
  }
  // A root without dbt_project.yml is rejected by the routing, which then uses the registry default;
  // an adapter already created keeps running even if the file is removed since.
  if (!projectRoot || (dbtRoute.root === undefined && !existsSync(path.join(projectRoot, "dbt_project.yml"))))
    return { project: false, targetTypes: [] }
  const targetTypes = await profileTargetTypes(projectRoot)
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
    return { project: true, targetTypes, ...(cached.type && { type: cached.type }) }
  } catch {
    // A dbt project whose manifest is missing or unreadable: dbt can still take the call.
    return { project: true, targetTypes }
  }
}

/** The adapter types of the targets in the profile dbt_project.yml names (none when unreadable). */
async function profileTargetTypes(projectRoot: string): Promise<string[]> {
  try {
    const yml = readFileSync(path.join(projectRoot, "dbt_project.yml"), "utf8")
    const value = /^profile:[ \t]*(.*)$/m.exec(yml)?.[1]?.replace(/\s+#.*$/, "").trim()
    if (!value) return []
    const { parseDbtProfiles } = await import("./dbt-profiles")
    const connections = await parseDbtProfiles(undefined, projectRoot)
    // A templated name ({{ env_var(...) }}) is not resolved here: every profile's targets count.
    const profile = value.includes("{{") ? undefined : value.replace(/^["']|["']$/g, "")
    const targets = profile === undefined ? connections : connections.filter((c) => c.name.startsWith(`${profile}_`))
    return [...new Set(targets.map((c) => c.type.toLowerCase()))]
  } catch {
    return []
  }
}
// altimate_change end
