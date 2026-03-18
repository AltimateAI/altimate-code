import { describe, test, expect } from "bun:test"
import { join } from "path"

const entry = join(import.meta.dir, "../src/index.ts")

describe("cli", () => {
  test("no args prints usage", async () => {
    const result = Bun.spawnSync(["bun", entry], { env: { ...process.env, HOME: "/tmp/dbt-tools-test-home" } })
    const out = result.stdout.toString()
    const parsed = JSON.parse(out)
    expect(parsed.commands).toBeDefined()
    expect(parsed.commands.init).toBeDefined()
    expect(parsed.commands.build).toBeDefined()
  })

  test("help prints usage", async () => {
    const result = Bun.spawnSync(["bun", entry, "help"], { env: { ...process.env, HOME: "/tmp/dbt-tools-test-home" } })
    const out = result.stdout.toString()
    const parsed = JSON.parse(out)
    expect(parsed.commands).toBeDefined()
  })

  test("unknown command without config produces config error", async () => {
    const result = Bun.spawnSync(["bun", entry, "nonexistent"], { env: { ...process.env, HOME: "/tmp/dbt-tools-test-home" } })
    const out = result.stdout.toString()
    const parsed = JSON.parse(out)
    expect(parsed.error).toContain("altimate-dbt init")
  })

  test("missing config produces init hint", async () => {
    const result = Bun.spawnSync(["bun", entry, "info"], { env: { ...process.env, HOME: "/tmp/dbt-tools-test-home" } })
    const out = result.stdout.toString()
    const parsed = JSON.parse(out)
    expect(parsed.error).toContain("altimate-dbt init")
  })

  test("init without dbt_project.yml produces error", async () => {
    const result = Bun.spawnSync(["bun", entry, "init", "--project-root", "/tmp/nonexistent-dbt-project"], {
      env: { ...process.env, HOME: "/tmp/dbt-tools-test-home" },
    })
    const out = result.stdout.toString()
    const parsed = JSON.parse(out)
    expect(parsed.error).toBeDefined()
  })

  test("usage includes doctor command", async () => {
    const result = Bun.spawnSync(["bun", entry], { env: { ...process.env, HOME: "/tmp/dbt-tools-test-home" } })
    const parsed = JSON.parse(result.stdout.toString())
    expect(parsed.commands.doctor).toBeDefined()
  })

  test("doctor without config produces init hint", async () => {
    const result = Bun.spawnSync(["bun", entry, "doctor"], { env: { ...process.env, HOME: "/tmp/dbt-tools-test-home" } })
    const parsed = JSON.parse(result.stdout.toString())
    expect(parsed.error).toContain("altimate-dbt init")
  })

  test("info with bad prerequisites shows actionable error", async () => {
    const { mkdtempSync, writeFileSync } = await import("fs")
    const { join } = await import("path")
    const home = mkdtempSync("/tmp/dbt-tools-err-")
    const dir = join(home, ".altimate-code")
    const { mkdirSync } = await import("fs")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "dbt.json"), JSON.stringify({
      projectRoot: "/tmp/definitely-not-a-project",
      pythonPath: "/usr/bin/python3",
      dbtIntegration: "core",
      queryLimit: 500,
    }))
    const result = Bun.spawnSync(["bun", entry, "info"], { env: { ...process.env, HOME: home } })
    const parsed = JSON.parse(result.stdout.toString())
    expect(parsed.error).toContain("Prerequisites not met")
    expect(parsed.error).toContain("project")
  })
})
