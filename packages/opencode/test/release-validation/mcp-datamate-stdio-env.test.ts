import { describe, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { mkdir, writeFile, readFile } from "fs/promises"
import path from "path"
import {
  readDatamateTransportFromIde,
  syncDatamateUrlFromVscodeMcp,
  resolveDatamateSyncRoot,
  DATAMATE_KEY,
  DATAMATE_PROVENANCE,
} from "../../src/altimate/datamate-transport"

// Regression tests for the stdio env carry-through. The IDE extension writes the
// datamate stdio entry with an env block — on desktop editors the entry's command
// is the editor's Electron binary and env carries ELECTRON_RUN_AS_NODE=1, without
// which the spawn boots the editor GUI and opens datamate-cli.js as a document
// instead of running it. readDatamateTransportFromIde used to drop env entirely,
// so `datamate_manager add` persisted a broken entry that re-popped the file on
// every session launch.

/** Env-less broken entry as a fixed `datamate_manager add` would have stamped it. */
function stamped(root: string) {
  return {
    type: "local",
    command: ["/path/to/electron", "cli.js"],
    enabled: true,
    managedBy: DATAMATE_PROVENANCE,
    sourceMcpJson: path.join(root, ".vscode", "mcp.json"),
  }
}

async function seedIdeStdio(dir: string, entry: Record<string, unknown>) {
  await mkdir(path.join(dir, ".vscode"), { recursive: true })
  await writeFile(
    path.join(dir, ".vscode", "mcp.json"),
    JSON.stringify({ servers: { [DATAMATE_KEY]: entry } }, null, 2),
  )
}

describe("readDatamateTransportFromIde stdio env carry-through", () => {
  test("carries env minus ALTIMATE_EXTENSION_RPC, plus updatedAt", async () => {
    await using tmp = await tmpdir()
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["/ext/dist/datamate-cli.js", "start-stdio"],
      env: {
        ALTIMATE_EXTENSION_RPC: "/tmp/altimate-mcp-1.sock",
        ELECTRON_RUN_AS_NODE: "1",
      },
      updatedAt: "2026-08-06T00:00:00.000Z",
    })

    const t = await readDatamateTransportFromIde(tmp.path)
    expect(t).toEqual({
      type: "local",
      command: ["/path/to/electron", "/ext/dist/datamate-cli.js", "start-stdio"],
      environment: { ELECTRON_RUN_AS_NODE: "1" },
      updatedAt: "2026-08-06T00:00:00.000Z",
      source: path.join(tmp.path, ".vscode", "mcp.json"),
    })
  })

  test("env with only ALTIMATE_EXTENSION_RPC → environment omitted entirely", async () => {
    await using tmp = await tmpdir()
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/usr/lib/code-server/lib/node",
      args: ["/ext/dist/datamate-cli.js", "start-stdio"],
      env: { ALTIMATE_EXTENSION_RPC: "/tmp/altimate-mcp-1.sock" },
    })

    const t = await readDatamateTransportFromIde(tmp.path)
    expect(t).toEqual({
      type: "local",
      command: ["/usr/lib/code-server/lib/node", "/ext/dist/datamate-cli.js", "start-stdio"],
      source: path.join(tmp.path, ".vscode", "mcp.json"),
    })
  })

  test("remote entry carries updatedAt for sync parity, bare shape without it", async () => {
    await using tmp = await tmpdir()
    await seedIdeStdio(tmp.path, {
      type: "http",
      url: "http://localhost:7801/mcp",
      updatedAt: "2026-08-06T00:00:00.000Z",
    })

    const t = await readDatamateTransportFromIde(tmp.path)
    expect(t).toEqual({
      type: "remote",
      url: "http://localhost:7801/mcp",
      updatedAt: "2026-08-06T00:00:00.000Z",
      source: path.join(tmp.path, ".vscode", "mcp.json"),
    })
  })

  test("entry without env keeps the bare local shape (back-compat)", async () => {
    await using tmp = await tmpdir()
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "datamate",
      args: ["start-stdio"],
    })

    const t = await readDatamateTransportFromIde(tmp.path)
    expect(t).toEqual({ type: "local", command: ["datamate", "start-stdio"], source: path.join(tmp.path, ".vscode", "mcp.json"), })
  })

  test("non-string env values are ignored, string values kept", async () => {
    await using tmp = await tmpdir()
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["start-stdio"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        BOGUS_NUMBER: 42,
        BOGUS_OBJECT: { nested: true },
      },
    })

    const t = await readDatamateTransportFromIde(tmp.path)
    expect(t?.type).toBe("local")
    if (t?.type === "local") {
      expect(t.environment).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
    }
  })
})

