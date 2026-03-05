import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { Telemetry } from "@/telemetry"
import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"

// --- Types ---

export interface GitInfo {
  isRepo: boolean
  branch?: string
  remoteUrl?: string
}

export interface DbtProjectInfo {
  found: boolean
  path?: string
  name?: string
  profile?: string
  manifestPath?: string
  hasPackages?: boolean
}

export interface EnvVarConnection {
  name: string
  type: string
  source: "env-var"
  signal: string
  config: Record<string, string>
}

export interface DataToolInfo {
  name: string
  installed: boolean
  version?: string
}

export interface ConfigFileInfo {
  altimateConfig: boolean
  sqlfluff: boolean
  preCommit: boolean
}

// --- Detection functions (exported for testing) ---

export async function detectGit(): Promise<GitInfo> {
  const isRepoResult = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (isRepoResult.exitCode !== 0) {
    return { isRepo: false }
  }

  const branchResult = Bun.spawnSync(["git", "branch", "--show-current"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.toString().trim() || undefined : undefined

  let remoteUrl: string | undefined
  const remoteResult = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (remoteResult.exitCode === 0) {
    remoteUrl = remoteResult.stdout.toString().trim()
  }

  return { isRepo: true, branch, remoteUrl }
}

export async function detectDbtProject(startDir: string): Promise<DbtProjectInfo> {
  let dir = startDir
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "dbt_project.yml")
    if (existsSync(candidate)) {
      let name: string | undefined
      let profile: string | undefined
      try {
        const content = readFileSync(candidate, "utf-8")
        const nameMatch = content.match(/^name:\s*['"]?([^\s'"]+)['"]?/m)
        if (nameMatch) name = nameMatch[1]
        const profileMatch = content.match(/^profile:\s*['"]?([^\s'"]+)['"]?/m)
        if (profileMatch) profile = profileMatch[1]
      } catch {
        // ignore read errors
      }

      const manifestPath = path.join(dir, "target", "manifest.json")
      const hasManifest = existsSync(manifestPath)

      const hasPackages = existsSync(path.join(dir, "packages.yml")) || existsSync(path.join(dir, "dependencies.yml"))

      return {
        found: true,
        path: dir,
        name,
        profile,
        manifestPath: hasManifest ? manifestPath : undefined,
        hasPackages,
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { found: false }
}

export async function detectEnvVars(): Promise<EnvVarConnection[]> {
  const connections: EnvVarConnection[] = []

  const warehouses: Array<{
    type: string
    signals: string[]
    configMap: Record<string, string | string[]>
  }> = [
    {
      type: "snowflake",
      signals: ["SNOWFLAKE_ACCOUNT"],
      configMap: {
        account: "SNOWFLAKE_ACCOUNT",
        user: "SNOWFLAKE_USER",
        password: "SNOWFLAKE_PASSWORD",
        warehouse: "SNOWFLAKE_WAREHOUSE",
        database: "SNOWFLAKE_DATABASE",
        schema: "SNOWFLAKE_SCHEMA",
        role: "SNOWFLAKE_ROLE",
      },
    },
    {
      type: "bigquery",
      signals: ["GOOGLE_APPLICATION_CREDENTIALS", "BIGQUERY_PROJECT", "GCP_PROJECT"],
      configMap: {
        project: ["BIGQUERY_PROJECT", "GCP_PROJECT"],
        credentials_path: "GOOGLE_APPLICATION_CREDENTIALS",
        location: "BIGQUERY_LOCATION",
      },
    },
    {
      type: "databricks",
      signals: ["DATABRICKS_HOST", "DATABRICKS_SERVER_HOSTNAME"],
      configMap: {
        server_hostname: ["DATABRICKS_HOST", "DATABRICKS_SERVER_HOSTNAME"],
        http_path: "DATABRICKS_HTTP_PATH",
        access_token: "DATABRICKS_TOKEN",
      },
    },
    {
      type: "postgres",
      signals: ["PGHOST", "PGDATABASE"],
      configMap: {
        host: "PGHOST",
        port: "PGPORT",
        database: "PGDATABASE",
        user: "PGUSER",
        password: "PGPASSWORD",
        connection_string: "DATABASE_URL",
      },
    },
    {
      type: "mysql",
      signals: ["MYSQL_HOST", "MYSQL_DATABASE"],
      configMap: {
        host: "MYSQL_HOST",
        port: "MYSQL_TCP_PORT",
        database: "MYSQL_DATABASE",
        user: "MYSQL_USER",
        password: "MYSQL_PASSWORD",
      },
    },
    {
      type: "redshift",
      signals: ["REDSHIFT_HOST"],
      configMap: {
        host: "REDSHIFT_HOST",
        port: "REDSHIFT_PORT",
        database: "REDSHIFT_DATABASE",
        user: "REDSHIFT_USER",
        password: "REDSHIFT_PASSWORD",
      },
    },
  ]

  for (const wh of warehouses) {
    const matchedSignal = wh.signals.find((s) => process.env[s])
    if (!matchedSignal) continue

    const sensitiveKeys = new Set(["password", "access_token", "connection_string", "private_key_path"])
    const config: Record<string, string> = {}
    for (const [key, envNames] of Object.entries(wh.configMap)) {
      const names = Array.isArray(envNames) ? envNames : [envNames]
      for (const envName of names) {
        const val = process.env[envName]
        if (val) {
          config[key] = sensitiveKeys.has(key) ? "***" : val
          break
        }
      }
    }

    connections.push({
      name: `env_${wh.type}`,
      type: wh.type,
      source: "env-var",
      signal: matchedSignal,
      config,
    })
  }

  // DATABASE_URL can point to any database type — parse the scheme to categorize correctly
  const databaseUrl = process.env["DATABASE_URL"]
  if (databaseUrl && !connections.some((c) => c.signal === "DATABASE_URL")) {
    const scheme = databaseUrl.split("://")[0]?.toLowerCase() ?? ""
    const schemeTypeMap: Record<string, string> = {
      postgresql: "postgres",
      postgres: "postgres",
      mysql: "mysql",
      mysql2: "mysql",
      redshift: "redshift",
      sqlite: "sqlite",
      sqlite3: "sqlite",
    }
    const dbType = schemeTypeMap[scheme] ?? "postgres"
    // Only add if we don't already have this type detected from other env vars
    if (!connections.some((c) => c.type === dbType)) {
      connections.push({
        name: `env_${dbType}`,
        type: dbType,
        source: "env-var",
        signal: "DATABASE_URL",
        config: { connection_string: "***" },
      })
    }
  }

  return connections
}

export const DATA_TOOL_NAMES = [
  "dbt",
  "sqlfluff",
  "airflow",
  "dagster",
  "prefect",
  "soda",
  "sqlmesh",
  "great_expectations",
  "sqlfmt",
] as const

/** Extract a semver-like version string from command output. */
export function parseToolVersion(output: string): string | undefined {
  const firstLine = output.trim().split("\n")[0]
  const match = firstLine.match(/(\d+\.\d+[\.\d]*)/)
  return match ? match[1] : undefined
}

export async function detectDataTools(skip: boolean): Promise<DataToolInfo[]> {
  if (skip) return []

  const results = await Promise.all(
    DATA_TOOL_NAMES.map(async (tool): Promise<DataToolInfo> => {
      try {
        const result = Bun.spawnSync([tool, "--version"], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        })
        if (result.exitCode === 0) {
          return {
            name: tool,
            installed: true,
            version: parseToolVersion(result.stdout.toString()),
          }
        }
        return { name: tool, installed: false }
      } catch {
        return { name: tool, installed: false }
      }
    }),
  )

  return results
}

export async function detectConfigFiles(startDir: string): Promise<ConfigFileInfo> {
  return {
    altimateConfig: existsSync(path.join(startDir, ".altimate-code", "altimate-code.json")),
    sqlfluff: existsSync(path.join(startDir, ".sqlfluff")),
    preCommit: existsSync(path.join(startDir, ".pre-commit-config.yaml")),
  }
}

// --- Connection deduplication ---

interface ConnectionSource {
  name: string
  type: string
  source: string
  database?: string
  host?: string
  port?: number
  config?: Record<string, unknown>
  signal?: string
  container?: string
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/^(dbt_|docker_|env_)/, "")
}

function deduplicateConnections(
  existing: Array<{ name: string; type: string; database?: string }>,
  dbtProfiles: Array<{ name: string; type: string; config: Record<string, unknown> }>,
  dockerContainers: Array<{ name: string; db_type: string; host: string; port: number; database?: string }>,
  envVars: EnvVarConnection[],
): {
  alreadyConfigured: ConnectionSource[]
  newFromDbt: ConnectionSource[]
  newFromDocker: ConnectionSource[]
  newFromEnv: ConnectionSource[]
} {
  const seen = new Set<string>()

  const alreadyConfigured: ConnectionSource[] = existing.map((c) => {
    seen.add(normalizeName(c.name))
    return { name: c.name, type: c.type, source: "configured", database: c.database }
  })

  const newFromDbt: ConnectionSource[] = []
  for (const c of dbtProfiles) {
    const normalized = normalizeName(c.name)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      newFromDbt.push({ name: c.name, type: c.type, source: "dbt-profile", config: c.config })
    }
  }

  const newFromDocker: ConnectionSource[] = []
  for (const c of dockerContainers) {
    const normalized = normalizeName(c.name)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      newFromDocker.push({
        name: c.name,
        type: c.db_type,
        source: "docker",
        host: c.host,
        port: c.port,
        database: c.database,
        container: c.name,
      })
    }
  }

  const newFromEnv: ConnectionSource[] = []
  for (const c of envVars) {
    const normalized = normalizeName(c.name)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      newFromEnv.push({ name: c.name, type: c.type, source: "env-var", signal: c.signal })
    }
  }

  return { alreadyConfigured, newFromDbt, newFromDocker, newFromEnv }
}

