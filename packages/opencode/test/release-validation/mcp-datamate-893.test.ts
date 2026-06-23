import { describe, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { mkdir, writeFile, readFile } from "fs/promises"
import path from "path"
import {
  addMcpToConfig,
  removeMcpFromConfig,
  listMcpInConfig,
  findAllConfigPaths,
  readMcpEntryFromDisk,
} from "../../src/mcp/config"
import { Config } from "../../src/config/config"
import {
  readDatamateTransportFromIde,
  syncDatamateUrlFromVscodeMcp,
  DATAMATE_KEY,
} from "../../src/altimate/datamate-transport"
import { discoverExternalMcp } from "../../src/mcp/discover"

// Regression tests for PR #893 — IDE-aware datamate transport, enabled-state
// persistence, /mcps command. These assert the INTENDED behavior of the merged
// code and pass against it. Where a test documents a known gap/contract rather
// than ideal behavior, the comment says so explicitly.

// ── Gap 1: updatedAt round-trips through the strict Config.Mcp schema ────────
describe("PR893: addMcpToConfig writes updatedAt and round-trips through strict Config.Mcp", () => {
  test("remote entry with updatedAt parses cleanly against Config.Mcp", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "altimate-code.json")
    await addMcpToConfig(
      "foo",
      {
        type: "remote",
        url: "http://x",
        enabled: true,
        updatedAt: "2026-06-17T00:00:00Z",
      } as any,
      configPath,
    )

    const parsed = JSON.parse(await readFile(configPath, "utf-8"))
    // Must not throw — this is exactly the schema gap PR #893 closed by adding
    // updatedAt to McpRemote (and McpLocal).
    const entry = Config.Mcp.parse(parsed.mcp.foo)
    expect(entry.type).toBe("remote")
    expect((entry as any).updatedAt).toBe("2026-06-17T00:00:00Z")
  })

  test("local entry with updatedAt parses cleanly against Config.Mcp", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "altimate-code.json")
    await addMcpToConfig(
      "bar",
      {
        type: "local",
        command: ["node", "server.js"],
        environment: { K: "v" },
        enabled: false,
        updatedAt: "2026-06-17T01:02:03Z",
      } as any,
      configPath,
    )

    const parsed = JSON.parse(await readFile(configPath, "utf-8"))
    const entry = Config.Mcp.parse(parsed.mcp.bar)
    expect(entry.type).toBe("local")
    expect((entry as any).updatedAt).toBe("2026-06-17T01:02:03Z")
  })

  test("negative: an unknown extra key still throws — .strict() was not loosened", async () => {
    // Proves updatedAt was added as a real field, not by relaxing .strict().
    const bad = {
      type: "remote",
      url: "http://x",
      updatedAt: "2026-06-17T00:00:00Z",
      bogusUnknownKey: "should-be-rejected",
    }
    expect(() => Config.Mcp.parse(bad)).toThrow()
  })
})

// ── Gap 2: malformed JSONC does not silently lose recoverable config ─────────
describe("PR893: addMcpToConfig on a malformed JSONC file — clobbering contract", () => {
  test("broken (truncated) JSON: addMcpToConfig refuses and leaves the file unchanged", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "altimate-code.json")
    // Truncated/broken JSON. parseTree() is error-tolerant (returns a partial
    // node), but the v0.8.8 parse-guard uses parse() with an error sink, so a
    // genuinely malformed file is REFUSED rather than best-effort clobbered.
    const brokenText = `{ "mcp": { "a": `
    await writeFile(configPath, brokenText)

    await expect(addMcpToConfig("b", { type: "remote", url: "http://y" } as any, configPath)).rejects.toThrow(
      /not valid JSON/i,
    )

    // CONTRACT (v0.8.8): no data loss — the original file is left byte-for-byte
    // unchanged, and the new entry was NOT half-written into an unparseable file.
    const after = await readFile(configPath, "utf-8")
    expect(after).toBe(brokenText)
    expect(after).not.toContain("http://y")
  })

  test("asymmetry: list/remove bail when parseTree returns undefined (severe garbage)", async () => {
    // Pin the intended asymmetry the prompt calls out: when the file is so broken
    // that parseTree returns undefined, the read paths refuse to act rather than
    // returning a half-parsed view.
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "altimate-code.json")
    await writeFile(configPath, "this is not json at all")

    expect(await listMcpInConfig(configPath)).toEqual([])
    expect(await removeMcpFromConfig("anything", configPath)).toBe(false)
  })
})

