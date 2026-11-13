import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect } from "effect"
import type { Tool } from "../../src/tool/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import { DbtDeferStateTool, resolveDeferState, findDeferSetting } from "../../src/altimate/tools/dbt-defer-state"
import { initTool } from "./tool-fixture"

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
    write("analytics/prod-state/manifest.json", "{}")
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
      stateDir: path.join(root, "analytics", "prod-state"),
      settingsKey: "analytics",
      defaultTarget: "dev",
      targets: ["dev", "prod"],
      profile: "shop",
    })
  })

  test("defer off still returns the configured state dir, so a session can switch it on", async () => {
    settings({ analytics: { deferToProduction: false, manifestPathForDeferral: "${workspaceFolder}/prod-state" } })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result.enabled).toBe(false)
    expect(result.mode).toBe("local")
    expect(result.stateDir).toBe(path.join(root, "analytics", "prod-state"))
    expect(result.defaultTarget).toBe("dev")
  })

  test("a project without an entry reports mode none", async () => {
    settings({ other: { deferToProduction: true, manifestPathForDeferral: "x" } })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result).toMatchObject({ enabled: false, mode: "none" })
  })

  test("a project at the workspace root uses the empty key", async () => {
    write("dbt_project.yml", "name: shop\nprofile: shop\n")
    write("prod-state/manifest.json", "{}")
    settings({ "": { deferToProduction: true, manifestPathForDeferral: "prod-state" } })
    const result = await resolveDeferState(root)
    expect(result.enabled).toBe(true)
    expect(result.stateDir).toBe(path.join(root, "prod-state"))
  })

  test("a state path that is not a directory is reported, not used", async () => {
    write("analytics/prod-state-file", "x")
    settings({ analytics: { deferToProduction: true, manifestPathForDeferral: "${workspaceFolder}/prod-state-file" } })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result.enabled).toBe(false)
    expect(result.stateDir).toBeUndefined()
    expect(result.reason).toContain("not a directory")
  })

  test("a state dir without manifest.json is reported, not used", async () => {
    fs.mkdirSync(path.join(root, "analytics", "empty-state"))
    settings({ analytics: { deferToProduction: true, manifestPathForDeferral: "${workspaceFolder}/empty-state" } })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result.enabled).toBe(false)
    expect(result.stateDir).toBeUndefined()
    expect(result.reason).toContain("manifest.json")
  })

  test("a manifest.json that is a directory is not a usable state", async () => {
    fs.mkdirSync(path.join(root, "analytics", "dir-state", "manifest.json"), { recursive: true })
    settings({ analytics: { deferToProduction: true, manifestPathForDeferral: "${workspaceFolder}/dir-state" } })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result.enabled).toBe(false)
    expect(result.stateDir).toBeUndefined()
    expect(result.reason).toContain("manifest.json")
  })

  test("${workspaceFolder} is the dbt project's own folder, as in Power User", async () => {
    fs.mkdirSync(path.join(root, "prod-state"), { recursive: true })
    fs.writeFileSync(path.join(root, "prod-state", "manifest.json"), "{}")
    settings({ analytics: { deferToProduction: true, manifestPathForDeferral: "${workspaceFolder}/prod-state" } })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result.stateDir).toBe(path.join(root, "analytics", "prod-state"))
  })

  test("a settings file that does not parse ends the search; an outer folder's entry does not stand in", async () => {
    write("analytics/.vscode/settings.json", '{ "dbt.deferConfigPerProject": oops')
    settings({ analytics: { deferToProduction: true, manifestPathForDeferral: "${workspaceFolder}/prod-state" } })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result).toMatchObject({ enabled: false, mode: "none" })
  })

  test("an unknown manifest type does not enable defer", async () => {
    settings({ analytics: { deferToProduction: true, manifestPathType: "typo", manifestPathForDeferral: "${workspaceFolder}/prod-state" } })
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result).toMatchObject({ enabled: false, mode: "none" })
    expect(result.stateDir).toBeUndefined()
    expect(result.reason).toContain("typo")
  })

  test("a settings file that does not parse is not trusted", async () => {
    write(".vscode/settings.json", '{ "dbt.deferConfigPerProject": { "analytics": { "deferToProduction": true, "manifestPathForDeferral": "${workspaceFolder}/prod-state" } } } oops')
    const result = await resolveDeferState(path.join(root, "analytics"))
    expect(result).toMatchObject({ enabled: false, mode: "none" })
  })

  test("${env:NAME} in the state path is expanded, and an unset one is left as written", async () => {
    process.env.DEFER_TEST_STATE = path.join(root, "analytics", "prod-state")
    try {
      settings({ analytics: { deferToProduction: true, manifestPathForDeferral: "${env:DEFER_TEST_STATE}" } })
      expect((await resolveDeferState(path.join(root, "analytics"))).stateDir).toBe(path.join(root, "analytics", "prod-state"))
    } finally {
      delete process.env.DEFER_TEST_STATE
    }
    settings({ analytics: { deferToProduction: true, manifestPathForDeferral: "${env:DEFER_TEST_UNSET}" } })
    expect((await resolveDeferState(path.join(root, "analytics"))).reason).toContain("${env:DEFER_TEST_UNSET}")
  })

  test("an explicit workspace folder and an absolute state path are used", async () => {
    write("elsewhere/.vscode/settings.json", JSON.stringify({ "dbt.deferConfigPerProject": { "../analytics": { deferToProduction: true, manifestPathForDeferral: path.join(root, "analytics", "prod-state") } } }))
    const result = await resolveDeferState(path.join(root, "analytics"), path.join(root, "elsewhere"))
    expect(result).toMatchObject({ enabled: true, stateDir: path.join(root, "analytics", "prod-state"), settingsKey: "../analytics" })
  })

  test("a project or target written as env_var() is resolved, with its default", async () => {
    write("analytics/dbt_project.yml", "name: shop\nprofile: \"{{ env_var('DEFER_TEST_PROFILE', 'shop') }}\"\n")
    write("profiles/profiles.yml", "shop:\n  target: \"{{ env_var('DEFER_TEST_TARGET', 'dev') }}\"\n  outputs:\n    dev:\n      type: duckdb\n    qa:\n      type: duckdb\n")
    process.env.DEFER_TEST_TARGET = "qa"
    try {
      const result = await resolveDeferState(path.join(root, "analytics"))
      expect(result).toMatchObject({ profile: "shop", defaultTarget: "qa", targets: ["dev", "qa"] })
    } finally {
      delete process.env.DEFER_TEST_TARGET
    }
    expect((await resolveDeferState(path.join(root, "analytics"))).defaultTarget).toBe("dev")
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

  test("the tool answers with the result as metadata and a readable report", async () => {
    settings({ analytics: { deferToProduction: true, favorState: true, manifestPathForDeferral: "${workspaceFolder}/prod-state" } })
    const ctx: Tool.Context = {
      sessionID: SessionID.make("ses_defer_state"),
      messageID: MessageID.make("msg_defer_state"),
      agent: "analyst",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    }
    const tool = await initTool(DbtDeferStateTool as any)
    const ok = await tool.execute({ project_dir: path.join(root, "analytics") }, ctx)
    expect(ok.title).toBe("dbt Defer: on")
    expect(ok.metadata).toMatchObject({ success: true, enabled: true, favorState: true, stateDir: path.join(root, "analytics", "prod-state"), defaultTarget: "dev", targets: ["dev", "prod"] })
    expect(ok.output).toContain(`state dir: ${path.join(root, "analytics", "prod-state")}`)
    expect(ok.output).toContain("defer: on (favor state)")
  })
})