describe("resolveDatamateSyncRoot", () => {
  test("resolves the containing git project root from a subdirectory", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".git"), { recursive: true })
    await mkdir(path.join(tmp.path, "packages", "deep"), { recursive: true })

    const root = await resolveDatamateSyncRoot(path.join(tmp.path, "packages", "deep"))
    expect(root).toBe(tmp.path)
  })

  test("falls back to the directory itself outside a git project", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "plain"), { recursive: true })

    const root = await resolveDatamateSyncRoot(path.join(tmp.path, "plain"))
    expect(root).toBe(path.join(tmp.path, "plain"))
  })
})

describe("blanked {} datamate entries (non-active-IDE tombstones)", () => {
  test("readDatamateTransportFromIde skips a blanked entry that sorts first", async () => {
    await using tmp = await tmpdir()
    // .cursor sorts before .vscode; the extension blanks datamate to {} in
    // non-active-IDE files.
    await mkdir(path.join(tmp.path, ".cursor"), { recursive: true })
    await writeFile(path.join(tmp.path, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { [DATAMATE_KEY]: {} } }))
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["/ext/dist/datamate-cli.js", "start-stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      updatedAt: "T9",
    })

    const t = await readDatamateTransportFromIde(tmp.path)
    expect(t?.type).toBe("local")
    if (t?.type === "local") {
      expect(t.command[0]).toBe("/path/to/electron")
      expect(t.environment).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
    }
  })

  test("sync source selection skips a blanked entry that sorts first", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "isolated-global")
    await mkdir(path.join(tmp.path, ".cursor"), { recursive: true })
    await writeFile(path.join(tmp.path, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { [DATAMATE_KEY]: {} } }))
    const configPath = path.join(tmp.path, "altimate-code.json")
    await writeFile(
      configPath,
      JSON.stringify(
        { mcp: { [DATAMATE_KEY]: stamped(tmp.path) } },
        null,
        2,
      ),
    )
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["/ext/dist/datamate-cli.js", "start-stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      updatedAt: "T10",
    })

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path, globalDir)
    expect(updated).toContain(DATAMATE_KEY)

    const entry = JSON.parse(await readFile(configPath, "utf-8")).mcp[DATAMATE_KEY]
    expect(entry.environment).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
    expect(entry.updatedAt).toBe("T10")
  })
})

