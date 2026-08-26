// altimate_change - new file
// Unit coverage for the workspace skill mirror
// (src/altimate/workspace/skill-sync.ts).
//
// Network is stubbed at globalThis.fetch so assertions are about what actually
// reaches disk after a given server response. The cases that matter most are
// the destructive ones: a failed or malformed list must NEVER delete a user's
// synced skills, and a rebind must never leave the previous workspace's skills
// where discovery can load them.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const ORIGINAL_TEST_HOME = process.env.OPENCODE_TEST_HOME
const ORIGINAL_WORKSPACE_FLAG = process.env.ALTIMATE_WORKSPACE
const SANDBOX = path.join(os.tmpdir(), `altimate-skillsync-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
mkdirSync(path.join(SANDBOX, "home", ".altimate"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")
process.env.OPENCODE_TEST_HOME = path.join(SANDBOX, "home")
process.env.ALTIMATE_WORKSPACE = "1"

const API_URL = "https://api.example.test"
const TENANT = "acme"

// Real credentials file, so the module resolves them through the same path it
// uses in production rather than a stubbed export.
writeFileSync(
  path.join(SANDBOX, "home", ".altimate", "altimate.json"),
  JSON.stringify({
    altimateUrl: API_URL,
    altimateInstanceName: TENANT,
    altimateApiKey: "test-key",
  }),
)

const { syncSkills } = await import("@/altimate/workspace/skill-sync")
const { cachePath } = await import("@/altimate/workspace/state")

const MANAGED = path.join(".altimate-code", "skill", "_workspace")
const ORIGINAL_FETCH = globalThis.fetch

let project: string

/** Write a real binding cache entry, so ``readLocalBinding`` is exercised for
 * real instead of being replaced. */
function bindTo(datamateId: number) {
  writeFileSync(
    cachePath(),
    JSON.stringify({
      version: 1,
      tenant: TENANT,
      apiUrl: API_URL,
      bindings: {
        [project]: {
          datamateId,
          datamateName: `ws-${datamateId}`,
          repoRemote: null,
          projectPath: project,
          linkedAt: Date.now(),
        },
      },
    }),
  )
}

beforeEach(() => {
  project = path.join(SANDBOX, `proj-${Math.random().toString(36).slice(2)}`)
  mkdirSync(project, { recursive: true })
  bindTo(1)
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

afterAll(() => {
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  if (ORIGINAL_TEST_HOME === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = ORIGINAL_TEST_HOME
  if (ORIGINAL_WORKSPACE_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_WORKSPACE_FLAG
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

/** Serve the real contract: a paginated summary page, a detail view carrying
 * files[{path,size}], and raw file bytes. */
function serve(skills: Record<string, Record<string, string>>, updatedAt = "2026-01-01T00:00:00Z") {
  const items = Object.keys(skills).map((id) => ({
    public_id: id,
    name: id,
    file_count: Object.keys(skills[id]).length,
    updated_at: updatedAt,
  }))
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input)
    const files = url.match(/skills\/([^/]+)\/files\/(.+)$/)
    if (files) {
      const id = decodeURIComponent(files[1])
      const rel = files[2].split("/").map(decodeURIComponent).join("/")
      return new Response(Buffer.from(skills[id][rel]), { status: 200 })
    }
    const detail = url.match(/skills\/([^/?]+)(?:\?|$)/)
    if (detail && !url.includes("datamate_id")) {
      const id = decodeURIComponent(detail[1])
      return json({
        public_id: id,
        files: Object.entries(skills[id]).map(([p, c]) => ({
          path: p,
          size: Buffer.from(c).byteLength,
        })),
        content: skills[id]["SKILL.md"] ?? "",
      })
    }
    return json({ items, total: items.length, page: 1, size: 50, pages: 1 })
  }) as unknown as typeof fetch
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function skillFile(id: string, rel: string) {
  return path.join(project, MANAGED, id, rel)
}

describe("workspace skill sync", () => {
  test("writes the bundle, references included", async () => {
    serve({
      "pub-1": {
        "SKILL.md": "---\nname: acme\n---\nbody",
        "references/guide.md": "reference body",
      },
    })
    await syncSkills(project)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
    expect(readFileSync(skillFile("pub-1", "references/guide.md"), "utf8")).toBe("reference body")
  })

  test("a failed list leaves existing skills untouched", async () => {
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)

    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    await syncSkills(project)

    // The whole point: a network failure must not read as "no skills".
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
  })

  test("a malformed 200 is treated as an error, not an empty workspace", async () => {
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ unexpected: "envelope" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
  })

  test("a genuinely empty workspace removes the snapshot", async () => {
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)

    serve({})
    await syncSkills(project)
    expect(existsSync(path.join(project, MANAGED))).toBe(false)
  })

  test("rebinding to another workspace drops the previous snapshot", async () => {
    serve({ "pub-1": { "SKILL.md": "from workspace 1" } })
    await syncSkills(project)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)

    // Rebind, then fail the pull. The old workspace's skills must be gone —
    // discovery does not read the manifest, so leaving them would feed the
    // model another workspace's guidance.
    bindTo(2)
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(false)
  })

  test("a truncated download publishes nothing and keeps the previous snapshot", async () => {
    serve({ "pub-1": { "SKILL.md": "good" } })
    await syncSkills(project)

    // The API exposes no checksum, so byte length is the only integrity check.
    // A short body must abandon the whole snapshot rather than publish half a
    // skill.
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes("/files/")) return new Response(Buffer.from("short"), { status: 200 })
      if (url.includes("datamate_id"))
        return json({
          items: [{ public_id: "pub-2", name: "p2", file_count: 1, updated_at: "2026-02-02T00:00:00Z" }],
          total: 1,
          page: 1,
          size: 50,
          pages: 1,
        })
      return json({ public_id: "pub-2", files: [{ path: "SKILL.md", size: 9999 }], content: "" })
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(skillFile("pub-2", "SKILL.md"))).toBe(false)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
  })

  test("an unchanged workspace issues no detail or file requests on the second run", async () => {
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    let detailOrFile = 0
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes("/files/") || !url.includes("datamate_id")) detailOrFile++
      return json({
        items: [{ public_id: "pub-1", name: "p1", file_count: 1, updated_at: "2026-01-01T00:00:00Z" }],
        total: 1,
        page: 1,
        size: 50,
        pages: 1,
      })
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(detailOrFile).toBe(0)
  })

  test("never writes outside the managed directory", async () => {
    writeFileSync(path.join(project, "user-file.txt"), "mine")
    mkdirSync(path.join(project, ".altimate-code", "skill", "hand-written"), { recursive: true })
    writeFileSync(
      path.join(project, ".altimate-code", "skill", "hand-written", "SKILL.md"),
      "hand written",
    )

    serve({ "pub-1": { "SKILL.md": "synced" } })
    await syncSkills(project)
    serve({})
    await syncSkills(project)

    expect(readFileSync(path.join(project, "user-file.txt"), "utf8")).toBe("mine")
    expect(
      readFileSync(path.join(project, ".altimate-code", "skill", "hand-written", "SKILL.md"), "utf8"),
    ).toBe("hand written")
  })

  test("path traversal in a file entry is refused", async () => {
    // The body is served at exactly the advertised size, so the size check
    // cannot be what stops this — only the path guard can.
    const escape = "escaped"
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes("/files/")) return new Response(Buffer.from(escape), { status: 200 })
      if (url.includes("datamate_id"))
        return json({
          items: [{ public_id: "pub-1", name: "p1", file_count: 1, updated_at: "2026-01-01T00:00:00Z" }],
          total: 1,
          page: 1,
          size: 50,
          pages: 1,
        })
      return json({
        public_id: "pub-1",
        files: [{ path: "../escape.md", size: Buffer.from(escape).byteLength }],
        content: "",
      })
    }) as unknown as typeof fetch
    await syncSkills(project)

    // Nothing is published at all: an unrecognised inventory aborts the sync.
    expect(existsSync(path.join(project, MANAGED))).toBe(false)
    // And specifically not one level up from where the skill would have gone.
    expect(existsSync(path.join(project, ".altimate-code", "skill", "escape.md"))).toBe(false)
    expect(existsSync(path.join(project, MANAGED, "escape.md"))).toBe(false)
  })

  test("does nothing when the workspace flag is off", async () => {
    process.env.ALTIMATE_WORKSPACE = "0"
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("[]", { status: 200 })
    }) as unknown as typeof fetch
    try {
      await syncSkills(project)
      expect(calls).toBe(0)
    } finally {
      process.env.ALTIMATE_WORKSPACE = "1"
    }
  })
})
