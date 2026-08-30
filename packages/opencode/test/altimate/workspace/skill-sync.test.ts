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
import {
  existsSync,
  mkdirSync,
  utimesSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import os from "node:os"
import matter from "gray-matter"

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

const { syncSkills, recentlySynced, registryStale, markRegistryApplied } =
  await import("@/altimate/workspace/skill-sync")
const { cachePath, recordApprovedBinding } = await import("@/altimate/workspace/state")

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
  // Only the workspace flag is scoped per test. It matters because leaving it
  // set makes OTHER files' prompt path attempt a real sync against this
  // sandbox's credentials, which cost 15s timeouts.
  //
  // XDG_STATE_HOME / OPENCODE_TEST_HOME are deliberately NOT scoped this way,
  // despite the same argument applying in principle. Flipping them per test is
  // worse: a file sharing this bun worker sets its own values at module load,
  // and restoring "the original" here deletes theirs mid-run. Tried it — seven
  // tests in onboarding/materialize.test.ts began materializing into the real
  // home directory. Module-scope + afterAll is the lesser of the two evils
  // until test files stop sharing a process.
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
      // Binding revalidation is not a detail or file fetch; this test is about
      // not re-downloading an unchanged workspace.
      if (url.includes("/datamate-project-bindings/by-")) return json({ detail: "not found" })
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
    expect(await recentlySynced(project)).toBe(false)
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    expect(await recentlySynced(project)).toBe(true)

    // Scoped per project — a different directory is still due a check.
    expect(await recentlySynced(path.join(SANDBOX, "some-other-proj"))).toBe(false)
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

  test("a public_id that is not a single path component is refused", async () => {
    // `public_id` is server-generated but still remote input spliced into a
    // filesystem path, one component ABOVE the per-file guard — so the file
    // guard cannot catch an escape here.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes("/files/")) return json({ path: "SKILL.md", content: "x" })
      if (url.includes("datamate_id"))
        return json({
          items: [{ public_id: "../../escape", name: "e", file_count: 1, updated_at: "2026-06-06T00:00:00Z" }],
          total: 1,
          page: 1,
          size: 50,
          pages: 1,
        })
      return json({ skill: { public_id: "../../escape", files: [{ path: "SKILL.md", size: 1 }], content: "" } })
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(path.join(project, ".altimate-code", "escape"))).toBe(false)
    expect(existsSync(path.join(project, "escape"))).toBe(false)
    // The previous snapshot is untouched: an unusable id is an error, not empty.
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
  })

  test("refuses to replace a managed directory it did not create", async () => {
    // The directory name is ours by convention, and convention is not
    // ownership. Anything already there without our manifest is a user's file.
    const managed = path.join(project, MANAGED)
    mkdirSync(path.join(managed, "hand-rolled"), { recursive: true })
    writeFileSync(path.join(managed, "hand-rolled", "SKILL.md"), "mine, not synced")

    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    expect(readFileSync(path.join(managed, "hand-rolled", "SKILL.md"), "utf8")).toBe("mine, not synced")
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(false)
  })

  test("staging never lands where skill discovery scans", async () => {
    // Discovery globs `{skill,skills}/**/SKILL.md` under the config dir, so a
    // staging tree beside `_workspace` would be scanned and a half-written
    // snapshot loaded as real skills. Observed DURING the sync: staging is
    // removed on success, so checking afterwards proves nothing.
    const seen: string[][] = []
    serve({ "pub-1": { "SKILL.md": "one", "references/g.md": "ref" } })
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/files/")) {
        try {
          seen.push(readdirSync(path.join(project, ".altimate-code", "skill")))
        } catch {
          seen.push([])
        }
      }
      return inner(input as never, init as never)
    }) as unknown as typeof fetch

    await syncSkills(project)

    expect(seen.length).toBeGreaterThan(0)
    for (const entries of seen) {
      expect(entries.filter((e) => e !== "_workspace")).toEqual([])
    }
  })

  test("a damaged snapshot is repaired rather than declared up to date", async () => {
    serve({ "pub-1": { "SKILL.md": "one", "references/g.md": "ref" } })
    await syncSkills(project)
    rmSync(skillFile("pub-1", "references/g.md"))

    // Same updated_at: only checking the manifest would call this current.
    await syncSkills(project)
    expect(existsSync(skillFile("pub-1", "references/g.md"))).toBe(true)
  })

  test("a failed sync does not consume the poll window", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    await syncSkills(project)
    // Stamping here would suppress the retry for a full interval on a blip.
    expect(await recentlySynced(project)).toBe(false)
  })

  test("registryStale reports a snapshot the caller has not applied yet", async () => {
    // A bind syncs with no instance context to refresh from; the next turn has
    // to notice on its own, without re-fetching.
    expect(registryStale(project)).toBe(false)
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    expect(registryStale(project)).toBe(true)
    markRegistryApplied(project)
    expect(registryStale(project)).toBe(false)
  })

  test("registryStale follows the snapshot on disk, not an in-process stamp", async () => {
    // The bind and the turn that must refresh do not share memory — the runtime
    // loads this module once per thread, so each has its own module record and
    // its own `globalThis`. An in-process "changed" stamp is therefore invisible
    // to the thread serving the next turn, which is what kept a workspace linked
    // mid-session from ever reaching the agent. Simulating that here: the
    // manifest moves WITHOUT this module having run a sync, and staleness must
    // still be reported.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    markRegistryApplied(project)
    expect(registryStale(project)).toBe(false)

    const manifest = path.join(project, MANAGED, ".manifest.json")
    const later = new Date(Date.now() + 5000)
    utimesSync(manifest, later, later)

    expect(registryStale(project)).toBe(true)
  })

  test("registryStale reports a purge, so opting out refreshes too", async () => {
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    markRegistryApplied(project)
    expect(registryStale(project)).toBe(false)

    // A deactivate removes the whole managed tree, manifest included. That is a
    // registry change in the other direction and must refresh just the same.
    rmSync(path.join(project, MANAGED), { recursive: true, force: true })
    expect(registryStale(project)).toBe(true)
  })

  test("the published snapshot ignores itself in git", async () => {
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    expect(readFileSync(path.join(project, MANAGED, ".gitignore"), "utf8")).toBe("*\n")
  })

  test("a file response for the wrong path is refused", async () => {
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      // Same length, different file — undetectable without checking the path.
      if (url.includes("/files/")) return json({ path: "OTHER.md", content: "abc" })
      if (url.includes("datamate_id"))
        return json({
          items: [{ public_id: "pub-7", name: "p7", file_count: 1, updated_at: "2026-07-07T00:00:00Z" }],
          total: 1,
          page: 1,
          size: 50,
          pages: 1,
        })
      return json({ skill: { public_id: "pub-7", files: [{ path: "SKILL.md", size: 3 }], content: "" } })
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(skillFile("pub-7", "SKILL.md"))).toBe(false)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
  })

  test("an inconsistent empty page is an error, not an empty workspace", async () => {
    // "Empty workspace" is the one answer that deletes the snapshot, so a page
    // claiming rows exist while returning none must not be believed.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    globalThis.fetch = (async () =>
      json({ items: [], total: 4, page: 1, size: 50, pages: 1 })) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
  })

  test("a bundle beyond the client limit is refused whole", async () => {
    // Counted on the ADVERTISED inventory, before anything is downloaded, so
    // an oversized workspace fails fast instead of being read into memory.
    // Uses file count rather than bytes so the ceiling is what trips — an
    // oversized `size` would be caught by the integrity check instead, and the
    // test would pass without the ceiling existing.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    const many = Array.from({ length: 2500 }, (_, i) => ({ path: `f${i}.md`, size: 1 }))
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes("/files/")) {
        const rel = url.split("/files/")[1]
        return json({ path: decodeURIComponent(rel), content: "x" })
      }
      if (url.includes("datamate_id"))
        return json({
          items: [{ public_id: "pub-many", name: "m", file_count: many.length, updated_at: "2026-08-08T00:00:00Z" }],
          total: 1,
          page: 1,
          size: 50,
          pages: 1,
        })
      return json({ skill: { public_id: "pub-many", files: many, content: "" } })
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(skillFile("pub-many", "f0.md"))).toBe(false)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
  })

  test("a synced bundle has the shape a skill needs", async () => {
    // Shape only. Most fixtures here assert bytes reached disk, which does not
    // show a bundle yields a USABLE skill — but neither does this: discovery is
    // not run here, because this file has no instance harness. The end-to-end
    // claim is made where it can be: "a workspace-synced bundle layout is
    // discovered as a real skill" in test/skill/skill.test.ts.
    serve({
      "pub-real": {
        "SKILL.md": "---\nname: synced-probe\ndescription: A synced workspace skill.\n---\n\nBody.\n",
        "references/guide.md": "reference body",
      },
    })
    await syncSkills(project)

    const onDisk = readFileSync(skillFile("pub-real", "SKILL.md"), "utf8")
    const parsed = matter(onDisk)
    expect(parsed.data.name).toBe("synced-probe")
    expect(parsed.data.description).toBe("A synced workspace skill.")
    // The bundled reference has to survive too — the model is handed the skill's
    // directory and reads these itself.
    expect(readFileSync(skillFile("pub-real", "references/guide.md"), "utf8")).toBe("reference body")
    // And it must sit where discovery globs `{skill,skills}/**/SKILL.md`.
    expect(skillFile("pub-real", "SKILL.md")).toContain(path.join(".altimate-code", "skill"))
  })

  test("disconnecting the account takes the snapshot out of service", async () => {
    // Leaving it is not neutral: discovery loads whatever is on disk without
    // consulting the manifest, so a disconnected user keeps getting the
    // workspace's skills — and an `alwaysApply` one keeps entering every prompt.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)

    const credsFile = path.join(SANDBOX, "home", ".altimate", "altimate.json")
    const saved = readFileSync(credsFile, "utf8")
    rmSync(credsFile)
    try {
      const { changed } = await syncSkills(project)
      expect(changed).toBe(true)
      expect(existsSync(path.join(project, MANAGED))).toBe(false)
    } finally {
      writeFileSync(credsFile, saved)
    }
  })

  test("turning the workspace flag off takes the snapshot out of service", async () => {
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)

    process.env.ALTIMATE_WORKSPACE = "0"
    try {
      await syncSkills(project)
      expect(existsSync(path.join(project, MANAGED))).toBe(false)
    } finally {
      process.env.ALTIMATE_WORKSPACE = "1"
    }
  })

  test("the opt-out purge serialises with a sync already in flight", async () => {
    // Both paths write the same tree. With the purge outside the in-flight gate
    // an enabled run — already past its own flag check — could republish
    // `_workspace` moments after a disabled run deleted it, leaving a snapshot
    // on disk for a feature that is off.
    serve({ "pub-1": { "SKILL.md": "one" } })

    const enabled = syncSkills(project)
    process.env.ALTIMATE_WORKSPACE = "0"
    try {
      // Joins the in-flight enabled run rather than deleting underneath it, so
      // both observers agree and the tree is not left half-published.
      const [first, second] = await Promise.all([enabled, syncSkills(project)])
      expect(second).toEqual(first)
    } finally {
      process.env.ALTIMATE_WORKSPACE = "1"
    }

    // The purge still runs once nothing is in flight.
    process.env.ALTIMATE_WORKSPACE = "0"
    try {
      await syncSkills(project)
      expect(existsSync(path.join(project, MANAGED))).toBe(false)
    } finally {
      process.env.ALTIMATE_WORKSPACE = "1"
    }
  })

  test("an unreadable credentials file keeps the snapshot", async () => {
    // Unknown is not disconnected. A corrupt or unreadable file must not
    // destroy a snapshot the user is still entitled to.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    const credsFile = path.join(SANDBOX, "home", ".altimate", "altimate.json")
    const saved = readFileSync(credsFile, "utf8")
    writeFileSync(credsFile, "{ not json")
    try {
      await syncSkills(project)
      expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
    } finally {
      writeFileSync(credsFile, saved)
    }
  })

  test("pages are walked, and a partial listing never prunes the rest", async () => {
    // The reviewers all named this: nothing constructed a 2-page listing, so
    // MAX_PAGES, the terminator, the echoed page and cross-page accumulation
    // were unexercised.
    const bodies: Record<string, string> = {
      "p1-a": "---\nname: p1a\ndescription: d.\n---\nA\n",
      "p2-b": "---\nname: p2b\ndescription: d.\n---\nB\n",
    }
    const row = (id: string) => ({
      public_id: id,
      name: id,
      file_count: 1,
      updated_at: "2026-09-09T00:00:00Z",
    })
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes("/files/")) {
        const id = /skills\/([^/]+)\/files/.exec(url)![1]
        return json({ path: "SKILL.md", content: bodies[id] })
      }
      if (url.includes("datamate_id")) {
        const page = Number(/page=(\d+)/.exec(url)?.[1] ?? 1)
        return json({
          items: [row(page === 1 ? "p1-a" : "p2-b")],
          total: 2,
          page,
          size: 1,
          pages: 2,
        })
      }
      const id = /skills\/([^/?]+)/.exec(url)![1]
      return json({
        skill: {
          public_id: id,
          files: [{ path: "SKILL.md", size: Buffer.from(bodies[id]).byteLength }],
          content: "",
        },
      })
    }) as unknown as typeof fetch

    await syncSkills(project)
    expect(existsSync(skillFile("p1-a", "SKILL.md"))).toBe(true)
    expect(existsSync(skillFile("p2-b", "SKILL.md"))).toBe(true)
  })

  test("a listing with an unusable `pages` is an error, not a one-page workspace", async () => {
    // Defaulting `pages` to 1 turns a partial first page into "the whole
    // workspace" and deletes everything the later pages held.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    for (const bad of [undefined, 0, 1.5, "2"]) {
      globalThis.fetch = (async () =>
        json({ items: [], total: 0, page: 1, size: 50, pages: bad })) as unknown as typeof fetch
      await syncSkills(project)
      expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
    }
  })

  test("a file response omitting `path` is refused", async () => {
    // The mis-routed response this guard exists for is exactly the case where
    // the echoed field may be missing, so "checked when present" is no check.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes("/files/")) return json({ content: "abc" })
      if (url.includes("datamate_id"))
        return json({
          items: [{ public_id: "pub-np", name: "n", file_count: 1, updated_at: "2026-09-10T00:00:00Z" }],
          total: 1,
          page: 1,
          size: 50,
          pages: 1,
        })
      return json({ skill: { public_id: "pub-np", files: [{ path: "SKILL.md", size: 3 }], content: "" } })
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(skillFile("pub-np", "SKILL.md"))).toBe(false)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
  })

  test("a plain file at the managed path is never deleted", async () => {
    // `readdir` throws ENOTDIR here, which the old guard read as "absent,
    // therefore ours" and handed straight to fs.rm.
    const managed = path.join(project, MANAGED)
    mkdirSync(path.dirname(managed), { recursive: true })
    writeFileSync(managed, "a user's file, not a directory")

    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    expect(readFileSync(managed, "utf8")).toBe("a user's file, not a directory")
  })

  test("a symlinked staging directory is refused rather than traversed", async () => {
    // `readdir` follows symlinks, so sweeping through one would recursively
    // delete whatever it points at — outside the project.
    const outside = path.join(SANDBOX, `outside-${Math.random().toString(36).slice(2)}`)
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(outside, "precious.txt"), "must survive")

    mkdirSync(path.join(project, ".altimate-code", "skill"), { recursive: true })
    symlinkSync(outside, path.join(project, ".altimate-code", "skill-staging"))

    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    expect(readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("must survive")
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(false)
  })

  test("switching to an account with no binding drops the old tenant's skills", async () => {
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)

    // New account: the cached binding no longer matches, and the server has no
    // binding for this project either.
    const credsFile = path.join(SANDBOX, "home", ".altimate", "altimate.json")
    const saved = readFileSync(credsFile, "utf8")
    writeFileSync(
      credsFile,
      JSON.stringify({ altimateUrl: API_URL, altimateInstanceName: "other-tenant", altimateApiKey: "k" }),
    )
    globalThis.fetch = (async () => json({ detail: "not found" })) as unknown as typeof fetch
    try {
      await syncSkills(project)
      expect(existsSync(path.join(project, MANAGED))).toBe(false)
    } finally {
      writeFileSync(credsFile, saved)
    }
  })

  test("a directory holding a manifest we cannot read is not ours", async () => {
    // Ownership was decided on the FILENAME `.manifest.json`. A directory with
    // an unrelated or corrupt file of that name is someone else's, and was
    // being deleted wholesale.
    const managed = path.join(project, MANAGED)
    mkdirSync(path.join(managed, "someone-elses"), { recursive: true })
    writeFileSync(path.join(managed, "someone-elses", "SKILL.md"), "not ours")
    writeFileSync(path.join(managed, ".manifest.json"), "{ not valid json")

    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    expect(readFileSync(path.join(managed, "someone-elses", "SKILL.md"), "utf8")).toBe("not ours")
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(false)
  })

  test("a manifest from a foreign shape does not confer ownership", async () => {
    const managed = path.join(project, MANAGED)
    mkdirSync(path.join(managed, "other-tool"), { recursive: true })
    writeFileSync(path.join(managed, "other-tool", "SKILL.md"), "another tool's file")
    // Valid JSON, wrong shape — `readManifest` must reject it.
    writeFileSync(path.join(managed, ".manifest.json"), JSON.stringify({ some: "other tool" }))

    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    expect(readFileSync(path.join(managed, "other-tool", "SKILL.md"), "utf8")).toBe("another tool's file")
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(false)
  })

  test("a confirmed unbind takes the snapshot out of service", async () => {
    // Discovery does not consult the manifest, so a project detached in the
    // SaaS would keep serving that workspace's skills forever.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)

    unbind()
    // 404 on the binding lookup: confirmed unbound, not a failure.
    globalThis.fetch = (async (input: string | URL) => {
      if (String(input).includes("/datamate-project-bindings/by-")) {
        return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
      }
      return json({ items: [], total: 0, page: 1, size: 50, pages: 1 })
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(path.join(project, MANAGED))).toBe(false)
  })

  test("an unreachable binding lookup keeps the snapshot", async () => {
    // Unknown is not unbound. Deleting on a network blip would wipe a snapshot
    // the user is still entitled to.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    unbind()
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
  })

  test("a malformed binding response is unknown, not a crash", async () => {
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    unbind()
    globalThis.fetch = (async (input: string | URL) => {
      if (String(input).includes("/datamate-project-bindings/by-")) {
        return json({ binding: { nonsense: true } })
      }
      return json({ items: [], total: 0, page: 1, size: 50, pages: 1 })
    }) as unknown as typeof fetch
    await syncSkills(project)

    // Treated as unknown: nothing published, nothing destroyed.
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
  })

  test("the disabled-path purge refuses to follow a symlink", async () => {
    // The opt-out branch deletes, and it runs before the check inside the sync.
    // The link target must hold a tree the purge WOULD delete, or the test
    // passes for the wrong reason (nothing there to remove).
    const outside = path.join(SANDBOX, `optout-${Math.random().toString(36).slice(2)}`)
    const victim = path.join(outside, "skill", "_workspace")
    mkdirSync(path.join(victim, "pub-x"), { recursive: true })
    writeFileSync(path.join(victim, "pub-x", "SKILL.md"), "must survive")
    writeFileSync(
      path.join(victim, ".manifest.json"),
      JSON.stringify({ version: 1, tenant: TENANT, apiUrl: API_URL, datamateId: 1, skills: {} }),
    )

    const proj2 = path.join(SANDBOX, `symlinked-${Math.random().toString(36).slice(2)}`)
    mkdirSync(proj2, { recursive: true })
    symlinkSync(outside, path.join(proj2, ".altimate-code"))

    process.env.ALTIMATE_WORKSPACE = "0"
    try {
      await syncSkills(proj2)
      expect(readFileSync(path.join(victim, "pub-x", "SKILL.md"), "utf8")).toBe("must survive")
    } finally {
      process.env.ALTIMATE_WORKSPACE = "1"
    }
  })

  test("the no-credentials purge refuses to follow a symlink", async () => {
    // Same hazard as the opt-out purge: this branch runs before the
    // `pathsAreReal` check inside the sync, so it needs its own guard or a
    // symlinked `.altimate-code` has the delete resolve through the link. The
    // target must hold a tree the purge WOULD remove, or this passes for the
    // wrong reason.
    const outside = path.join(SANDBOX, `nocreds-${Math.random().toString(36).slice(2)}`)
    const victim = path.join(outside, "skill", "_workspace")
    mkdirSync(path.join(victim, "pub-x"), { recursive: true })
    writeFileSync(path.join(victim, "pub-x", "SKILL.md"), "must survive")
    writeFileSync(
      path.join(victim, ".manifest.json"),
      JSON.stringify({ version: 1, tenant: TENANT, apiUrl: API_URL, datamateId: 1, skills: {} }),
    )

    const proj2 = path.join(SANDBOX, `symlinked-nocreds-${Math.random().toString(36).slice(2)}`)
    mkdirSync(proj2, { recursive: true })
    symlinkSync(outside, path.join(proj2, ".altimate-code"))

    const credsFile = path.join(SANDBOX, "home", ".altimate", "altimate.json")
    const saved = readFileSync(credsFile, "utf8")
    rmSync(credsFile, { force: true })
    try {
      await syncSkills(proj2)
      expect(readFileSync(path.join(victim, "pub-x", "SKILL.md"), "utf8")).toBe("must survive")
    } finally {
      writeFileSync(credsFile, saved)
    }
  })

  test("a cached binding the server no longer recognises is not retained", async () => {
    // The cache is written by an explicit link and otherwise never expires, so
    // without revalidation a project detached in the SaaS keeps serving its old
    // workspace's skills on this machine forever.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
    // The local binding is still on disk — this is NOT the unbound-cache case.
    expect(JSON.parse(readFileSync(cachePath(), "utf8")).bindings[realpathSync(project)]).toBeDefined()

    globalThis.fetch = (async (input: string | URL) => {
      if (String(input).includes("/datamate-project-bindings/by-")) {
        return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
      }
      return json({ items: [], total: 0, page: 1, size: 50, pages: 1 })
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(path.join(project, MANAGED))).toBe(false)
    // And the stale row is gone, so a later read cannot resurrect it.
    expect(JSON.parse(readFileSync(cachePath(), "utf8")).bindings[realpathSync(project)]).toBeUndefined()
  })

  test("linking just after an unbound turn is not undone by the negative cache", async () => {
    // A turn taken while the project is unlinked memoizes "no binding here" for
    // MISS_TTL_MS. If linking inside that window reads the memo as an
    // authoritative answer, revalidation deletes the row the link just wrote and
    // the link silently does nothing — the user links and gets no skills.
    rmSync(cachePath(), { force: true })
    globalThis.fetch = (async (input: string | URL) => {
      if (String(input).includes("/datamate-project-bindings/by-")) {
        return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
      }
      return json({ items: [], total: 0, page: 1, size: 50, pages: 1 })
    }) as unknown as typeof fetch
    await syncSkills(project)

    // The link. Deliberately still inside the miss window.
    await recordApprovedBinding(project, {
      datamateId: 7,
      datamateName: "ws-7",
      repoRemote: null,
      projectPath: project,
      linkedAt: Date.now(),
    })
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    expect(JSON.parse(readFileSync(cachePath(), "utf8")).bindings[realpathSync(project)]).toBeDefined()
    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
  })

  test("a cached binding survives a server that cannot be reached", async () => {
    // Revalidation must not tear down a working setup over a network blip.
    serve({ "pub-1": { "SKILL.md": "one" } })
    await syncSkills(project)

    // Workspace unchanged; only the binding lookup is unreachable. Serving an
    // empty list here instead would delete the snapshot for a different and
    // entirely correct reason, proving nothing about revalidation.
    serve({ "pub-1": { "SKILL.md": "one" } })
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/datamate-project-bindings/by-")) throw new Error("offline")
      return inner(input as never, init as never)
    }) as unknown as typeof fetch
    await syncSkills(project)

    expect(existsSync(skillFile("pub-1", "SKILL.md"))).toBe(true)
    expect(JSON.parse(readFileSync(cachePath(), "utf8")).bindings[realpathSync(project)]).toBeDefined()
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
