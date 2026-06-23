import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { Telemetry } from "@/telemetry"
import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"
import { Skill } from "../../skill"

// --- Types ---

export interface GitInfo {
  isRepo: boolean
  branch?: string
  remoteUrl?: string
  /**
   * True if `git` was reachable on the host (regardless of whether the cwd
   * is a git repo). False ONLY when `safeSpawnSync(["git", ...])` failed
   * to spawn — most commonly because git is not installed / not in PATH.
   * Distinct from `isRepo` so callers record the "missing git" signal
   * separately from "this directory is not a git repo".
   * Undefined for callers that don't care.
   */
  gitAvailable?: boolean
  /**
   * Captures the case where git ran but produced a non-standard error
   * (corrupted .git, permission denied, etc. — anything that isn't a
   * clean "not a repo" exit-128). Lets callers distinguish:
   *   isRepo=false, gitAvailable=true, gitError=undefined → clean non-repo
   *   isRepo=false, gitAvailable=true, gitError=<exit>   → degraded git
   *   isRepo=false, gitAvailable=false                    → git missing
   * Undefined when irrelevant.
   */
  gitError?: { exitCode: number; stderr?: string }
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

/**
 * Run a subprocess that may or may not exist on the host.
 *
 * `Bun.spawnSync` throws when the binary is missing from $PATH (e.g.
 * `Executable not found in $PATH: "git"`) — not just when it exits non-zero.
 * Telemetry shows this fingerprint hitting ~437 distinct users on
 * `project_scan` (the binary name `"git"` was masked to `?` downstream,
 * which made it look like a generic shell error). Wrap every spawn so a
 * missing binary degrades gracefully instead of crashing the whole tool.
 *
 * Return value semantics:
 *   - `null`         → could not spawn (binary missing, permission denied,
 *                      Bun internal failure). Distinct from "ran and failed".
 *   - `{exitCode: 0, stdout}`         → ran successfully.
 *   - `{exitCode: N>0, stdout}`       → ran and exited non-zero.
 *   - `{exitCode: 1, stdout: ""}`     → also returned when `Bun.spawnSync`
 *                                       gives back `exitCode: null` (signaled
 *                                       child). Coalesced to `1` because no
 *                                       current caller distinguishes "killed
 *                                       by signal" from "exited with status 1";
 *                                       expand this contract if that changes.
 */
export function safeSpawnSync(
  args: string[],
  opts?: { timeout?: number },
): { exitCode: number; stdout: string; stderr: string } | null {
  try {
    const result = Bun.spawnSync(args, {
      stdout: "pipe",
      stderr: "pipe",
      ...(opts?.timeout !== undefined && { timeout: opts.timeout }),
    })
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
    }
  } catch {
    // Binary missing from PATH, permission denied, etc. — treat as
    // "command failed" so the caller sees a deterministic result instead
    // of an exception bubbling up.
    return null
  }
}

export async function detectGit(): Promise<GitInfo> {
  const isRepoResult = safeSpawnSync(["git", "rev-parse", "--is-inside-work-tree"])
  // Distinguish three cases that all produce isRepo=false:
  //   1. Git binary missing (null result) — record "git" in degraded.
  //   2. Git ran with exit 128 — clean "not a repo" signal.
  //   3. Git ran with non-zero, non-128 — degraded git (corrupted .git,
  //      permission denied, etc.); still record "git" in degraded so the
  //      caller doesn't silently bucket a real failure as "not a repo".
  // Collapsing all three into a bare `{ isRepo: false }` would re-introduce
  // the original 437-user telemetry opacity — "Executable not found in
  // $PATH: ?" masked to look like a generic shell error.
  if (!isRepoResult) {
    return { isRepo: false, gitAvailable: false }
  }
  if (isRepoResult.exitCode !== 0) {
    // Exit 128 is git's standard "fatal" for not-in-a-repo. Anything else
    // is unusual — surface it via gitError so the caller can decide
    // whether to record it in degraded.
    if (isRepoResult.exitCode === 128) {
      return { isRepo: false, gitAvailable: true }
    }
    // Run stderr through the telemetry masker BEFORE persisting so emails,
    // bearer tokens, and api-keys can't leak into LLM-visible metadata,
    // session transcripts, or App Insights via `metadata.git.gitError`.
    // Cap at 240 chars after masking (mask replacements can shorten or
    // lengthen the input minimally).
    const maskedStderr = isRepoResult.stderr
      ? Telemetry.maskString(isRepoResult.stderr.trim()).slice(0, 240) || undefined
      : undefined
    return {
      isRepo: false,
      gitAvailable: true,
      gitError: { exitCode: isRepoResult.exitCode, stderr: maskedStderr },
    }
  }

  const branchResult = safeSpawnSync(["git", "branch", "--show-current"])
  const branch =
    branchResult && branchResult.exitCode === 0 ? branchResult.stdout.trim() || undefined : undefined

  let remoteUrl: string | undefined
  const remoteResult = safeSpawnSync(["git", "remote", "get-url", "origin"])
  if (remoteResult && remoteResult.exitCode === 0) {
    remoteUrl = stripGitRemoteCredentials(remoteResult.stdout.trim())
  }

  return { isRepo: true, gitAvailable: true, branch, remoteUrl }
}

