/**
 * dbt profiles.yml parser.
 *
 * Reads ~/.dbt/profiles.yml and converts dbt connection configs
 * into altimate connection configs.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { DbtProfileConnection } from "../types"
import type { ConnectionConfig } from "@altimateai/drivers"

/** Map dbt adapter types to altimate connector types. */
const ADAPTER_TYPE_MAP: Record<string, string> = {
  postgres: "postgres",
  redshift: "redshift",
  snowflake: "snowflake",
  bigquery: "bigquery",
  databricks: "databricks",
  duckdb: "duckdb",
  mysql: "mysql",
  sqlserver: "sqlserver",
  oracle: "oracle",
  sqlite: "sqlite",
  spark: "databricks",
  trino: "postgres", // wire-compatible
}

/** Map dbt config keys to altimate config keys. */
const KEY_MAP: Record<string, string> = {
  dbname: "database",
  db: "database",
  server: "host",
  hostname: "host",
  server_hostname: "server_hostname",
  http_path: "http_path",
  token: "access_token",
  private_key: "private_key",
  private_key_path: "private_key_path",
  private_key_passphrase: "private_key_passphrase",
  authenticator: "authenticator",
  oauth_client_id: "oauth_client_id",
  oauth_client_secret: "oauth_client_secret",
  keyfile: "credentials_path",
  keyfile_json: "credentials_json",
  project: "project",
  dataset: "dataset",
  location: "location",
  threads: "", // skip — empty string signals "don't map"
  method: "", // skip
}

/** Resolve Jinja {{ env_var('NAME') }} and {{ env_var('NAME', 'default') }} patterns. */
function resolveEnvVars(value: unknown): unknown {
  if (typeof value !== "string") return value
  return value.replace(
    /\{\{\s*env_var\s*\(\s*'([^']+)'\s*(?:,\s*'([^']*)'\s*)?\)\s*\}\}/g,
    (_match, envName: string, defaultValue?: string) => {
      return process.env[envName] ?? defaultValue ?? ""
    },
  )
}

/** Recursively resolve env vars in a config object. */
function resolveEnvVarsDeep(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = resolveEnvVarsDeep(value as Record<string, unknown>)
    } else {
      result[key] = resolveEnvVars(value)
    }
  }
  return result
}

/** Convert a dbt output config to an altimate ConnectionConfig. */
function mapConfig(
  dbtType: string,
  dbtConfig: Record<string, unknown>,
): ConnectionConfig {
  const type = ADAPTER_TYPE_MAP[dbtType] ?? dbtType
  const config: ConnectionConfig = { type }

  for (const [dbtKey, value] of Object.entries(dbtConfig)) {
    if (value === undefined || value === null) continue
    const mappedKey = KEY_MAP[dbtKey]
    if (mappedKey === "" || (mappedKey === undefined && dbtKey in KEY_MAP)) continue // explicitly skipped
    const targetKey = mappedKey ?? dbtKey
    config[targetKey] = resolveEnvVars(value)
  }

  // Ensure type is set from mapping
  config.type = type

  return config
}

/**
 * Parse dbt profiles.yml and return discovered connections.
 *
 * @param profilesPath - Path to profiles.yml. Defaults to ~/.dbt/profiles.yml
 */
export async function parseDbtProfiles(
  profilesPath?: string,
): Promise<DbtProfileConnection[]> {
  const resolvedPath =
    profilesPath ?? path.join(os.homedir(), ".dbt", "profiles.yml")

  if (!fs.existsSync(resolvedPath)) {
    return []
  }

  let parseYaml: (content: string) => any
  try {
    // Try `yaml` package first (more common in Node/Bun ecosystems)
    const yamlMod = await import("yaml")
    const yamlLib = yamlMod.default || yamlMod
    parseYaml = (content: string) => yamlLib.parse(content)
  } catch {
    try {
      // Fall back to `js-yaml`
      // @ts-expect-error — optional fallback dependency
      const jsYaml = await import("js-yaml")
      const jsYamlLib = jsYaml.default || jsYaml
      parseYaml = (content: string) => jsYamlLib.load(content)
    } catch {
      return []
    }
  }

  const content = fs.readFileSync(resolvedPath, "utf-8")
  let profiles: Record<string, any>
  try {
    profiles = parseYaml(content) as Record<string, any>
  } catch {
    return []
  }

  if (!profiles || typeof profiles !== "object") return []

  const connections: DbtProfileConnection[] = []

  for (const [profileName, profile] of Object.entries(profiles)) {
    if (!profile || typeof profile !== "object") continue
    // Skip config key (not a profile)
    if (profileName === "config") continue

    const outputs = (profile as Record<string, any>).outputs
    if (!outputs || typeof outputs !== "object") continue

    for (const [outputName, output] of Object.entries(
      outputs as Record<string, any>,
    )) {
      if (!output || typeof output !== "object") continue
      const rawConfig = resolveEnvVarsDeep(output as Record<string, unknown>)
      const dbtType = (rawConfig.type as string) ?? "unknown"
      const config = mapConfig(dbtType, rawConfig)

      connections.push({
        name: `${profileName}_${outputName}`,
        type: config.type,
        config: config as Record<string, unknown>,
      })
    }
  }

  return connections
}

/**
 * Convert DbtProfileConnection array to a map of ConnectionConfigs.
 */
export function dbtConnectionsToConfigs(
  connections: DbtProfileConnection[],
): Record<string, ConnectionConfig> {
  const result: Record<string, ConnectionConfig> = {}
  for (const conn of connections) {
    result[conn.name] = conn.config as ConnectionConfig
  }
  return result
}