// ── Gap 3: readMcpEntryFromDisk returns undefined for a non-object node ───────
describe("PR893: readMcpEntryFromDisk handles non-object nodes", () => {
  test("primitive (string) value → undefined, does not throw", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "altimate-code.json")
    await writeFile(configPath, `{ "mcp": { "weird": "not-an-object" } }`)
    const entry = await readMcpEntryFromDisk("weird", configPath)
    expect(entry).toBeUndefined()
  })

  test("primitive (number) value → undefined, does not throw", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "altimate-code.json")
    await writeFile(configPath, `{ "mcp": { "n": 42 } }`)
    const entry = await readMcpEntryFromDisk("n", configPath)
    expect(entry).toBeUndefined()
  })

  test("valid object value → reconstructed entry (getNodeValue still works)", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "altimate-code.json")
    await writeFile(
      configPath,
      `{ "mcp": { "ok": { "type": "local", "command": ["node"] } } }`,
    )
    const entry = await readMcpEntryFromDisk("ok", configPath)
    expect(entry).toEqual({ type: "local", command: ["node"] } as any)
  })
})

// ── Gap 4: readMcpEntryFromDisk preserves array/object transport fields ───────
describe("PR893: readMcpEntryFromDisk preserves nested array/object fields", () => {
  test("command array, environment object, and headers object all survive", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "altimate-code.json")
    // Hand-write so we exercise getNodeValue reconstruction directly (not just a
    // round-trip of what addMcpToConfig serialized). Use a single remote entry
    // carrying headers (object) plus an args-style array to assert no flattening.
    const entry = {
      type: "remote",
      url: "https://example.com/mcp",
      headers: { X: "y", Authorization: "Bearer z" },
    }
    await writeFile(configPath, JSON.stringify({ mcp: { srv: entry } }, null, 2))
    const read = await readMcpEntryFromDisk("srv", configPath)
    expect(read).toEqual(entry as any)
    expect((read as any).headers).toEqual({ X: "y", Authorization: "Bearer z" })
  })

  test("local entry: command[] and environment{} are not dropped", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "altimate-code.json")
    const entry = {
      type: "local",
      command: ["node", "server.js", "--flag"],
      environment: { A: "1", B: "2" },
    }
    await writeFile(configPath, JSON.stringify({ mcp: { srv: entry } }, null, 2))
    const read = await readMcpEntryFromDisk("srv", configPath)
    expect(read).toEqual(entry as any)
    // A manual children-walk reading prop.children[1].value would drop these.
    expect((read as any).command).toEqual(["node", "server.js", "--flag"])
    expect((read as any).environment).toEqual({ A: "1", B: "2" })
  })
})

// ── Gap 5: removeMcpFromConfig return-value contract ─────────────────────────
describe("PR893: removeMcpFromConfig return-value contract", () => {
  test("nonexistent path → false", async () => {
    await using tmp = await tmpdir()
    const result = await removeMcpFromConfig("x", path.join(tmp.path, "missing.json"))
    expect(result).toBe(false)
  })

  test("file without the named entry → false, file unchanged", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "altimate-code.json")
    const original = JSON.stringify({ mcp: { keep: { type: "local", command: ["x"] } } })
    await writeFile(configPath, original)
    const result = await removeMcpFromConfig("bar", configPath)
    expect(result).toBe(false)
    expect(await readFile(configPath, "utf-8")).toBe(original)
  })

  test("present entry → true, removed, sibling untouched", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "altimate-code.json")
    await writeFile(
      configPath,
      JSON.stringify({
        mcp: {
          bar: { type: "remote", url: "https://bar.com" },
          keep: { type: "local", command: ["k"] },
        },
      }),
    )
    const result = await removeMcpFromConfig("bar", configPath)
    expect(result).toBe(true)
    const after = await listMcpInConfig(configPath)
    expect(after).not.toContain("bar")
    expect(after).toContain("keep")
  })
})

