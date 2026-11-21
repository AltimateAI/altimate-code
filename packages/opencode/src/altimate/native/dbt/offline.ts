// altimate_change - new file
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { parse } from "yaml"
import { assertLocalConnection } from "../connections/offline"

function resolve(value: unknown): any {
  if (typeof value === "string") return value.replace(
    /\{\{\s*env_var\s*\(\s*(['"])([^'"]+)\1\s*(?:,\s*(['"])(.*?)\3\s*)?\)\s*\}\}/g,
    (_, _quote, name, _defaultQuote, fallback) => process.env[name] ?? fallback ?? "{{unresolved}}",
  )
  if (Array.isArray(value)) return value.map(resolve)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]))
  return value
}

/** Resolve exactly the selected profile/target before starting dbt-owned network work. */
export async function assertLocalDbt(projectRoot: string, args: string[] = [], integration = "core"): Promise<void> {
  if (!["core", "corecommand", "fusion"].includes(integration)) throw new Error("Offline mode disables cloud dbt integrations.")
  const option = (...names: string[]) => {
    let result: string | undefined
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      const equals = arg.indexOf("=")
      const name = equals < 0 ? arg : arg.slice(0, equals)
      if (names.includes(name)) result = equals < 0 ? args[++i] : arg.slice(equals + 1)
    }
    return result
  }
  const root = option("--project-dir") ?? projectRoot
  const project = resolve(parse(await fs.readFile(path.join(root, "dbt_project.yml"), "utf8")))
  const explicit = option("--profiles-dir") ?? process.env.DBT_PROFILES_DIR
  const local = path.join(root, "profiles.yml")
  const profilesPath = explicit ? path.join(explicit, "profiles.yml")
    : await fs.stat(local).then(() => local, () => path.join(os.homedir(), ".dbt", "profiles.yml"))
  const profiles = resolve(parse(await fs.readFile(profilesPath, "utf8")))
  const profileName = option("--profile") ?? process.env.DBT_PROFILE ?? project.profile
  const profile = profiles?.[profileName]
  const target = option("--target", "-t") ?? process.env.DBT_TARGET ?? profile?.target ?? "default"
  const output = profile?.outputs?.[target]
  if (!output || typeof output.type !== "string") throw new Error("Offline mode could not resolve a local dbt profile and target.")
  if (!["duckdb", "sqlite"].includes(output.type)) {
    if (!output.host && !output.server && !output.connection_string)
      throw new Error("Offline mode requires an explicit loopback host in the dbt profile.")
    if (output.method && !["database", "password", "none"].includes(output.method))
      throw new Error("Offline mode disables dbt cloud authentication.")
  }
  if (output.type === "sqlite" && output.schemas_and_paths) {
    for (const store of Object.values(output.schemas_and_paths)) assertLocalConnection({ type: "sqlite", path: store })
  } else {
    assertLocalConnection({ ...output, path: output.path ?? (output.type === "duckdb" ? ":memory:" : undefined) })
  }
  // These profile hooks cause dbt-duckdb to install extensions or open extra connections at startup.
  if (output.extensions?.length || output.attach?.length || output.plugins?.length || output.secrets?.length)
    throw new Error("Offline mode requires a dbt profile without extension installs, attachments, plugins, or remote secrets.")
}
