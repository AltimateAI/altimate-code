import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { resolveDeferState, findDeferSetting } from "../../src/altimate/tools/dbt-defer-state"

describe("dbt_defer_state", () => {
  let root: string
  let savedProfilesDir: string | undefined

  const write = (rel: string, content: string) => {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const settings = (perProject: Record<string, unknown>) =>
    write(".vscode/settings.json", `// comment\n{\n  "dbt.deferConfigPerProject": ${JSON.stringify(perProject)},\n}\n`)

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "defer-state-"))
    savedProfilesDir = process.env.DBT_PROFILES_DIR
    process.env.DBT_PROFILES_DIR = path.join(root, "profiles")
    write("profiles/profiles.yml", "shop:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n    prod:\n      type: duckdb\n")
    write("analytics/dbt_project.yml", "name: shop\nprofile: shop\n")
    fs.mkdirSync(path.join(root, "prod-state"), { recursive: true })
  })

  afterEach(() => {
    if (savedProfilesDir === undefined) delete process.env.DBT_PROFILES_DIR
    else process.env.DBT_PROFILES_DIR = savedProfilesDir
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("local mode returns the state dir, favor state and the profile's targets", async () => {
    settings({ analytics: { deferToProduction: true, favorState: true, manifestPathForDeferral: "${workspaceFolder}/prod-state" } })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result).toMatchObject({
      enabled: true,
      favorState: true,
      mode: "local",
      stateDir: path.join(root, "prod-state"),
      settingsKey: "analytics",
      defaultTarget: "dev",
      targets: ["dev", "prod"],
      profile: "shop",
    })
  })

  test("defer off leaves the state dir unset", async () => {
    settings({ analytics: { deferToProduction: false, manifestPathForDeferral: "${workspaceFolder}/prod-state" } })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result.enabled).toBe(false)
    expect(result.stateDir).toBeUndefined()
    expect(result.defaultTarget).toBe("dev")
  })

  test("a project without an entry reports mode none", async () => {
    settings({ other: { deferToProduction: true, manifestPathForDeferral: "x" } })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result).toMatchObject({ enabled: false, mode: "none" })
  })

  test("a project at the workspace root uses the empty key", async () => {
    write("dbt_project.yml", "name: shop\nprofile: shop\n")
    settings({ "": { deferToProduction: true, manifestPathForDeferral: "prod-state" } })
    const result = await resolveDeferState(root)
    expect(result.enabled).toBe(true)
    expect(result.stateDir).toBe(path.join(root, "prod-state"))
  })

  test("a state path that is not a directory is reported, not used", async () => {
    write("prod-state-file", "x")
    settings({ analytics: { deferToProduction: true, manifestPathForDeferral: "${workspaceFolder}/prod-state-file" } })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result.enabled).toBe(false)
    expect(result.stateDir).toBeUndefined()
    expect(result.reason).toContain("not a directory")
  })

  test("remote mode is reported as unsupported with no state dir", async () => {
    settings({ analytics: { deferToProduction: true, manifestPathType: "remote", dbtCoreIntegrationId: 7 } })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result).toMatchObject({ enabled: false, mode: "remote" })
    expect(result.stateDir).toBeUndefined()
    expect(result.reason).toContain("Remote defer mode")
  })

  test("missing settings file and unreadable profiles give defaults", async () => {
    fs.rmSync(path.join(root, ".vscode"), { recursive: true, force: true })
    fs.rmSync(path.join(root, "profiles"), { recursive: true, force: true })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result).toMatchObject({ enabled: false, mode: "none", targets: [] })
    expect(result.defaultTarget).toBeUndefined()
  })

  test("settings with comments and trailing commas parse", () => {
    settings({ analytics: { deferToProduction: true } })
    expect(findDeferSetting(path.join(root, "analytics"))?.key).toBe("analytics")
  })
})