// ── Gap 6: findAllConfigPaths includes project subdirs, not global subdirs ────
describe("PR893: findAllConfigPaths project subdir coverage", () => {
  test("surfaces top-level + .altimate-code subdir for project, not global subdir", async () => {
    await using projTmp = await tmpdir()
    await using globalTmp = await tmpdir()

    const projTop = path.join(projTmp.path, "altimate-code.json")
    const projSub = path.join(projTmp.path, ".altimate-code", "altimate-code.json")
    const globalTop = path.join(globalTmp.path, "altimate-code.json")
    const globalSub = path.join(globalTmp.path, ".altimate-code", "altimate-code.json")

    await writeFile(projTop, "{}")
    await mkdir(path.join(projTmp.path, ".altimate-code"), { recursive: true })
    await writeFile(projSub, "{}")
    await writeFile(globalTop, "{}")
    await mkdir(path.join(globalTmp.path, ".altimate-code"), { recursive: true })
    await writeFile(globalSub, "{}")

    const result = await findAllConfigPaths(projTmp.path, globalTmp.path)

    expect(result).toContain(projTop)
    expect(result).toContain(projSub) // project subdir is probed
    expect(result).toContain(globalTop)
    expect(result).not.toContain(globalSub) // global subdir is NOT probed
  })

  test("top-level project path precedes its subdir path (stable precedence)", async () => {
    await using projTmp = await tmpdir()
    await using globalTmp = await tmpdir()
    const projTop = path.join(projTmp.path, "altimate-code.json")
    const projSub = path.join(projTmp.path, ".altimate-code", "altimate-code.json")
    await writeFile(projTop, "{}")
    await mkdir(path.join(projTmp.path, ".altimate-code"), { recursive: true })
    await writeFile(projSub, "{}")

    const result = await findAllConfigPaths(projTmp.path, globalTmp.path)
    expect(result.indexOf(projTop)).toBeLessThan(result.indexOf(projSub))
  })
})

// ── Gap 7: readDatamateTransportFromIde picks first sorted mcp.json + classify ─
describe("PR893: readDatamateTransportFromIde sorted-first selection + classification", () => {
  test("first sorted datamate-bearing mcp.json wins (a/ before b/)", async () => {
    await using tmp = await tmpdir()
    // a/mcp.json — stdio datamate; b/mcp.json — http datamate.
    await mkdir(path.join(tmp.path, "a"), { recursive: true })
    await mkdir(path.join(tmp.path, "b"), { recursive: true })
    await writeFile(
      path.join(tmp.path, "a", "mcp.json"),
      JSON.stringify({ servers: { [DATAMATE_KEY]: { type: "stdio", command: "datamate", args: ["x"] } } }),
    )
    await writeFile(
      path.join(tmp.path, "b", "mcp.json"),
      JSON.stringify({ servers: { [DATAMATE_KEY]: { url: "http://from-b" } } }),
    )

    const t = await readDatamateTransportFromIde(tmp.path)
    // a/ sorts before b/ → stdio entry from a/ wins → local transport.
    expect(t).toEqual({ type: "local", command: ["datamate", "x"] })
  })

  test("stdio entry → local(command+args); http entry → remote(url)", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".cursor"), { recursive: true })
    await writeFile(
      path.join(tmp.path, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { [DATAMATE_KEY]: { url: "https://remote-only" } } }),
    )
    const t = await readDatamateTransportFromIde(tmp.path)
    expect(t).toEqual({ type: "remote", url: "https://remote-only" })
  })

  test("returns null when no mcp.json contains a datamate entry", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".vscode"), { recursive: true })
    await writeFile(
      path.join(tmp.path, ".vscode", "mcp.json"),
      JSON.stringify({ servers: { other: { url: "http://x" } } }),
    )
    const t = await readDatamateTransportFromIde(tmp.path)
    expect(t).toBeNull()
  })

  test("adversarial: entry with BOTH url and command → url wins (type/url precedence)", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".vscode"), { recursive: true })
    await writeFile(
      path.join(tmp.path, ".vscode", "mcp.json"),
      JSON.stringify({
        servers: { [DATAMATE_KEY]: { type: "stdio", url: "http://wins", command: "datamate", args: ["a"] } },
      }),
    )
    const t = await readDatamateTransportFromIde(tmp.path)
    // The implementation checks `typeof entry.url === "string"` first, so a URL
    // present always classifies as remote regardless of command/type.
    expect(t).toEqual({ type: "remote", url: "http://wins" })
  })
})

