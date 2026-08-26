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
import { createHash } from "node:crypto"

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

function sha(s: string) {
  return createHash("sha256").update(Buffer.from(s)).digest("hex")
}

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

/** Serve a skill list plus its file bodies. */
function serve(skills: Record<string, Record<string, string>>) {
  const list = Object.entries(skills).map(([id, files]) => ({
    public_id: id,
    files: Object.entries(files).map(([p, content]) => ({ path: p, sha256: sha(content) })),
  }))
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input)
    if (url.includes("/files/")) {
      const m = url.match(/custom-skills\/([^/]+)\/files\/(.+)$/)
      const id = decodeURIComponent(m![1])
      const file = m![2].split("/").map(decodeURIComponent).join("/")
      const body = skills[id][file]
      return new Response(Buffer.from(body), { status: 200 })
    }
    return new Response(JSON.stringify(list), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as unknown as typeof fetch
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

  test("a checksum mismatch publishes nothing and keeps the previous snapshot", async () => {
    serve({ "pub-1": { "SKILL.md": "good" } })
    await syncSkills(project)

    const list = [{ public_id: "pub-2", files: [{ path: "SKILL.md", sha256: sha("expected") }] }]
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes("/files/")) return new Response(Buffer.from("tampered"), { status: 200 })
      return new Response(JSON.stringify(list), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(skillFile("pub-2", "SKILL.md"))).toBe(false)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
  })

  test("an unchanged workspace issues no file downloads on the second run", async () => {
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    let fileRequests = 0
    const list = [{ public_id: "pub-1", files: [{ path: "SKILL.md", sha256: sha("one") }] }]
    globalThis.fetch = (async (input: string | URL) => {
      if (String(input).includes("/files/")) fileRequests++
      return new Response(JSON.stringify(list), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(fileRequests).toBe(0)
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
    const list = [{ public_id: "pub-1", files: [{ path: "../escape.md", sha256: sha("x") }] }]
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(list), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(path.join(project, ".altimate-code", "skill", "escape.md"))).toBe(false)
    expect(existsSync(path.join(project, MANAGED))).toBe(false)
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
