/**
 * Docker container detection for database connections.
 *
 * Uses the `dockerode` package (dynamic import). Returns empty array
 * if dockerode is not installed or Docker is not running.
 */

import type { ConnectionConfig } from "@altimateai/drivers"
import type { DockerContainer } from "../types"

/** Map container images to database types. */
const IMAGE_MAP: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /postgres/i, type: "postgres" },
  { pattern: /mysql/i, type: "mysql" },
  { pattern: /mariadb/i, type: "mysql" },
  { pattern: /mcr\.microsoft\.com\/mssql/i, type: "sqlserver" },
  { pattern: /mssql/i, type: "sqlserver" },
  { pattern: /oracle/i, type: "oracle" },
  { pattern: /gvenzl\/oracle/i, type: "oracle" },
]

/** Map environment variable names to connection config fields by db type. */
const ENV_MAP: Record<string, Record<string, string>> = {
  postgres: {
    POSTGRES_USER: "user",
    POSTGRES_PASSWORD: "password",
    POSTGRES_DB: "database",
  },
  mysql: {
    MYSQL_USER: "user",
    MYSQL_ROOT_PASSWORD: "password",
    MYSQL_PASSWORD: "password",
    MYSQL_DATABASE: "database",
  },
  sqlserver: {
    SA_PASSWORD: "password",
    MSSQL_SA_PASSWORD: "password",
  },
  oracle: {
    ORACLE_PASSWORD: "password",
    APP_USER: "user",
    APP_USER_PASSWORD: "password",
    ORACLE_DATABASE: "database",
  },
}

/** Default ports by database type. */
const DEFAULT_PORTS: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
  sqlserver: 1433,
  oracle: 1521,
}

/** Default users by database type. */
const DEFAULT_USERS: Record<string, string> = {
  postgres: "postgres",
  mysql: "root",
  sqlserver: "sa",
  oracle: "system",
}

function detectDbType(image: string): string | null {
  for (const { pattern, type } of IMAGE_MAP) {
    if (pattern.test(image)) return type
  }
  return null
}

function parseEnvVars(
  envList: string[],
  dbType: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  const mapping = ENV_MAP[dbType] ?? {}

  for (const env of envList) {
    const eqIdx = env.indexOf("=")
    if (eqIdx < 0) continue
    const key = env.slice(0, eqIdx)
    const value = env.slice(eqIdx + 1)
    const configField = mapping[key]
    if (configField && !result[configField]) {
      result[configField] = value
    }
  }

  return result
}

function extractPort(
  ports: Record<string, any>[] | undefined,
  dbType: string,
): number {
  const defaultPort = DEFAULT_PORTS[dbType] ?? 5432
  if (!ports || !Array.isArray(ports)) return defaultPort

  for (const p of ports) {
    if (p.PublicPort && p.PrivatePort === defaultPort) {
      return p.PublicPort
    }
  }

  // Fall back to first public port
  for (const p of ports) {
    if (p.PublicPort) return p.PublicPort
  }

  return defaultPort
}

/**
 * Discover database containers running in Docker.
 * Returns an array of DockerContainer descriptions.
 */
export async function discoverContainers(): Promise<DockerContainer[]> {
  let Docker: any
  try {
    // @ts-expect-error — optional dependency, loaded at runtime
    const mod = await import("dockerode")
    Docker = mod.default || mod
  } catch {
    return []
  }

  try {
    const docker = new Docker()
    const containers = await docker.listContainers({ all: false })
    const results: DockerContainer[] = []

    for (const container of containers) {
      const image = container.Image ?? ""
      const dbType = detectDbType(image)
      if (!dbType) continue

      const envVars = parseEnvVars(container.Env ?? [], dbType)
      const port = extractPort(container.Ports, dbType)
      const name = (container.Names?.[0] ?? "").replace(/^\//, "")

      results.push({
        container_id: (container.Id ?? "").slice(0, 12),
        name,
        image,
        db_type: dbType,
        host: "127.0.0.1",
        port,
        user: envVars.user ?? DEFAULT_USERS[dbType],
        password: envVars.password,
        database: envVars.database,
        status: container.State ?? container.Status ?? "unknown",
      })
    }

    return results
  } catch {
    // Docker not running or permission error
    return []
  }
}

/**
 * Convert a discovered Docker container to a ConnectionConfig.
 */
export function containerToConfig(container: DockerContainer): ConnectionConfig {
  const config: ConnectionConfig = {
    type: container.db_type,
    host: container.host,
    port: container.port,
  }
  if (container.user) config.user = container.user
  if (container.password) config.password = container.password
  if (container.database) config.database = container.database
  return config
}