/**
 * Strip embedded credentials from a git remote URL before surfacing it.
 *
 * `git remote get-url origin` returns the URL verbatim including HTTPS
 * basic-auth (e.g. `https://x-access-token:ghp_xxx@github.com/...`) when
 * the user committed creds into the remote. `remoteUrl` flows into tool
 * result metadata that ships to the LLM provider AND is persisted in
 * session transcripts — leaving creds in there is a recurring exfil path.
 *
 * SSH-form remotes (`git@github.com:owner/repo.git`) have no userinfo
 * concept and are left untouched. URLs we can't parse are dropped to
 * undefined (better to lose the breadcrumb than leak creds).
 */
function stripGitRemoteCredentials(url: string): string | undefined {
  if (!url) return undefined
  // SSH form: `git@host:path` — no creds to strip.
  if (/^[\w.-]+@[\w.-]+:/.test(url) && !url.includes("://")) return url
  try {
    const parsed = new URL(url)
    parsed.username = ""
    parsed.password = ""
    return parsed.toString()
  } catch {
    // Unparseable — drop entirely rather than risk leaking embedded creds.
    return undefined
  }
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
    {
      type: "sqlserver",
      signals: ["MSSQL_HOST", "SQLSERVER_HOST"],
      configMap: {
        host: ["MSSQL_HOST", "SQLSERVER_HOST"],
        port: ["MSSQL_PORT", "SQLSERVER_PORT"],
        database: ["MSSQL_DATABASE", "SQLSERVER_DATABASE"],
        user: ["MSSQL_USER", "SQLSERVER_USER"],
        password: ["SA_PASSWORD", "MSSQL_SA_PASSWORD", "MSSQL_PASSWORD", "SQLSERVER_PASSWORD"],
      },
    },
    {
      type: "oracle",
      signals: ["ORACLE_HOST", "ORACLE_SID", "ORACLE_SERVICE_NAME"],
      configMap: {
        host: "ORACLE_HOST",
        port: "ORACLE_PORT",
        user: "ORACLE_USER",
        password: "ORACLE_PASSWORD",
        database: ["ORACLE_SID", "ORACLE_SERVICE_NAME", "ORACLE_DATABASE"],
      },
    },
    {
      type: "duckdb",
      signals: ["DUCKDB_PATH", "DUCKDB_DATABASE"],
      configMap: {
        database: ["DUCKDB_PATH", "DUCKDB_DATABASE"],
      },
    },
    {
      type: "sqlite",
      signals: ["SQLITE_PATH", "SQLITE_DATABASE"],
      configMap: {
        database: ["SQLITE_PATH", "SQLITE_DATABASE"],
      },
    },
    {
      type: "clickhouse",
      signals: ["CLICKHOUSE_HOST", "CLICKHOUSE_URL"],
      configMap: {
        host: "CLICKHOUSE_HOST",
        port: "CLICKHOUSE_PORT",
        database: ["CLICKHOUSE_DB", "CLICKHOUSE_DATABASE"],
        user: ["CLICKHOUSE_USER", "CLICKHOUSE_USERNAME"],
        password: "CLICKHOUSE_PASSWORD",
        connection_string: "CLICKHOUSE_URL",
      },
    },
    {
      type: "trino",
      signals: ["TRINO_HOST", "TRINO_SERVER", "TRINO_URL"],
      configMap: {
        host: "TRINO_HOST",
        port: "TRINO_PORT",
        user: ["TRINO_USER", "TRINO_USERNAME"],
        password: "TRINO_PASSWORD",
        catalog: ["TRINO_CATALOG", "TRINO_DATABASE"],
        schema: "TRINO_SCHEMA",
        connection_string: ["TRINO_URL", "TRINO_SERVER"],
        access_token: ["TRINO_TOKEN", "TRINO_ACCESS_TOKEN"],
      },
    },
  ]

  for (const wh of warehouses) {
    const matchedSignal = wh.signals.find((s) => process.env[s])
    if (!matchedSignal) continue

    const sensitiveKeys = new Set([
      "password",
      "access_token",
      "token",
      "connection_string",
      "private_key_path",
      "private_key",
      "private_key_passphrase",
      "credentials_json",
      "keyfile_json",
      "ssl_key",
      "ssl_cert",
      "ssl_ca",
      "oauth_client_secret",
      "passcode",
    ])
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
      mssql: "sqlserver",
      sqlserver: "sqlserver",
      oracle: "oracle",
      duckdb: "duckdb",
      databricks: "databricks",
      clickhouse: "clickhouse",
      "clickhouse+http": "clickhouse",
      "clickhouse+https": "clickhouse",
      trino: "trino",
      "trino+http": "trino",
      "trino+https": "trino",
      presto: "trino",
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

  // Route through safeSpawnSync for consistency with detectGit. The previous
  // implementation used a bare try/catch around Bun.spawnSync — same outcome
  // for the caller, but the two functions solved the same problem two
  // different ways. Using one helper keeps the contract uniform: `null`
  // means "could not spawn" (binary missing), distinct from "ran and exited
  // non-zero" (binary present but the version check failed).
  const results = await Promise.all(
    DATA_TOOL_NAMES.map(async (tool): Promise<DataToolInfo> => {
      const result = safeSpawnSync([tool, "--version"], { timeout: 5000 })
      if (result && result.exitCode === 0) {
        return {
          name: tool,
          installed: true,
          version: parseToolVersion(result.stdout),
        }
      }
      return { name: tool, installed: false }
    }),
  )

  return results
}

