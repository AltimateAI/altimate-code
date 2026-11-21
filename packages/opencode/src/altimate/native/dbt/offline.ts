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

export class OfflineDbtError extends Error {
  override name = "OfflineDbtError"
}

/** dbt searches the starting directory and its parents for the project file. */
async function findProjectRoot(start: string): Promise<string> {
  let dir = path.resolve(start)
  while (true) {
    if (await fs.stat(path.join(dir, "dbt_project.yml")).then(() => true, () => false)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(start)
    dir = parent
  }
}

/**
 * Resolve exactly the selected profile/target before starting dbt-owned network work.
 * `cwd` is the directory dbt will run in: dbt reads `profiles.yml` from there, not from the project.
 * Returns the profiles directory that was checked, so the caller can pin dbt to that same file.
 */
export async function assertLocalDbt(
  projectRoot: string,
  args: string[] = [],
  integration = "core",
  cwd = process.cwd(),
): Promise<{ profilesDir: string }> {
  try {
    return await checkLocalDbt(projectRoot, args, integration, cwd)
  } catch (error) {
    throw new OfflineDbtError(error instanceof Error ? error.message : String(error), { cause: error })
  }
}

async function checkLocalDbt(
  projectRoot: string,
  args: string[],
  integration: string,
  cwd: string,
): Promise<{ profilesDir: string }> {
  if (!["core", "corecommand", "fusion"].includes(integration)) throw new Error("Offline mode disables cloud dbt integrations.")
  const option = (...names: string[]) => {
    let result: string | undefined
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === "--") break
      for (const name of names) {
        if (arg === name) {
          result = args[++i]
          break
        }
        const prefix = name.startsWith("--") ? name + "=" : name
        if (arg.startsWith(prefix)) result = arg.slice(prefix.length)
      }
    }
    return result
  }
  const root = option("--project-dir") ?? process.env.DBT_PROJECT_DIR ?? (await findProjectRoot(projectRoot))
  const project = resolve(parse(await fs.readFile(path.join(root, "dbt_project.yml"), "utf8")))
  // dbt's order: --profiles-dir, DBT_PROFILES_DIR, the working directory, then ~/.dbt.
  const explicit = option("--profiles-dir") ?? process.env.DBT_PROFILES_DIR
  const profilesDir = path.resolve(
    cwd,
    explicit ??
      (await fs.stat(path.join(cwd, "profiles.yml")).then(() => cwd, () => path.join(os.homedir(), ".dbt"))),
  )
  const profiles = resolve(parse(await fs.readFile(path.join(profilesDir, "profiles.yml"), "utf8")))
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
  const remoteRoot = typeof output.external_root === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(output.external_root)
  if (output.extensions?.length || output.attach?.length || output.plugins?.length || output.secrets?.length ||
    output.filesystems?.length || output.remote || remoteRoot)
    throw new Error("Offline mode requires a dbt profile without extension installs, attachments, plugins, remote secrets, remote storage, or a remote server.")
  return { profilesDir }
}
