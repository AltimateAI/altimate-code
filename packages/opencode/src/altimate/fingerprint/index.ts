import { Filesystem } from "../../util/filesystem"
import { Glob } from "../../util/glob"
import { Log } from "../../util/log"
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
    return result
  }

  async function detectDir(dir: string, tags: string[]): Promise<void> {
    // Run all file existence checks in parallel
    const [
      hasDbtProject,
      hasProfilesYml,
      hasPackageJson,
      hasPyprojectToml,
      hasRequirementsTxt,
      hasGithubWorkflows,
      hasDockerCompose,
      hasDockerfile,
      hasClaudeMd,
      hasSqlfluff,
      hasDbtPackagesYml,
      hasMakefile,
    ] = await Promise.all([
      Filesystem.exists(path.join(dir, "dbt_project.yml")),
      Filesystem.exists(path.join(dir, "profiles.yml")),
      Filesystem.exists(path.join(dir, "package.json")),
      Filesystem.exists(path.join(dir, "pyproject.toml")),
      Filesystem.exists(path.join(dir, "requirements.txt")),
      Filesystem.isDir(path.join(dir, ".github", "workflows")),
      Filesystem.exists(path.join(dir, "docker-compose.yml")),
      Filesystem.exists(path.join(dir, "Dockerfile")),
      Filesystem.exists(path.join(dir, "CLAUDE.md")),
      Filesystem.exists(path.join(dir, ".sqlfluff")),
      Filesystem.exists(path.join(dir, "dbt_packages.yml")),
      Filesystem.exists(path.join(dir, "Makefile")),
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

    // package.json - detect node ecosystem
    if (hasPackageJson) {
      tags.push("node")
      try {
        const content = await Filesystem.readText(path.join(dir, "package.json"))
        const pkg = JSON.parse(content)
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>

        if (allDeps["typescript"]) tags.push("typescript")
        if (allDeps["react"] || allDeps["react-dom"]) tags.push("react")
        if (allDeps["next"]) tags.push("next")
        if (allDeps["vue"]) tags.push("vue")
        if (allDeps["express"]) tags.push("express")
        if (allDeps["fastify"]) tags.push("fastify")
        if (allDeps["svelte"]) tags.push("svelte")
        if (allDeps["angular"] || allDeps["@angular/core"]) tags.push("angular")
      } catch (e) {
        log.debug("package.json unparseable", { dir, error: e })
      }
    }

    // Python detection
    if (hasPyprojectToml || hasRequirementsTxt) {
      tags.push("python")

      // Parse pyproject.toml with simple string matching
      if (hasPyprojectToml) {
        try {
          const content = await Filesystem.readText(path.join(dir, "pyproject.toml"))
          if (content.includes("fastapi")) tags.push("fastapi")
          if (content.includes("django")) tags.push("django")
          if (content.includes("flask")) tags.push("flask")
          if (content.includes("pytest")) tags.push("pytest")
        } catch (e) {
          log.debug("pyproject.toml unreadable", { dir, error: e })
        }
      }

      // Parse requirements.txt
      if (hasRequirementsTxt) {
        try {
          const content = await Filesystem.readText(path.join(dir, "requirements.txt"))
          const lower = content.toLowerCase()
          if (lower.includes("fastapi")) tags.push("fastapi")
          if (lower.includes("django")) tags.push("django")
          if (lower.includes("flask")) tags.push("flask")
          if (lower.includes("pytest")) tags.push("pytest")
        } catch (e) {
          log.debug("requirements.txt unreadable", { dir, error: e })
        }
      }
    }

    // CI/CD
    if (hasGithubWorkflows) {
      tags.push("ci-cd", "github-actions")
    }

    // Docker
    if (hasDockerCompose || hasDockerfile) {
      tags.push("docker")
    }

    // Claude Code
    if (hasClaudeMd) {
      tags.push("claude-code")
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

    // Makefile
    if (hasMakefile) {
      tags.push("make")
    }
  }
}
