import { afterEach, beforeEach, describe, test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const entry = join(import.meta.dir, "../src/index.ts")

describe("cli", () => {
  let home: string
  const env = () => ({ ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dbt-tools-cli-"))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test("no args prints usage", async () => {
    const result = Bun.spawnSync(["bun", entry], { env: env() })
    const out = result.stdout.toString()
    const parsed = JSON.parse(out)
    expect(parsed.commands).toBeDefined()
    expect(parsed.commands.init).toBeDefined()
    expect(parsed.commands.build).toBeDefined()
  })

  test("help prints usage", async () => {
    const result = Bun.spawnSync(["bun", entry, "help"], { env: env() })
    const out = result.stdout.toString()
    const parsed = JSON.parse(out)
    expect(parsed.commands).toBeDefined()
  })

  test("unknown command without config produces config error", async () => {
    const result = Bun.spawnSync(["bun", entry, "nonexistent"], { env: env() })
    const out = result.stdout.toString()
    const parsed = JSON.parse(out)
    expect(parsed.error).toContain("altimate-dbt init")
  })

  test("missing config produces init hint", async () => {
    const result = Bun.spawnSync(["bun", entry, "info"], { env: env() })
    const out = result.stdout.toString()
    const parsed = JSON.parse(out)
    expect(parsed.error).toContain("altimate-dbt init")
  })

  test("init without dbt_project.yml produces error", async () => {
    const result = Bun.spawnSync(["bun", entry, "init", "--project-root", join(home, "nonexistent-dbt-project")], {
      env: env(),
    })
    const out = result.stdout.toString()
    const parsed = JSON.parse(out)
    expect(parsed.error).toBeDefined()
  })

  test("usage gives children and parents' answer on a stale manifest", async () => {
    const result = Bun.spawnSync(["bun", entry], { env: env() })
    const parsed = JSON.parse(result.stdout.toString())
    expect(parsed.commands.children).toContain("{ stale_manifest, models }")
    expect(parsed.commands.parents).toContain("{ stale_manifest, models }")
  })

  test("usage includes doctor command", async () => {
    const result = Bun.spawnSync(["bun", entry], { env: env() })
    const parsed = JSON.parse(result.stdout.toString())
    expect(parsed.commands.doctor).toBeDefined()
  })

  test("doctor without config produces init hint", async () => {
    const result = Bun.spawnSync(["bun", entry, "doctor"], { env: env() })
    const parsed = JSON.parse(result.stdout.toString())
    expect(parsed.error).toContain("altimate-dbt init")
  })

  test("info with bad prerequisites shows actionable error", async () => {
    const dir = join(home, ".altimate-code")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "dbt.json"), JSON.stringify({
      projectRoot: "/tmp/definitely-not-a-project",
      pythonPath: "/usr/bin/python3",
      dbtIntegration: "core",
      queryLimit: 500,
    }))
    const result = Bun.spawnSync(["bun", entry, "info"], { env: env() })
    const parsed = JSON.parse(result.stdout.toString())
    expect(parsed.error).toContain("Prerequisites not met")
    expect(parsed.error).toContain("project")
  })
})
