import { Filesystem } from "../../util/filesystem"
import { Glob } from "../../util/glob"
import { Log } from "../../util/log"
import { Tracer } from "../observability/tracing"
import path from "path"

const log = Log.create({ service: "fingerprint" })

export namespace Fingerprint {
  export interface Result {
    tags: string[]
    detectedAt: number
    cwd: string
  }

  let cached: Result | undefined

  export function get(): Result | undefined {
    return cached
  }

  export async function refresh(): Promise<Result> {
    const previousCwd = cached?.cwd ?? process.cwd()
    cached = undefined
    return detect(previousCwd)
  }

  export async function detect(cwd: string, root?: string): Promise<Result> {
    if (cached && cached.cwd === cwd) return cached

    const startTime = Date.now()
    const timer = log.time("detect", { cwd, root })
    const tags: string[] = []

    const dirs = root && root !== cwd ? [cwd, root] : [cwd]

    await Promise.all(
      dirs.map((dir) => detectDir(dir, tags)),
    )

    // Deduplicate
    const unique = [...new Set(tags)]

    const result: Result = {
      tags: unique,
      detectedAt: Date.now(),
      cwd,
    }

    cached = result
    timer.stop()
    log.info("detected", { tags: unique.join(","), cwd })

    Tracer.active?.logSpan({
      name: "fingerprint",
      startTime,
      endTime: Date.now(),
      input: { cwd, root },
      output: { tags: unique },
    })

    return result
  }

  async function detectDir(dir: string, tags: string[]): Promise<void> {
    // Data-engineering detections only
    const [
      hasDbtProject,
      hasProfilesYml,
      hasSqlfluff,
      hasDbtPackagesYml,
      hasAirflowCfg,
      hasDagsDir,
      hasDatabricksYml,
    ] = await Promise.all([
      Filesystem.exists(path.join(dir, "dbt_project.yml")),
      Filesystem.exists(path.join(dir, "profiles.yml")),
      Filesystem.exists(path.join(dir, ".sqlfluff")),
      Filesystem.exists(path.join(dir, "dbt_packages.yml")),
      Filesystem.exists(path.join(dir, "airflow.cfg")),
      Filesystem.isDir(path.join(dir, "dags")),
      Filesystem.exists(path.join(dir, "databricks.yml")),
    ])

    // dbt detection
    if (hasDbtProject) {
      tags.push("dbt", "data-engineering")
    }

    // dbt packages
    if (hasDbtPackagesYml) {
      tags.push("dbt-packages")
    }

    // profiles.yml - extract adapter type
    if (hasProfilesYml) {
      try {
        const content = await Filesystem.readText(path.join(dir, "profiles.yml"))
        const adapterMatch = content.match(
          /type:\s*(snowflake|bigquery|redshift|databricks|postgres|mysql|sqlite|duckdb|trino|spark|clickhouse)/i,
        )
        if (adapterMatch) {
          tags.push(adapterMatch[1]!.toLowerCase())
        }
      } catch (e) {
        log.debug("profiles.yml unreadable", { dir, error: e })
      }
    }

    // SQL - check for .sqlfluff or any .sql files
    if (hasSqlfluff) {
      tags.push("sql")
    } else {
      try {
        const sqlFiles = await Glob.scan("*.sql", {
          cwd: dir,
          include: "file",
        })
        if (sqlFiles.length > 0) {
          tags.push("sql")
        }
      } catch (e) {
        log.debug("sql glob scan failed", { dir, error: e })
      }
    }

    // Airflow
    if (hasAirflowCfg || hasDagsDir) {
      tags.push("airflow")
    }

    // Databricks
    if (hasDatabricksYml) {
      tags.push("databricks")
    }
  }
}
