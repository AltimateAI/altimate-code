import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import path from "path"
import os from "os"
import fsp from "fs/promises"

import { AltimateApi } from "../../src/altimate/api/client"

const tmpRoot = path.join(os.tmpdir(), "sign-out-test-" + process.pid + "-" + Math.random().toString(36).slice(2))
const originalTestHome = process.env.OPENCODE_TEST_HOME

const datamateEntry = (key: string) => ({
  type: "remote",
  url: "https://mcp.test",
  oauth: false,
  headers: { Authorization: `Bearer ${key}`, "x-datamate-id": "1", "x-tenant": "tenant" },
})

async function writeJson(file: string, value: unknown) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(value))
}

const readJson = async (file: string) => JSON.parse(await fsp.readFile(file, "utf8"))

describe("AltimateApi.signOut", () => {
  const home = path.join(tmpRoot, "home")
  const outside = path.join(tmpRoot, "outside")
  const repo = path.join(outside, "repo")
  const subdir = path.join(repo, "models", "staging")
  const rootConfig = path.join(repo, ".altimate-code", "altimate-code.json")
  const outsideConfig = path.join(outside, "altimate-code.json")

  beforeEach(async () => {
    process.env.OPENCODE_TEST_HOME = home
    await fsp.mkdir(path.join(repo, ".git"), { recursive: true })
    await fsp.mkdir(subdir, { recursive: true })
  })

  afterEach(async () => {
    if (originalTestHome === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = originalTestHome
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  test("from a subdirectory, removes entries in configs up to the git root and no further", async () => {
    await writeJson(AltimateApi.credentialsPath(), {
      altimateUrl: "https://api.test",
      altimateInstanceName: "tenant",
      altimateApiKey: "gateway-test-key",
    })
    await writeJson(rootConfig, { mcp: { "datamate-sales": datamateEntry("gateway-test-key") } })
    await writeJson(outsideConfig, { mcp: { "datamate-other": datamateEntry("gateway-test-key") } })

    const removed = await AltimateApi.signOut(subdir)

    expect(removed).toEqual([{ name: "datamate-sales", path: rootConfig }])
    expect(await readJson(rootConfig)).toEqual({ mcp: {} })
    // Above the git root, outside what a session in the repo loads.
    expect(await readJson(outsideConfig)).toEqual({ mcp: { "datamate-other": datamateEntry("gateway-test-key") } })
    expect(await AltimateApi.isConfigured()).toBe(false)
  })

  test("outside git, removes entries in every ancestor config and in ~/.altimate-code", async () => {
    const plain = path.join(tmpRoot, "plain")
    const plainConfig = path.join(plain, ".altimate-code", "altimate-code.json")
    const homeConfig = path.join(home, ".altimate-code", "altimate-code.json")
    await writeJson(AltimateApi.credentialsPath(), {
      altimateUrl: "https://api.test",
      altimateInstanceName: "tenant",
      altimateApiKey: "gateway-test-key",
    })
    await writeJson(plainConfig, { mcp: { "datamate-sales": datamateEntry("gateway-test-key") } })
    await writeJson(homeConfig, { mcp: { "datamate-ops": datamateEntry("gateway-test-key") } })

    const removed = await AltimateApi.signOut(path.join(plain, "a", "b"))

    expect(removed).toContainEqual({ name: "datamate-sales", path: plainConfig })
    expect(removed).toContainEqual({ name: "datamate-ops", path: homeConfig })
    expect(await readJson(plainConfig)).toEqual({ mcp: {} })
    expect(await readJson(homeConfig)).toEqual({ mcp: {} })
  })

  test("keeps the credential file and MCP entries when the saved key can't be read", async () => {
    delete process.env.SIGN_OUT_TEST_MISSING_KEY
    await writeJson(AltimateApi.credentialsPath(), {
      altimateUrl: "https://api.test",
      altimateInstanceName: "tenant",
      altimateApiKey: "${env:SIGN_OUT_TEST_MISSING_KEY}",
    })
    await writeJson(rootConfig, { mcp: { "datamate-sales": datamateEntry("gateway-test-key") } })

    await expect(AltimateApi.signOut(subdir)).rejects.toThrow("could not read the saved key")

    expect(await AltimateApi.isConfigured()).toBe(true)
    expect(await readJson(rootConfig)).toEqual({ mcp: { "datamate-sales": datamateEntry("gateway-test-key") } })
  })

  test("is a no-op when there is no credential file", async () => {
    await writeJson(rootConfig, { mcp: { "datamate-sales": datamateEntry("gateway-test-key") } })

    expect(await AltimateApi.signOut(subdir)).toEqual([])
    expect(await readJson(rootConfig)).toEqual({ mcp: { "datamate-sales": datamateEntry("gateway-test-key") } })
  })
})
