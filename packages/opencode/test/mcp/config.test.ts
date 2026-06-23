import { describe, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { mkdir, writeFile, readFile } from "fs/promises"
import path from "path"
import {
  resolveConfigPath,
  addMcpToConfig,
  removeMcpFromConfig,
  listMcpInConfig,
  findAllConfigPaths,
  readMcpEntryFromDisk,
} from "../../src/mcp/config"

describe("MCP config: resolveConfigPath", () => {
  test("returns .altimate-code subdir config when it exists", async () => {
    await using tmp = await tmpdir()
    const configDir = path.join(tmp.path, ".altimate-code")
    await mkdir(configDir, { recursive: true })
    await writeFile(path.join(configDir, "altimate-code.json"), "{}")
    const result = await resolveConfigPath(tmp.path)
    expect(result).toBe(path.join(configDir, "altimate-code.json"))
  })

  test("prefers .altimate-code over .opencode subdir", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".altimate-code"), { recursive: true })
    await writeFile(path.join(tmp.path, ".altimate-code", "altimate-code.json"), "{}")
    await mkdir(path.join(tmp.path, ".opencode"), { recursive: true })
    await writeFile(path.join(tmp.path, ".opencode", "opencode.json"), "{}")
    const result = await resolveConfigPath(tmp.path)
    expect(result).toBe(path.join(tmp.path, ".altimate-code", "altimate-code.json"))
  })

  test("falls back to root-level config", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, "opencode.json"), "{}")
    const result = await resolveConfigPath(tmp.path)
    expect(result).toBe(path.join(tmp.path, "opencode.json"))
  })

  test("returns first candidate path when no config exists", async () => {
    await using tmp = await tmpdir()
    const result = await resolveConfigPath(tmp.path)
    expect(result).toBe(path.join(tmp.path, ".altimate-code", "altimate-code.json"))
  })

  test("global=true skips subdirectory configs", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".altimate-code"), { recursive: true })
    await writeFile(path.join(tmp.path, ".altimate-code", "altimate-code.json"), "{}")
    await writeFile(path.join(tmp.path, "opencode.json"), "{}")
    const result = await resolveConfigPath(tmp.path, true)
    expect(result).toBe(path.join(tmp.path, "opencode.json"))
  })
})

describe("MCP config: addMcpToConfig + removeMcpFromConfig round-trip", () => {
  test("adds MCP server to empty config", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "opencode.json")
    await addMcpToConfig("test-server", { type: "local", command: ["node", "server.js"] } as any, configPath)
    const content = JSON.parse(await readFile(configPath, "utf-8"))
    expect(content.mcp["test-server"]).toMatchObject({ type: "local", command: ["node", "server.js"] })
  })

  test("adds MCP server to existing config preserving other fields", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "opencode.json")
    await writeFile(configPath, JSON.stringify({ provider: { default: "anthropic" } }))
    await addMcpToConfig("my-server", { type: "remote", url: "https://example.com" } as any, configPath)
    const content = JSON.parse(await readFile(configPath, "utf-8"))
    expect(content.provider.default).toBe("anthropic")
    expect(content.mcp["my-server"].url).toBe("https://example.com")
  })

  test("remove returns false for nonexistent config file", async () => {
    await using tmp = await tmpdir()
    const result = await removeMcpFromConfig("nope", path.join(tmp.path, "missing.json"))
    expect(result).toBe(false)
  })

  test("remove returns false for nonexistent server name", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "opencode.json")
    await writeFile(configPath, JSON.stringify({ mcp: { existing: { type: "local", command: ["x"] } } }))
    const result = await removeMcpFromConfig("nonexistent", configPath)
    expect(result).toBe(false)
  })

  test("add then remove round-trips correctly", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "opencode.json")
    await addMcpToConfig("ephemeral", { type: "local", command: ["test"] } as any, configPath)
    const listed = await listMcpInConfig(configPath)
    expect(listed).toContain("ephemeral")
    const removed = await removeMcpFromConfig("ephemeral", configPath)
    expect(removed).toBe(true)
    const after = await listMcpInConfig(configPath)
    expect(after).not.toContain("ephemeral")
  })
})