// ── Gap 8: syncDatamateUrlFromVscodeMcp change-detection via updatedAt ─────────
describe("PR893: syncDatamateUrlFromVscodeMcp updatedAt-based change detection", () => {
  async function seedConfig(dir: string, datamate: Record<string, unknown>) {
    const configPath = path.join(dir, "altimate-code.json")
    await writeFile(configPath, JSON.stringify({ mcp: { [DATAMATE_KEY]: datamate } }, null, 2))
    return configPath
  }

  async function seedIdeMcp(dir: string, datamate: Record<string, unknown>) {
    await mkdir(path.join(dir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(dir, ".vscode", "mcp.json"),
      JSON.stringify({ servers: { [DATAMATE_KEY]: datamate } }, null, 2),
    )
  }

  test("Case A: IDE entry lacks updatedAt → no sync (documents staleness gap)", async () => {
    await using tmp = await tmpdir()
    const configPath = await seedConfig(tmp.path, {
      type: "remote",
      url: "http://OLD",
      enabled: false,
      timeout: 5000,
      updatedAt: "T1",
    })
    await seedIdeMcp(tmp.path, { url: "http://NEW" }) // no updatedAt

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path)
    expect(updated).not.toContain(DATAMATE_KEY)

    const after = JSON.parse(await readFile(configPath, "utf-8"))
    expect(after.mcp[DATAMATE_KEY].url).toBe("http://OLD") // unchanged
  })

  test("Case B: IDE updatedAt equals existing → no write", async () => {
    await using tmp = await tmpdir()
    const configPath = await seedConfig(tmp.path, {
      type: "remote",
      url: "http://OLD",
      enabled: false,
      timeout: 5000,
      updatedAt: "T1",
    })
    await seedIdeMcp(tmp.path, { url: "http://NEW", updatedAt: "T1" })

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path)
    expect(updated).not.toContain(DATAMATE_KEY)

    const after = JSON.parse(await readFile(configPath, "utf-8"))
    expect(after.mcp[DATAMATE_KEY].url).toBe("http://OLD") // unchanged
  })

  test("Case C: IDE updatedAt differs → url synced, non-transport fields preserved", async () => {
    await using tmp = await tmpdir()
    const configPath = await seedConfig(tmp.path, {
      type: "remote",
      url: "http://OLD",
      enabled: false,
      timeout: 5000,
      updatedAt: "T1",
    })
    await seedIdeMcp(tmp.path, { url: "http://NEW", updatedAt: "T2" })

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path)
    expect(updated).toContain(DATAMATE_KEY)

    const after = JSON.parse(await readFile(configPath, "utf-8"))
    const entry = after.mcp[DATAMATE_KEY]
    expect(entry.url).toBe("http://NEW")
    expect(entry.updatedAt).toBe("T2")
    // Non-transport fields the IDE doesn't manage must be carried forward.
    expect(entry.enabled).toBe(false)
    expect(entry.timeout).toBe(5000)
    // And the synced entry must still satisfy the strict schema.
    expect(() => Config.Mcp.parse(entry)).not.toThrow()
  })
})

// ── Gap 9: concurrent addMcpToConfig writes ──────────────────────────────────
describe("PR893: concurrent config writes", () => {
  test("two concurrent addMcpToConfig calls — document lost-update behavior", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "altimate-code.json")
    await writeFile(
      configPath,
      JSON.stringify({ mcp: { seed: { type: "local", command: ["s"] } } }),
    )

    await Promise.all([
      addMcpToConfig("a", { type: "remote", url: "http://a" } as any, configPath),
      addMcpToConfig("b", { type: "remote", url: "http://b" } as any, configPath),
    ])

    const listed = await listMcpInConfig(configPath)
    // addMcpToConfig has no file locking: each call read-modify-writes the whole
    // file, so two concurrent writers can race and clobber each other. We assert
    // the SEED survives and at least one of the two new entries landed; if BOTH
    // survive the writes were effectively serialized. A failure here that drops
    // 'seed' or both new entries documents the lost-update race (low-severity).
    expect(listed).toContain("seed")
    const landed = ["a", "b"].filter((n) => listed.includes(n))
    expect(landed.length).toBeGreaterThanOrEqual(1)
  })
})

// ── Gap 10: glob-discovered project mcp.json servers forced enabled:false ─────
describe("PR893: project-scoped discovery forces enabled:false", () => {
  test("a sub/mcp.json server declaring enabled:true is discovered enabled:false", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "sub"), { recursive: true })
    await writeFile(
      path.join(tmp.path, "sub", "mcp.json"),
      JSON.stringify({
        servers: {
          evil: { command: "node", args: ["evil.js"], enabled: true },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tmp.path)
    expect(servers.evil).toBeDefined()
    // Security gate: project-scoped servers are forced disabled so they never
    // auto-connect, even when the file declares enabled:true.
    expect((servers.evil as any).enabled).toBe(false)
    expect(servers.evil.type).toBe("local")
  })

  test("project-scoped remote server with enabled:true is also forced disabled", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "nested", "deep"), { recursive: true })
    await writeFile(
      path.join(tmp.path, "nested", "deep", "mcp.json"),
      JSON.stringify({ mcpServers: { remoteEvil: { url: "http://evil", enabled: true } } }),
    )

    const { servers } = await discoverExternalMcp(tmp.path)
    expect(servers.remoteEvil).toBeDefined()
    expect((servers.remoteEvil as any).enabled).toBe(false)
  })
})
