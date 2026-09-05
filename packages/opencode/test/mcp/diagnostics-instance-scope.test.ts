import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises"
import os, { tmpdir } from "os"
import path from "path"
import { discoverExternalMcp, unresolvedEnvVars, configDrift, discoveredSource } from "../../src/mcp/discover"

let homeDir: string
let homedirSpy: ReturnType<typeof spyOn> | undefined

const VAR_A = "ALTIMATE_TEST_SCOPE_VAR_A"
const VAR_B = "ALTIMATE_TEST_SCOPE_VAR_B"

async function projectWith(server: string, varName: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-scope-"))
  await mkdir(path.join(dir, ".vscode"), { recursive: true })
  await writeFile(
    path.join(dir, ".vscode/mcp.json"),
    JSON.stringify({ servers: { [server]: { command: "node", env: { TOKEN: `{env:${varName}}` } } } }),
  )
  return dir
}

let priorA: string | undefined
let priorB: string | undefined
const created: string[] = []

/** Create a project and register it for teardown, so a failure mid-setup still cleans up. */
async function project(server: string, varName: string): Promise<string> {
  const dir = await projectWith(server, varName)
  created.push(dir)
  return dir
}

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "mcp-scope-home-"))
  homedirSpy = spyOn(os, "homedir").mockImplementation(() => homeDir)
  // Save rather than blindly delete: these are process-wide and a parallel run must not observe
  // a variable this file removed.
  priorA = process.env[VAR_A]
  priorB = process.env[VAR_B]
  delete process.env[VAR_A]
  delete process.env[VAR_B]
})

afterEach(async () => {
  homedirSpy?.mockRestore()
  if (priorA === undefined) delete process.env[VAR_A]
  else process.env[VAR_A] = priorA
  if (priorB === undefined) delete process.env[VAR_B]
  else process.env[VAR_B] = priorB
  await rm(homeDir, { recursive: true, force: true })
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe("MCP diagnostics are project-scoped", () => {
  test("a second project's discovery does not erase the first project's diagnostics", async () => {
    const projectA = await project("alpha", VAR_A)
    const projectB = await project("beta", VAR_B)
    await discoverExternalMcp(projectA)
    expect(unresolvedEnvVars("alpha", projectA)).toContain(VAR_A)

    // A second session in the same process discovers for a different project. Project A's
    // session is still open and still asking about its own servers.
    await discoverExternalMcp(projectB)

    expect(unresolvedEnvVars("beta", projectB)).toContain(VAR_B)
    // The failing half: a module-global record cleared per run means A's answer is gone.
    expect(unresolvedEnvVars("alpha", projectA)).toContain(VAR_A)
  })

  test("two projects reusing one server name keep separate diagnostics", async () => {
    // Server names are not unique across projects — `datamate` is the obvious example.
    const projectA = await project("datamate", VAR_A)
    const projectB = await project("datamate", VAR_B)
    await discoverExternalMcp(projectA)
    await discoverExternalMcp(projectB)

    expect(unresolvedEnvVars("datamate", projectB)).toContain(VAR_B)
    expect(unresolvedEnvVars("datamate", projectB)).not.toContain(VAR_A)
    expect(unresolvedEnvVars("datamate", projectA)).toContain(VAR_A)
    expect(unresolvedEnvVars("datamate", projectA)).not.toContain(VAR_B)
  })

  test("concurrent discovery does not interleave one project's clear with another's writes", async () => {
    const projectA = await project("alpha", VAR_A)
    const projectB = await project("beta", VAR_B)
    await Promise.all([discoverExternalMcp(projectA), discoverExternalMcp(projectB)])
    expect(unresolvedEnvVars("alpha", projectA)).toContain(VAR_A)
    expect(unresolvedEnvVars("beta", projectB)).toContain(VAR_B)
  })

  test("discoveredSource and configDrift are per project", async () => {
    const projectA = await project("alpha", VAR_A)
    const projectB = await project("beta", VAR_B)
    await discoverExternalMcp(projectA)
    await discoverExternalMcp(projectB)
    expect(discoveredSource("alpha", projectA)).toContain(".vscode/mcp.json")
    expect(configDrift(projectA).every((d) => d.server !== "beta")).toBe(true)
  })
})