// --- Tool definition ---

export const ProjectScanTool = Tool.define("project_scan", {
  description:
    "Scan the data engineering environment to detect dbt projects, warehouse connections, Docker databases, installed tools, and configuration files. Returns a comprehensive report for project setup.",
  parameters: z.object({
    skip_docker: z.boolean().optional().describe("Skip Docker container discovery (faster scan)"),
    skip_tools: z.boolean().optional().describe("Skip installed tool detection (faster scan)"),
  }),
  async execute(args, ctx) {
    const cwd = process.cwd()

    // Run local detections in parallel
    const [git, dbtProject, envVars, dataTools, configFiles] = await Promise.all([
      detectGit(),
      detectDbtProject(cwd),
      detectEnvVars(),
      detectDataTools(!!args.skip_tools),
      detectConfigFiles(cwd),
    ])

    // Run bridge-dependent detections with individual error handling
    const engineHealth = await Bridge.call("ping", {} as any)
      .then((r) => ({ healthy: true, status: r.status }))
      .catch(() => ({ healthy: false, status: undefined as string | undefined }))

    const existingConnections = await Bridge.call("warehouse.list", {})
      .then((r) => r.warehouses)
      .catch(() => [] as Array<{ name: string; type: string; database?: string }>)

    const dbtProfiles = await Bridge.call("dbt.profiles", {})
      .then((r) => r.connections ?? [])
      .catch(() => [] as Array<{ name: string; type: string; config: Record<string, unknown> }>)

    const dockerContainers = args.skip_docker
      ? []
      : await Bridge.call("warehouse.discover", {} as any)
          .then((r) => r.containers ?? [])
          .catch(() => [] as Array<{ name: string; db_type: string; host: string; port: number; database?: string }>)

    const schemaCache = await Bridge.call("schema.cache_status", {}).catch(() => null)

    const dbtManifest = dbtProject.manifestPath
      ? await Bridge.call("dbt.manifest", { path: dbtProject.manifestPath }).catch(() => null)
      : null

    // Deduplicate connections
    const connections = deduplicateConnections(existingConnections, dbtProfiles, dockerContainers, envVars)

    // Build output
    const lines: string[] = []

    // Python Engine
    lines.push("# Environment Scan")
    lines.push("")
    lines.push("## Python Engine")
    if (engineHealth.healthy) {
      lines.push(`✓ Engine healthy (${engineHealth.status})`)
    } else {
      lines.push("✗ Engine not available")
    }

    // Git
    lines.push("")
    lines.push("## Git Repository")
    if (git.isRepo) {
      const remote = git.remoteUrl ? ` (origin: ${git.remoteUrl})` : ""
      lines.push(`✓ Git repo on branch \`${git.branch ?? "unknown"}\`${remote}`)
    } else {
      lines.push("✗ Not a git repository")
    }

    // dbt Project
    lines.push("")
    lines.push("## dbt Project")
    if (dbtProject.found) {
      lines.push(`✓ Project "${dbtProject.name ?? "unknown"}" (profile: ${dbtProject.profile ?? "not set"})`)
      lines.push(`  Path: ${dbtProject.path}`)
      if (dbtProject.manifestPath) {
        lines.push(`  ✓ manifest.json found`)
        if (dbtManifest) {
          lines.push(`  Models: ${dbtManifest.model_count}, Sources: ${dbtManifest.source_count}, Tests: ${dbtManifest.test_count}`)
        }
      } else {
        lines.push(`  ✗ No manifest.json (run dbt compile or dbt build)`)
      }
      if (dbtProject.hasPackages) {
        lines.push(`  ✓ packages.yml or dependencies.yml found`)
      }
    } else {
      lines.push("✗ No dbt_project.yml found")
    }

    // Warehouse Connections
    lines.push("")
    lines.push("## Warehouse Connections")

    if (connections.alreadyConfigured.length > 0) {
      lines.push("")
      lines.push("### Already Configured")
      lines.push("Name | Type | Database")
      lines.push("-----|------|--------")
      for (const c of connections.alreadyConfigured) {
        lines.push(`${c.name} | ${c.type} | ${c.database ?? "-"}`)
      }
    }

    if (connections.newFromDbt.length > 0) {
      lines.push("")
      lines.push("### From dbt profiles.yml")
      lines.push("Name | Type | Source")
      lines.push("-----|------|------")
      for (const c of connections.newFromDbt) {
        lines.push(`${c.name} | ${c.type} | dbt-profile`)
      }
    }

    if (connections.newFromDocker.length > 0) {
      lines.push("")
      lines.push("### From Docker")
      lines.push("Container | Type | Host:Port")
      lines.push("----------|------|----------")
      for (const c of connections.newFromDocker) {
        lines.push(`${c.container} | ${c.type} | ${c.host}:${c.port}`)
      }
    }

    if (connections.newFromEnv.length > 0) {
      lines.push("")
      lines.push("### From Environment Variables")
      lines.push("Name | Type | Signal")
      lines.push("-----|------|------")
      for (const c of connections.newFromEnv) {
        lines.push(`${c.name} | ${c.type} | ${c.signal}`)
      }
    }

    const totalConnections =
      connections.alreadyConfigured.length +
      connections.newFromDbt.length +
      connections.newFromDocker.length +
      connections.newFromEnv.length
    if (totalConnections === 0) {
      lines.push("")
      lines.push("No warehouse connections found from any source.")
    }

    // Schema Cache
    if (schemaCache) {
      lines.push("")
      lines.push("## Schema Cache")
      lines.push(`Tables: ${schemaCache.total_tables}, Columns: ${schemaCache.total_columns}`)
      if (schemaCache.warehouses.length > 0) {
        lines.push("Warehouse | Type | Tables | Columns | Last Indexed")
        lines.push("----------|------|--------|---------|-------------")
        for (const w of schemaCache.warehouses) {
          const indexed = w.last_indexed ? new Date(w.last_indexed).toLocaleString() : "never"
          lines.push(`${w.name} | ${w.type} | ${w.tables_count} | ${w.columns_count} | ${indexed}`)
        }
      }
    }

    // Installed Data Tools
    if (dataTools.length > 0) {
      lines.push("")
      lines.push("## Installed Data Tools")
      for (const t of dataTools) {
        if (t.installed) {
          lines.push(`✓ ${t.name} v${t.version ?? "unknown"}`)
        } else {
          lines.push(`✗ ${t.name} (not found)`)
        }
      }
    }

    // Config Files
    lines.push("")
    lines.push("## Config Files")
    lines.push(configFiles.altimateConfig ? "✓ .altimate-code/altimate-code.json" : "✗ .altimate-code/altimate-code.json (not found)")
    lines.push(configFiles.sqlfluff ? "✓ .sqlfluff" : "✗ .sqlfluff (not found)")
    lines.push(configFiles.preCommit ? "✓ .pre-commit-config.yaml" : "✗ .pre-commit-config.yaml (not found)")

    // Emit environment census telemetry
    const warehouseTypes = [...new Set(existingConnections.map(c => c.type))]
    const connectionSources: string[] = []
    if (connections.alreadyConfigured.length > 0) connectionSources.push("configured")
    if (connections.newFromDbt.length > 0) connectionSources.push("dbt-profile")
    if (connections.newFromDocker.length > 0) connectionSources.push("docker")
    if (connections.newFromEnv.length > 0) connectionSources.push("env-var")

    const mcpConfig = (await Config.get()).mcp ?? {}
    const mcpServerCount = Object.keys(mcpConfig).length

    const enabledFlags: string[] = []
    if (Flag.ALTIMATE_CLI_EXPERIMENTAL) enabledFlags.push("experimental")
    if (Flag.ALTIMATE_CLI_EXPERIMENTAL_PLAN_MODE) enabledFlags.push("plan_mode")
    if (Flag.ALTIMATE_CLI_EXPERIMENTAL_FILEWATCHER) enabledFlags.push("filewatcher")
    if (Flag.ALTIMATE_CLI_EXPERIMENTAL_LSP_TOOL) enabledFlags.push("lsp_tool")
    if (Flag.ALTIMATE_CLI_EXPERIMENTAL_OXFMT) enabledFlags.push("oxfmt")
    if (Flag.ALTIMATE_CLI_ENABLE_EXA) enabledFlags.push("exa")
    if (Flag.ALTIMATE_CLI_ENABLE_QUESTION_TOOL) enabledFlags.push("question_tool")

    Telemetry.track({
      type: "environment_census",
      timestamp: Date.now(),
      session_id: Telemetry.getContext().sessionId,
      warehouse_types: warehouseTypes,
      warehouse_count: existingConnections.length,
      dbt_detected: dbtProject.found,
      dbt_adapter: dbtProject.profile ?? null,
      dbt_model_count_bucket: dbtManifest ? Telemetry.bucketCount(dbtManifest.model_count) : "0",
      dbt_source_count_bucket: dbtManifest ? Telemetry.bucketCount(dbtManifest.source_count) : "0",
      dbt_test_count_bucket: dbtManifest ? Telemetry.bucketCount(dbtManifest.test_count) : "0",
      connection_sources: connectionSources,
      mcp_server_count: mcpServerCount,
      skill_count: 0,
      os: process.platform,
      feature_flags: enabledFlags,
    })

    // Build metadata
    const toolsFound = dataTools.filter((t) => t.installed).map((t) => t.name)

    return {
      title: `Scan: ${totalConnections} connection(s), ${dbtProject.found ? "dbt found" : "no dbt"}`,
      metadata: {
        engine_healthy: engineHealth.healthy,
        git: { isRepo: git.isRepo, branch: git.branch },
        dbt: {
          found: dbtProject.found,
          name: dbtProject.name,
          modelCount: dbtManifest?.model_count,
        },
        connections: {
          existing: connections.alreadyConfigured.length,
          new_dbt: connections.newFromDbt.length,
          new_docker: connections.newFromDocker.length,
          new_env: connections.newFromEnv.length,
        },
        schema_cache: schemaCache
          ? {
              warehouses: schemaCache.warehouses.length,
              tables: schemaCache.total_tables,
              columns: schemaCache.total_columns,
            }
          : { warehouses: 0, tables: 0, columns: 0 },
        tools_found: toolsFound,
      },
      output: lines.join("\n"),
    }
  },
})
