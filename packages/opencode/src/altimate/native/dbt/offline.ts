// altimate_change - new file
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { parse } from "yaml"
import { assertLocalConnection, isLocalPath } from "../connections/offline"

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

function option(args: string[], ...names: string[]) {
  let result: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--") break
    for (const name of names) {
      if (arg === name) result = args[++i]
      else if (arg.startsWith(name.startsWith("--") ? name + "=" : name) && arg !== name)
        result = arg.slice(name.length + (name.startsWith("--") ? 1 : 0))
    }
  }
  return result
}

/** DuckDB extensions, attachments and plugins that dbt-duckdb would fetch from the network. */
function remoteDuckdbSetting(output: Record<string, any>) {
  const values = [
    output.external_root,
    ...(Array.isArray(output.attach) ? output.attach.map((item: any) => item?.path) : []),
    ...(Array.isArray(output.extensions)
      ? output.extensions.map((item: any) => (typeof item === "string" ? undefined : item?.repo))
      : []),
  ]
  return (
    values.some((value) => value !== undefined && !isLocalPath(value)) ||
    output.remote !== undefined ||
    // Only DuckDB and SQLite files can be judged; other attachment types name a database server.
    (Array.isArray(output.attach) &&
      output.attach.some((item: any) => item?.type !== undefined && !["duckdb", "sqlite"].includes(item.type))) ||
    (Array.isArray(output.filesystems) && output.filesystems.length > 0) ||
    (Array.isArray(output.secrets) && output.secrets.length > 0)
  )
}

/**
 * Refuse a dbt run whose selected profile and target leave this machine.
 * `cwd` is where dbt runs; dbt reads `profiles.yml` from there before `~/.dbt`.
 * Returns the profiles directory that was checked, so dbt can be pinned to it.
 */
export async function assertLocalDbt(
  projectRoot: string,
  args: string[] = [],
  integration = "core",
  cwd = process.cwd(),
): Promise<{ profilesDir: string }> {
  if (!["core", "corecommand", "fusion"].includes(integration)) throw new Error("Offline mode disables cloud dbt integrations.")
  const root = option(args, "--project-dir") ?? process.env.DBT_PROJECT_DIR ?? (await findProjectRoot(projectRoot))
  const project = parse(await fs.readFile(path.join(root, "dbt_project.yml"), "utf8"))
  // dbt's order: --profiles-dir, DBT_PROFILES_DIR, the working directory, then ~/.dbt.
  const explicit = (option(args, "--profiles-dir") ?? process.env.DBT_PROFILES_DIR)?.replace(/^~(?=$|[\\/])/, () => os.homedir())
  const profilesDir = path.resolve(
    cwd,
    explicit ?? (await fs.stat(path.join(cwd, "profiles.yml")).then(() => cwd, () => path.join(os.homedir(), ".dbt"))),
  )
  const profiles = parse(await fs.readFile(path.join(profilesDir, "profiles.yml"), "utf8"))
  const profile = profiles?.[option(args, "--profile") ?? process.env.DBT_PROFILE ?? project?.profile]
  const output = profile?.outputs?.[option(args, "--target", "-t") ?? process.env.DBT_TARGET ?? profile?.target ?? "default"]
  if (!output || typeof output.type !== "string")
    throw new Error("Offline mode could not resolve a local dbt profile and target.")
  // Cloud sign-in methods contact an identity provider.
  if (output.method && !["database", "password", "none"].includes(output.method))
    throw new Error("Offline mode disables dbt cloud authentication.")
  if (output.type === "sqlite" && output.schemas_and_paths) {
    for (const store of Object.values(output.schemas_and_paths)) assertLocalConnection({ type: "sqlite", path: store as string })
  } else {
    assertLocalConnection({ ...output, path: output.path ?? (output.type === "duckdb" ? ":memory:" : undefined) })
  }
  if (output.type === "duckdb" && remoteDuckdbSetting(output))
    throw new Error("Offline mode refuses dbt-duckdb settings that use remote storage, a remote server or a remote extension repository.")
  return { profilesDir }
}