describe("MCP config: readMcpEntryFromDisk round-trip", () => {
  test("preserves command array and environment object for local entries", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "opencode.json")
    const local = {
      type: "local",
      command: ["node", "/path/to/datamate", "start-stdio"],
      environment: { DATAMATE_KEY: "abc" },
      enabled: false,
    }
    await addMcpToConfig("datamate", local as any, configPath)
    const entry = await readMcpEntryFromDisk("datamate", configPath)
    expect(entry).toEqual(local as any)
  })

  test("preserves headers object for remote entries", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "opencode.json")
    const remote = {
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer xyz" },
      enabled: true,
    }
    await addMcpToConfig("knowledge", remote as any, configPath)
    const entry = await readMcpEntryFromDisk("knowledge", configPath)
    expect(entry).toEqual(remote as any)
  })

  test("persist-enabled flow does not corrupt local command/environment", async () => {
    // Mirrors persistMcpEnabled: read entry from disk, then write back {...entry, enabled}.
    // A node-walker that drops array/object fields would strip command + environment here.
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "opencode.json")
    await addMcpToConfig(
      "datamate",
      { type: "local", command: ["node", "/p"], environment: { K: "v" }, enabled: false } as any,
      configPath,
    )

    const entry = await readMcpEntryFromDisk("datamate", configPath)
    expect(entry).toBeDefined()
    await addMcpToConfig("datamate", { ...(entry as any), enabled: true }, configPath)

    const after = await readMcpEntryFromDisk("datamate", configPath)
    expect(after).toEqual({
      type: "local",
      command: ["node", "/p"],
      environment: { K: "v" },
      enabled: true,
    } as any)
  })

  test("returns undefined for missing file or unknown name", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "opencode.json")
    expect(await readMcpEntryFromDisk("x", path.join(tmp.path, "missing.json"))).toBeUndefined()
    await writeFile(configPath, JSON.stringify({ mcp: { a: { type: "local", command: ["x"] } } }))
    expect(await readMcpEntryFromDisk("nope", configPath)).toBeUndefined()
  })
})

describe("MCP config: listMcpInConfig", () => {
  test("returns empty array for missing file", async () => {
    await using tmp = await tmpdir()
    const result = await listMcpInConfig(path.join(tmp.path, "nope.json"))
    expect(result).toEqual([])
  })

  test("returns empty array for config without mcp key", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "opencode.json")
    await writeFile(configPath, JSON.stringify({ provider: {} }))
    const result = await listMcpInConfig(configPath)
    expect(result).toEqual([])
  })

  test("lists all server names", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "opencode.json")
    await writeFile(
      configPath,
      JSON.stringify({
        mcp: {
          alpha: { type: "local", command: ["a"] },
          beta: { type: "remote", url: "https://b.com" },
        },
      }),
    )
    const result = await listMcpInConfig(configPath)
    expect(result).toEqual(expect.arrayContaining(["alpha", "beta"]))
    expect(result).toHaveLength(2)
  })
})

describe("MCP config: findAllConfigPaths", () => {
  test("returns paths from both project and global dirs", async () => {
    await using projTmp = await tmpdir()
    await using globalTmp = await tmpdir()
    await writeFile(path.join(projTmp.path, "opencode.json"), "{}")
    await writeFile(path.join(globalTmp.path, "altimate-code.json"), "{}")
    const result = await findAllConfigPaths(projTmp.path, globalTmp.path)
    expect(result).toContain(path.join(projTmp.path, "opencode.json"))
    expect(result).toContain(path.join(globalTmp.path, "altimate-code.json"))
  })

  test("includes project subdirs but not global subdirs", async () => {
    await using projTmp = await tmpdir()
    await using globalTmp = await tmpdir()
    // Create config in project .opencode subdir
    await mkdir(path.join(projTmp.path, ".opencode"), { recursive: true })
    await writeFile(path.join(projTmp.path, ".opencode", "opencode.json"), "{}")
    // Create config in global .opencode subdir (should NOT be found)
    await mkdir(path.join(globalTmp.path, ".opencode"), { recursive: true })
    await writeFile(path.join(globalTmp.path, ".opencode", "opencode.json"), "{}")
    const result = await findAllConfigPaths(projTmp.path, globalTmp.path)
    expect(result).toContain(path.join(projTmp.path, ".opencode", "opencode.json"))
    expect(result).not.toContain(path.join(globalTmp.path, ".opencode", "opencode.json"))
  })

  test("returns empty when no config files exist", async () => {
    await using projTmp = await tmpdir()
    await using globalTmp = await tmpdir()
    const result = await findAllConfigPaths(projTmp.path, globalTmp.path)
    expect(result).toEqual([])
  })
})