describe("syncDatamateUrlFromVscodeMcp stdio env parity", () => {
  test("synced local entry strips ALTIMATE_EXTENSION_RPC but keeps ELECTRON_RUN_AS_NODE", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "altimate-code.json")
    await writeFile(
      configPath,
      JSON.stringify(
        { mcp: { [DATAMATE_KEY]: { type: "local", command: ["stale"], enabled: true, updatedAt: "T1" } } },
        null,
        2,
      ),
    )
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["/ext/dist/datamate-cli.js", "start-stdio"],
      env: {
        ALTIMATE_EXTENSION_RPC: "/tmp/altimate-mcp-1.sock",
        ELECTRON_RUN_AS_NODE: "1",
      },
      updatedAt: "T2",
    })

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path, path.join(tmp.path, "isolated-global"))
    expect(updated).toContain(DATAMATE_KEY)

    const after = JSON.parse(await readFile(configPath, "utf-8"))
    const entry = after.mcp[DATAMATE_KEY]
    expect(entry.type).toBe("local")
    expect(entry.command).toEqual(["/path/to/electron", "/ext/dist/datamate-cli.js", "start-stdio"])
    expect(entry.environment).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
    expect(entry.updatedAt).toBe("T2")
    expect(entry.enabled).toBe(true) // non-transport field preserved
  })

  test("heals a datamate entry living only in the GLOBAL config", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "global-config")
    await mkdir(globalDir, { recursive: true })
    const globalConfigPath = path.join(globalDir, "altimate-code.json")
    await writeFile(
      globalConfigPath,
      JSON.stringify(
        { mcp: { [DATAMATE_KEY]: stamped(tmp.path) } },
        null,
        2,
      ),
    )
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["/ext/dist/datamate-cli.js", "start-stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      updatedAt: "T3",
    })

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path, globalDir)
    expect(updated).toContain(DATAMATE_KEY)

    const after = JSON.parse(await readFile(globalConfigPath, "utf-8"))
    const entry = after.mcp[DATAMATE_KEY]
    expect(entry.environment).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
    expect(entry.updatedAt).toBe("T3")
    expect(entry.enabled).toBe(true)
  })

  test("invocation from a nested subdirectory heals root-level configs", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "global-config")
    await mkdir(globalDir, { recursive: true })
    await mkdir(path.join(tmp.path, ".git"), { recursive: true })
    await mkdir(path.join(tmp.path, "packages", "deep"), { recursive: true })
    const projectConfigPath = path.join(tmp.path, "altimate-code.json")
    await writeFile(
      projectConfigPath,
      JSON.stringify(
        { mcp: { [DATAMATE_KEY]: stamped(tmp.path) } },
        null,
        2,
      ),
    )
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["/ext/dist/datamate-cli.js", "start-stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      updatedAt: "T5",
    })

    const updated = await syncDatamateUrlFromVscodeMcp(path.join(tmp.path, "packages", "deep"), globalDir)
    expect(updated).toContain(DATAMATE_KEY)

    const entry = JSON.parse(await readFile(projectConfigPath, "utf-8")).mcp[DATAMATE_KEY]
    expect(entry.environment).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
  })

  test("a malformed config file does not abort healing the remaining files", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "global-config")
    await mkdir(globalDir, { recursive: true })
    // Project config is truncated garbage — addMcpToConfig refuses to rewrite it.
    const projectConfigPath = path.join(tmp.path, "altimate-code.json")
    await writeFile(projectConfigPath, '{"mcp": {"datamate": {"type": "local", "command": ["x"')
    const globalConfigPath = path.join(globalDir, "altimate-code.json")
    await writeFile(
      globalConfigPath,
      JSON.stringify(
        { mcp: { [DATAMATE_KEY]: stamped(tmp.path) } },
        null,
        2,
      ),
    )
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["/ext/dist/datamate-cli.js", "start-stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      updatedAt: "T6",
    })

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path, globalDir)
    expect(updated).toContain(DATAMATE_KEY)

    const entry = JSON.parse(await readFile(globalConfigPath, "utf-8")).mcp[DATAMATE_KEY]
    expect(entry.environment).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
  })

  test("heals a global entry living in altimate-code.jsonc (loader-merged filename)", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "global-config")
    await mkdir(globalDir, { recursive: true })
    const globalJsoncPath = path.join(globalDir, "altimate-code.jsonc")
    await writeFile(
      globalJsoncPath,
      JSON.stringify(
        { mcp: { [DATAMATE_KEY]: stamped(tmp.path) } },
        null,
        2,
      ),
    )
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["/ext/dist/datamate-cli.js", "start-stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      updatedAt: "T7",
    })

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path, globalDir)
    expect(updated).toContain(DATAMATE_KEY)

    const entry = JSON.parse(await readFile(globalJsoncPath, "utf-8")).mcp[DATAMATE_KEY]
    expect(entry.environment).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
  })

  test("legacy config.json is healed in the GLOBAL dir but left alone at project level", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "global-config")
    await mkdir(globalDir, { recursive: true })
    const brokenEntry = stamped(tmp.path)
    // Global legacy config.json IS merged by the config loader → must heal.
    const globalLegacyPath = path.join(globalDir, "config.json")
    await writeFile(globalLegacyPath, JSON.stringify({ mcp: { [DATAMATE_KEY]: brokenEntry } }, null, 2))
    // Project config.json is NOT read by the loader → must not be touched.
    const projectConfigJsonPath = path.join(tmp.path, "config.json")
    const unrelated = JSON.stringify({ mcp: { [DATAMATE_KEY]: brokenEntry } }, null, 2)
    await writeFile(projectConfigJsonPath, unrelated)
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["/ext/dist/datamate-cli.js", "start-stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      updatedAt: "T8",
    })

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path, globalDir)
    expect(updated).toContain(DATAMATE_KEY)

    const globalEntry = JSON.parse(await readFile(globalLegacyPath, "utf-8")).mcp[DATAMATE_KEY]
    expect(globalEntry.environment).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
    // Byte-identical: the project-level config.json was never rewritten.
    expect(await readFile(projectConfigJsonPath, "utf-8")).toBe(unrelated)
  })

  test("heals project and global entries in one pass", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "global-config")
    await mkdir(globalDir, { recursive: true })
    const brokenEntry = stamped(tmp.path)
    const projectConfigPath = path.join(tmp.path, "altimate-code.json")
    const globalConfigPath = path.join(globalDir, "altimate-code.json")
    await writeFile(projectConfigPath, JSON.stringify({ mcp: { [DATAMATE_KEY]: brokenEntry } }, null, 2))
    await writeFile(globalConfigPath, JSON.stringify({ mcp: { [DATAMATE_KEY]: brokenEntry } }, null, 2))
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["/ext/dist/datamate-cli.js", "start-stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      updatedAt: "T4",
    })

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path, globalDir)
    expect(updated).toEqual([DATAMATE_KEY]) // reported once, not per file

    for (const p of [projectConfigPath, globalConfigPath]) {
      const entry = JSON.parse(await readFile(p, "utf-8")).mcp[DATAMATE_KEY]
      expect(entry.environment).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
      expect(entry.updatedAt).toBe("T4")
    }
  })
})

