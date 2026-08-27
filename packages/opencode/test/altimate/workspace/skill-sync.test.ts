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
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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

const { syncSkills, recentlySynced } = await import("@/altimate/workspace/skill-sync")
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
  // Scoped per test, not set at module load: bun may run other test files in
  // this process, and a live workspace flag makes their prompt path attempt a
  // real sync against this file's sandbox credentials.
  process.env.ALTIMATE_WORKSPACE = "1"
  project = path.join(SANDBOX, `proj-${Math.random().toString(36).slice(2)}`)
  mkdirSync(project, { recursive: true })
  bindTo(1)
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  if (ORIGINAL_WORKSPACE_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_WORKSPACE_FLAG
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
  // Shapes verified against a local backend on `development`: the list is NOT
  // wrapped, the detail IS wrapped in `{skill: ...}`, and the file endpoint
  // answers `{path, content}` JSON rather than raw bytes.
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
      return json({ path: rel, content: skills[id][rel] })
    }
    const detail = url.match(/skills\/([^/?]+)(?:\?|$)/)
    if (detail && !url.includes("datamate_id")) {
      const id = decodeURIComponent(detail[1])
      return json({
        skill: {
          public_id: id,
          files: Object.entries(skills[id]).map(([p, c]) => ({
            path: p,
            size: Buffer.from(c).byteLength,
          })),
          content: skills[id]["SKILL.md"] ?? "",
        },
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

/** Remove the local binding, leaving the project bound only server-side. */
function unbind() {
  writeFileSync(
    cachePath(),
    JSON.stringify({ version: 1, tenant: TENANT, apiUrl: API_URL, bindings: {} }),
  )
}

/** Like `serve`, but the project is unbound locally and the server answers the
 * binding lookup — the fresh-clone shape. */
function serveWithServerBinding(skills: Record<string, Record<string, string>>) {
  serve(skills)
  const inner = globalThis.fetch
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/datamate-project-bindings/by-")) {
      return json({
        binding: {
          id: 7,
          datamate_id: 1,
          datamate_name: "ws-1",
          repo_remote: null,
          project_path: project,
        },
        datamate: { id: 1, name: "ws-1" },
      })
    }
    return inner(input as never, init as never)
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

  test("a truncated download publishes nothing and keeps the previous snapshot", async () => {
    serve({ "pub-1": { "SKILL.md": "good" } })
    await syncSkills(project)

    // The API exposes no checksum, so byte length is the only integrity check.
    // A short body must abandon the whole snapshot rather than publish half a
    // skill.
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes("/files/")) return json({ path: "SKILL.md", content: "short" })
      if (url.includes("datamate_id"))
        return json({
          items: [{ public_id: "pub-2", name: "p2", file_count: 1, updated_at: "2026-02-02T00:00:00Z" }],
          total: 1,
          page: 1,
          size: 50,
          pages: 1,
        })
      return json({ skill: { public_id: "pub-2", files: [{ path: "SKILL.md", size: 9999 }], content: "" } })
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
      if (url.includes("/files/")) return json({ path: "../escape.md", content: escape })
      if (url.includes("datamate_id"))
        return json({
          items: [{ public_id: "pub-1", name: "p1", file_count: 1, updated_at: "2026-01-01T00:00:00Z" }],
          total: 1,
          page: 1,
          size: 50,
          pages: 1,
        })
      return json({
        skill: {
          public_id: "pub-1",
          files: [{ path: "../escape.md", size: Buffer.from(escape).byteLength }],
          content: "",
        },
      })
    }) as unknown as typeof fetch
    await syncSkills(project)

    // Nothing is published at all: an unrecognised inventory aborts the sync.
    expect(existsSync(path.join(project, MANAGED))).toBe(false)
    // And specifically not one level up from where the skill would have gone.
    expect(existsSync(path.join(project, ".altimate-code", "skill", "escape.md"))).toBe(false)
    expect(existsSync(path.join(project, MANAGED, "escape.md"))).toBe(false)
  })

  test("`changed` is true only when disk actually changed", async () => {
    // `changed` is the gate on refreshing the skill registry, which costs a full
    // config reread plus a re-scan. Reporting it on a no-op sync would put that
    // on every turn; failing to report it on a real change would leave the model
    // looking at the previous snapshot.
    serve({ "pub-1": { "SKILL.md": "one" } })
    expect((await syncSkills(project)).changed).toBe(true)

    // Same content, same updated_at: nothing to do.
    expect((await syncSkills(project)).changed).toBe(false)

    // A newer updated_at is a real change.
    serve({ "pub-1": { "SKILL.md": "two" } }, "2026-03-03T00:00:00Z")
    expect((await syncSkills(project)).changed).toBe(true)
  })

  test("a file body without content is an error, not an empty file", async () => {
    // The size check alone does not cover this: a bundle may legitimately hold
    // a zero-byte file, and a malformed body coerced to "" would match size 0
    // and publish silently, advancing the manifest as though it had succeeded.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes("/files/")) return json({ path: "SKILL.md" })
      if (url.includes("datamate_id"))
        return json({
          items: [{ public_id: "pub-3", name: "p3", file_count: 1, updated_at: "2026-04-04T00:00:00Z" }],
          total: 1,
          page: 1,
          size: 50,
          pages: 1,
        })
      return json({ skill: { public_id: "pub-3", files: [{ path: "SKILL.md", size: 0 }], content: "" } })
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(skillFile("pub-3", "SKILL.md"))).toBe(false)
    // And the previous snapshot is intact — an error never publishes.
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
  })

  test("a project bound only on the server still gets its skills", async () => {
    // The local cache is written only by an explicit link. Without the server
    // fallback a fresh clone of a linked repo gets no skills at all, and `link`
    // refuses to help because the server reports it as already linked.
    unbind()
    serveWithServerBinding({ "pub-1": { "SKILL.md": "from the server binding" } })
    await syncSkills(project)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)

    // And the discovered binding is cached, so the next process skips the lookup.
    const cached = JSON.parse(readFileSync(cachePath(), "utf8"))
    expect(cached.bindings[realpathSync(project)].datamateId).toBe(1)
  })

  test("a failed binding lookup is not read as unbound", async () => {
    // Same rule as the skill list: an error means "unknown", so whatever is on
    // disk stays. Treating it as unbound would wipe a synced project offline.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)

    unbind()
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)

    // And the failure must stay retryable: a network blip must not memoize this
    // project as unbound for the rest of the process.
    serveWithServerBinding({ "pub-2": { "SKILL.md": "after recovery" } })
    await syncSkills(project)
    expect(existsSync(skillFile("pub-2", "SKILL.md"))).toBe(true)
  })

  test("recentlySynced rate-limits the per-message poll", async () => {
    // The caller on the per-message path skips the network while this is true.
    // If it never went true, every turn would pay an HTTP round trip; if it
    // never went false, a skill added in the SaaS would never reach an open
    // session.
    expect(recentlySynced(project)).toBe(false)
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    expect(recentlySynced(project)).toBe(true)

    // Scoped per project — a different directory is still due a check.
    expect(recentlySynced(path.join(SANDBOX, "some-other-proj"))).toBe(false)
  })

  test("a skill added later is picked up by a subsequent sync", async () => {
    // The SaaS-adds-a-skill case: the same project, already synced, gains a
    // second skill upstream. A later sync must report changed and land it.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)

    serve(
      { "pub-1": { "SKILL.md": "one" }, "pub-9": { "SKILL.md": "added in the saas" } },
      "2026-05-05T00:00:00Z",
    )
    const { changed } = await syncSkills(project)
    expect(changed).toBe(true)
    expect(existsSync(skillFile("pub-9", "SKILL.md"))).toBe(true)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
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