export async function detectConfigFiles(startDir: string): Promise<ConfigFileInfo> {
  return {
    altimateConfig: existsSync(path.join(startDir, ".opencode", "altimate-code.json")),
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

    // Track which sub-detections failed so the LLM can see partial results
    // instead of getting a single opaque "Executable not found in $PATH: ?"
    // failure (the previous behavior — see safeSpawnSync above).
    //
    // Set rather than [] so adjacent `.catch` blocks (or any future
    // refactor that wraps Dispatcher calls at two layers) can't record the
    // same key twice. `.add()` is idempotent. Serialized as a sorted array
    // for `metadata.degraded` at the end so dashboard queries see a stable
    // shape.
    const degraded = new Set<string>()

    // Run local detections in parallel. Every detection function is now
    // expected to fail-safe (return a "not found" or empty result) rather
    // than throw — see detectGit + detectDataTools.
    const [git, dbtProject, envVars, dataTools, configFiles] = await Promise.all([
      detectGit().catch(() => {
        degraded.add("git")
        return { isRepo: false } as GitInfo
      }),
      detectDbtProject(cwd).catch(() => {
        degraded.add("dbt-project")
        return { found: false } as DbtProjectInfo
      }),
      detectEnvVars().catch(() => {
        degraded.add("env-vars")
        return [] as EnvVarConnection[]
      }),
      detectDataTools(!!args.skip_tools).catch(() => {
        degraded.add("data-tools")
        return [] as DataToolInfo[]
      }),
      detectConfigFiles(cwd).catch(() => {
        degraded.add("config-files")
        return { altimateConfig: false, sqlfluff: false, preCommit: false } as ConfigFileInfo
      }),
    ])

    // Run bridge-dependent detections with individual error handling. A
    // dispatcher failure on any one of these is expected (Python engine may
    // not be running locally) — degrade silently and report in metadata.
    const engineHealth = await Dispatcher.call("ping", {} as any)
      .then((r) => ({ healthy: true, status: r.status }))
      .catch(() => {
        degraded.add("python-engine")
        return { healthy: false, status: undefined as string | undefined }
      })

    const existingConnections = await Dispatcher.call("warehouse.list", {})
      .then((r) => r.warehouses)
      .catch(() => {
        degraded.add("warehouse.list")
        return [] as Array<{ name: string; type: string; database?: string }>
      })

    const dbtProfiles = await Dispatcher.call("dbt.profiles", {
      projectDir: dbtProject.found ? dbtProject.path : undefined,
    })
      .then((r) => r.connections ?? [])
      .catch(() => {
        degraded.add("dbt.profiles")
        return [] as Array<{ name: string; type: string; config: Record<string, unknown> }>
      })

    const dockerContainers = args.skip_docker
      ? []
      : await Dispatcher.call("warehouse.discover", {} as any)
          .then((r) => r.containers ?? [])
          .catch(() => {
            degraded.add("warehouse.discover")
            return [] as Array<{ name: string; db_type: string; host: string; port: number; database?: string }>
          })

    const schemaCache = await Dispatcher.call("schema.cache_status", {}).catch(() => {
      degraded.add("schema.cache_status")
      return null
    })

    const dbtManifest = dbtProject.manifestPath
      ? await Dispatcher.call("dbt.manifest", { path: dbtProject.manifestPath }).catch(() => {
          degraded.add("dbt.manifest")
          return null
        })
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
    } else if (git.gitAvailable === false) {
      // Distinguish "git not installed" from "not a repo" so the LLM /
      // user can act differently (suggest installing git vs initialising a
      // repo). Also record in degraded so dashboards spot the pattern —
      // detectGit no longer throws, so the .catch() above never fires for
      // this case and only this explicit add() records it.
      lines.push("✗ git binary not found in PATH (install git or add it to PATH)")
      degraded.add("git")
    } else if (git.gitError) {
      // Git ran but produced a non-128 error — corrupted .git, permission
      // denied, etc. Surface the exit code + stderr (truncated) so the user
      // can self-diagnose. Record in degraded so this case doesn't silently
      // bucket as a clean "not a repo".
      const stderrSuffix = git.gitError.stderr ? `: ${git.gitError.stderr.slice(0, 120)}` : ""
      lines.push(`✗ git error (exit ${git.gitError.exitCode})${stderrSuffix}`)
      degraded.add("git")
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
          lines.push(
            `  Models: ${dbtManifest.model_count}, Sources: ${dbtManifest.source_count}, Tests: ${dbtManifest.test_count}`,
          )
        }
      } else {
        lines.push(`  ✗ No manifest.json (run dbt compile or dbt build)`)
      }
      if (dbtProject.hasPackages) {
        lines.push(`  ✓ packages.yml or dependencies.yml found`)
      }
      // altimate_change start — dbt auto-detection skill suggestions
      lines.push("")
      lines.push(`  Recommended skills:`)
      lines.push(`  - /dbt-develop — Build and modify dbt models with AI assistance`)
      lines.push(`  - /dbt-troubleshoot — Debug failing dbt models and tests`)
      lines.push(`  - /dbt-analyze — Analyze dbt project structure and dependencies`)

      try {
        const { PostConnectSuggestions } = await import("./post-connect-suggestions")
        PostConnectSuggestions.trackSuggestions({
          suggestionType: "dbt_detected",
          suggestionsShown: ["dbt-develop", "dbt-troubleshoot", "dbt-analyze"],
        })
      } catch {
        // Telemetry must never break scan output, but record it in the
        // degraded list so we can see post-deploy whether the dynamic
        // import is silently failing for some users.
        degraded.add("post-connect-suggestions")
      }
      // altimate_change end
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
    lines.push(
      configFiles.altimateConfig ? "✓ .opencode/altimate-code.json" : "✗ .opencode/altimate-code.json (not found)",
    )
    lines.push(configFiles.sqlfluff ? "✓ .sqlfluff" : "✗ .sqlfluff (not found)")
    lines.push(configFiles.preCommit ? "✓ .pre-commit-config.yaml" : "✗ .pre-commit-config.yaml (not found)")

    // Emit environment census telemetry
    const warehouseTypes = [...new Set(existingConnections.map((c) => c.type))]
    const connectionSources: string[] = []
    if (connections.alreadyConfigured.length > 0) connectionSources.push("configured")
    if (connections.newFromDbt.length > 0) connectionSources.push("dbt-profile")
    if (connections.newFromDocker.length > 0) connectionSources.push("docker")
    if (connections.newFromEnv.length > 0) connectionSources.push("env-var")

    const mcpConfig = await Config.get()
      .then((c) => c.mcp ?? {})
      .catch(() => {
        degraded.add("config")
        return {}
      })
    const mcpServerCount = Object.keys(mcpConfig).length

    const enabledFlags: string[] = []
    if (Flag.OPENCODE_EXPERIMENTAL) enabledFlags.push("experimental")
    if (Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE) enabledFlags.push("plan_mode")
    if (Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER) enabledFlags.push("filewatcher")
    if (Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL) enabledFlags.push("lsp_tool")
    if (Flag.OPENCODE_EXPERIMENTAL_OXFMT) enabledFlags.push("oxfmt")
    if (Flag.OPENCODE_ENABLE_EXA) enabledFlags.push("exa")
    if (Flag.OPENCODE_ENABLE_QUESTION_TOOL) enabledFlags.push("question_tool")

    const skillCount = await Skill.all()
      .then((s) => s.length)
      .catch(() => {
        degraded.add("skills")
        return 0
      })

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
      // altimate_change start — dbt project fingerprint expansion
      dbt_snapshot_count_bucket: dbtManifest ? Telemetry.bucketCount(dbtManifest.snapshot_count ?? 0) : "0",
      dbt_seed_count_bucket: dbtManifest ? Telemetry.bucketCount(dbtManifest.seed_count ?? 0) : "0",
      dbt_materialization_dist: dbtManifest
        ? JSON.stringify(
            (dbtManifest.models ?? []).reduce((acc: Record<string, number>, m: any) => {
              const mat = m.materialized ?? "unknown"
              acc[mat] = (acc[mat] ?? 0) + 1
              return acc
            }, {} as Record<string, number>),
          )
        : undefined,
      // altimate_change end
      connection_sources: connectionSources,
      mcp_server_count: mcpServerCount,
      skill_count: skillCount,
      os: process.platform,
      feature_flags: enabledFlags,
    })

    // Surface degraded detections in the output so the LLM can recommend
    // installing the missing pieces without thinking the tool itself failed.
    // Sort the keys so the output is stable across runs (Set iteration
    // order is insertion order, which depends on which detection failed
    // first — not useful to the human reader).
    const degradedList = [...degraded].sort()
    if (degradedList.length > 0) {
      lines.push("")
      lines.push(`## Degraded Detections (${degradedList.length})`)
      lines.push(
        `The following sub-detections failed and were skipped (the rest of the scan is still valid):`,
      )
      for (const d of degradedList) {
        lines.push(`- ${d}`)
      }
    }

    // Build metadata
    const toolsFound = dataTools.filter((t) => t.installed).map((t) => t.name)

    const degradedSuffix = degradedList.length > 0 ? ` (${degradedList.length} degraded)` : ""

    return {
      title: `Scan: ${totalConnections} connection(s), ${dbtProject.found ? "dbt found" : "no dbt"}${degradedSuffix}`,
      metadata: {
        engine_healthy: engineHealth.healthy,
        git: {
          isRepo: git.isRepo,
          branch: git.branch,
          gitAvailable: git.gitAvailable,
          gitError: git.gitError,
        },
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
        // Always emit as an array (sorted, deduplicated) — never `undefined` —
        // so dashboard queries don't need null coalescing. Empty array means
        // "no degradation" cleanly.
        degraded: degradedList,
      },
      output: lines.join("\n"),
    }
  },
})