describe("review hardening: allowlist, validation, provenance, bounded root, nested configs", () => {
  test("only ELECTRON_RUN_AS_NODE is carried from the IDE env (allowlist, not denylist)", async () => {
    await using tmp = await tmpdir()
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["cli.js", "start-stdio"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--require /tmp/evil.js",
        LD_PRELOAD: "/tmp/evil.so",
        PATH: "/tmp/evil-bin",
        ALTIMATE_EXTENSION_RPC: "/tmp/x.sock",
      },
    })
    const t = await readDatamateTransportFromIde(tmp.path)
    expect(t?.type).toBe("local")
    if (t?.type === "local") expect(t.environment).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
  })

  test("an incomplete IDE entry cannot win source selection nor be persisted as a url-less remote", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "isolated-global")
    // .cursor sorts first and carries a non-empty but transport-less entry.
    await mkdir(path.join(tmp.path, ".cursor"), { recursive: true })
    await writeFile(
      path.join(tmp.path, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { [DATAMATE_KEY]: { type: "stdio", updatedAt: "T-bogus" } } }),
    )
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["cli.js", "start-stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      updatedAt: "T11",
    })
    const configPath = path.join(tmp.path, "altimate-code.json")
    await writeFile(configPath, JSON.stringify({ mcp: { [DATAMATE_KEY]: stamped(tmp.path) } }, null, 2))

    const t = await readDatamateTransportFromIde(tmp.path)
    expect(t?.source).toBe(path.join(tmp.path, ".vscode", "mcp.json"))

    await syncDatamateUrlFromVscodeMcp(tmp.path, globalDir)
    const entry = JSON.parse(await readFile(configPath, "utf-8")).mcp[DATAMATE_KEY]
    expect(entry.type).toBe("local")
    expect(entry.updatedAt).toBe("T11")
    expect("url" in entry).toBe(false)
  })

  test("a lone incomplete IDE entry writes nothing at all", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "isolated-global")
    await seedIdeStdio(tmp.path, { type: "stdio", updatedAt: "T-bogus" })
    const configPath = path.join(tmp.path, "altimate-code.json")
    const before = JSON.stringify({ mcp: { [DATAMATE_KEY]: stamped(tmp.path) } }, null, 2)
    await writeFile(configPath, before)

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path, globalDir)
    expect(updated).toEqual([])
    expect(await readFile(configPath, "utf-8")).toBe(before)
  })

  test("a hand-added GLOBAL entry (no provenance) survives a project-local heal byte-identical", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "global-config")
    await mkdir(globalDir, { recursive: true })
    const globalPath = path.join(globalDir, "altimate-code.json")
    const handAdded = JSON.stringify(
      { mcp: { [DATAMATE_KEY]: { type: "remote", url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer x" } } } },
      null,
      2,
    )
    await writeFile(globalPath, handAdded)
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["cli.js", "start-stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      updatedAt: "T12",
    })

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path, globalDir)
    expect(updated).toEqual([])
    expect(await readFile(globalPath, "utf-8")).toBe(handAdded)
  })

  test("a GLOBAL entry managed from a DIFFERENT project's mcp.json is left alone", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "global-config")
    await mkdir(globalDir, { recursive: true })
    const globalPath = path.join(globalDir, "altimate-code.json")
    const other = JSON.stringify(
      { mcp: { [DATAMATE_KEY]: { ...stamped(tmp.path), sourceMcpJson: "/somewhere/else/.vscode/mcp.json" } } },
      null,
      2,
    )
    await writeFile(globalPath, other)
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["cli.js", "start-stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      updatedAt: "T13",
    })

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path, globalDir)
    expect(updated).toEqual([])
    expect(await readFile(globalPath, "utf-8")).toBe(other)
  })

  test("a nested package's own config (loaded by the config walk) is healed too", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "isolated-global")
    await mkdir(path.join(tmp.path, ".git"), { recursive: true })
    const pkg = path.join(tmp.path, "packages", "app")
    await mkdir(pkg, { recursive: true })
    const nestedConfig = path.join(pkg, "opencode.json")
    await writeFile(nestedConfig, JSON.stringify({ mcp: { [DATAMATE_KEY]: stamped(tmp.path) } }, null, 2))
    await seedIdeStdio(tmp.path, {
      type: "stdio",
      command: "/path/to/electron",
      args: ["cli.js", "start-stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      updatedAt: "T14",
    })

    // Launched from the nested package: the root mcp.json is the IDE source,
    // and the nested config on the launch→root walk is a heal target.
    const updated = await syncDatamateUrlFromVscodeMcp(pkg, globalDir)
    expect(updated).toContain(DATAMATE_KEY)
    const entry = JSON.parse(await readFile(nestedConfig, "utf-8")).mcp[DATAMATE_KEY]
    expect(entry.environment).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
  })

  test("an mcp.json outside the extension-written locations is never a transport source", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "docs", "examples"), { recursive: true })
    await writeFile(
      path.join(tmp.path, "docs", "examples", "mcp.json"),
      JSON.stringify({ servers: { [DATAMATE_KEY]: { command: "/evil", args: [], env: { ELECTRON_RUN_AS_NODE: "1" }, updatedAt: "T" } } }),
    )
    expect(await readDatamateTransportFromIde(tmp.path)).toBeNull()
  })

  test("resolveDatamateSyncRoot: a home directory that is itself a git repo is not a project", async () => {
    await using tmp = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path
    try {
      await mkdir(path.join(tmp.path, ".git"), { recursive: true })
      const deep = path.join(tmp.path, "code", "no-git-here")
      await mkdir(deep, { recursive: true })
      expect(await resolveDatamateSyncRoot(deep)).toBe(deep)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = prev
    }
  })

  test("resolveDatamateSyncRoot: a .git FILE (worktree/submodule) marks the nearest project root", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".git"), { recursive: true })
    const wt = path.join(tmp.path, "modules", "sub")
    await mkdir(path.join(wt, "src"), { recursive: true })
    await writeFile(path.join(wt, ".git"), "gitdir: ../../.git/modules/sub\n")
    expect(await resolveDatamateSyncRoot(path.join(wt, "src"))).toBe(wt)
  })
})
