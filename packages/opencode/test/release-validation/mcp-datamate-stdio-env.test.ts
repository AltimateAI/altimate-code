import { describe, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { mkdir, writeFile, readFile } from "fs/promises"
import path from "path"
import {
  readDatamateTransportFromIde,
  syncDatamateUrlFromVscodeMcp,
  resolveDatamateSyncRoot,
  DATAMATE_KEY,
} from "../../src/altimate/datamate-transport"

// Regression tests for the stdio env carry-through. The IDE extension writes the
// datamate stdio entry with an env block — on desktop editors the entry's command
// is the editor's Electron binary and env carries ELECTRON_RUN_AS_NODE=1, without
// which the spawn boots the editor GUI and opens datamate-cli.js as a document
// instead of running it. readDatamateTransportFromIde used to drop env entirely,
// so `datamate_manager add` persisted a broken entry that re-popped the file on
// every session launch.

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
    expect(t).toEqual({ type: "local", command: ["datamate", "start-stdio"] })
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

    const updated = await syncDatamateUrlFromVscodeMcp(tmp.path)
    expect(updated).toContain(DATAMATE_KEY)

    const after = JSON.parse(await readFile(configPath, "utf-8"))
    const entry = after.mcp[DATAMATE_KEY]
    expect(entry.type).toBe("local")
    expect(entry.command).toEqual(["/path/to/electron", "/ext/dist/datamate-cli.js", "start-stdio"])
    expect(entry.environment).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
    expect(entry.updatedAt).toBe("T2")
    expect(entry.enabled).toBe(true) // non-transport field preserved
  })
})
