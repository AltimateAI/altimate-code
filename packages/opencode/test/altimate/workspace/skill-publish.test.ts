// altimate_change - new file
//
// Unit coverage for publishing a locally-authored skill (skill-publish.ts).
//
// House style, matching memory-sync.test.ts: no `mock.module()`. Real files in a
// real sandbox, network stubbed at `globalThis.fetch` so assertions are about the
// requests actually issued — method, path, body — rather than a mock's call log.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import fsp from "node:fs/promises"
import os from "node:os"

const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const SANDBOX = path.join(os.tmpdir(), `altimate-publish-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")

afterAll(() => {
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const { AltimateApi } = await import("../../../src/altimate/api/client")
const {
  BinaryFileError,
  EmptyBundleError,
  NotProjectSkillError,
  NotWorkspaceOwnerError,
  SkillChangedElsewhereError,
  ManagedSkillError,
  NotLinkedError,
  SkillNameConflictError,
  SymlinkError,
  collectBundle,
  describePublish,
  explainPublishError,
  isManagedSkill,
  ledgerPathForTests,
  publishSkill,
} = await import("../../../src/altimate/workspace/skill-publish")
const { recordApprovedBinding } = await import("../../../src/altimate/workspace/state")

type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>
// Saved and restored. Bun runs every test file in one process, so a stub left in
// place here leaks into sibling suites — which is exactly what happened: 47
// unrelated workspace tests failed until this was put back.
const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
const stubCreds = (over: Partial<Creds> = {}) => {
  ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
    ({ altimateInstanceName: "acme", altimateUrl: "https://api.example.com", altimateApiKey: "k", ...over }) as Creds
}
;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => true
stubCreds()

afterAll(() => {
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured = originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: typeof originalGetCreds }).getCredentials = originalGetCreds
})

const originalFetch = globalThis.fetch
let requests: { method: string; url: string; body: any }[] = []
/** Per-method status. `POST` 409 exercises the name conflict; `PATCH` 404 the
 * published-then-deleted fallback. */
let statuses: Record<string, number> = {}
/** What `GET /skills/{id}` reports as the skill's current workspaces. The attach
 * endpoint REPLACES the set, so tests that care about merging seed this. */
let attached: number[] = []
/** The `detail` an error response carries. The update path answers 409 for a
 * name collision, a refused bundle deletion and a lost compare-and-swap, and
 * the client tells them apart by this string. */
let conflictDetail = "You already have a skill named 'deploy'"
/** Who the server says the caller is (`GET /users/me`), and who owns each
 * workspace in the list. Ownership, not visibility, is what attaching needs. */
let me = 7
let workspaceOwners: Record<number, number> = { 42: 7, 77: 7, 99: 7 }
/** `created_by` on every skill the server answers with. */
let skillCreator = 7
/** Skill ids the server has deleted. */
let deleted: string[] = []

let project = ""
let skillDir = ""

beforeEach(async () => {
  requests = []
  statuses = {}
  attached = []
  conflictDetail = "You already have a skill named 'deploy'"
  me = 7
  workspaceOwners = { 42: 7, 77: 7, 99: 7 }
  skillCreator = 7
  deleted = []
  project = mkdtempSync(path.join(SANDBOX, "proj-"))
  skillDir = path.join(project, "skills", "deploy")
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: deploy\n---\nrun it\n")

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    let body: any = undefined
    try {
      body = init?.body ? JSON.parse(init.body) : undefined
    } catch {
      /* non-JSON bodies are not used here */
    }
    requests.push({ method, url, body })
    if (method === "GET" && url.endsWith("/users/me"))
      return new Response(JSON.stringify({ id: me }), { status: 200, headers: { "content-type": "application/json" } })
    if (method === "GET" && url.endsWith("/datamates/"))
      return new Response(
        JSON.stringify({
          datamates: Object.entries(workspaceOwners).map(([id, owner]) => ({
            id: Number(id),
            name: `ws-${id}`,
            memory_enabled: false,
            user_id: owner,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    if (method === "DELETE" && url.includes("/skills/")) {
      deleted.push(decodeURIComponent(url.split("/skills/")[1]))
      return new Response(null, { status: 204 })
    }
    const status = statuses[method] ?? (method === "POST" ? 201 : 200)
    if (status >= 400)
      return new Response(JSON.stringify({ detail: conflictDetail }), {
        status,
        headers: { "content-type": "application/json" },
      })
    // The server's real envelope: skill reads and writes answer
    // `{skill: {...}}` (`CustomSkillResponse`); the set-workspaces endpoint
    // answers flat. A flat stub for the detail read hid a real defect — the
    // attachment list was read at the top level, found nothing, and the
    // replace detached the skill from every other workspace.
    const body_ =
      method === "PUT"
        ? { public_id: "pub-1", attached_datamate_ids: attached }
        : { skill: { public_id: "pub-1", attached_datamate_ids: attached, created_by: skillCreator } }
    return new Response(JSON.stringify(body_), { status, headers: { "content-type": "application/json" } })
  }) as typeof fetch

  // Publishing requires a linked project — it fails closed otherwise, because an
  // unattached skill is invisible in every workspace. Seeded after the stub is in
  // place (the bind kicks off a best-effort skill sync that hits it), and the
  // request log is cleared after so assertions see only what publish itself does.
  await link(42, "Growth")
  requests = []
})

afterEach(() => {
  globalThis.fetch = originalFetch
  // A test that switched accounts must not leave the next one there.
  stubCreds()
})

/** Link the sandbox project. Awaited through the bind's detached work, so its
 * skill sync and backfill land inside this test's stubbed `fetch` and request
 * log rather than straddling into the next test's. */
async function link(datamateId: number, datamateName: string, dir = project) {
  await recordApprovedBinding(
    dir,
    { datamateId, datamateName, repoRemote: null, projectPath: dir, linkedAt: Date.now() } as never,
    { awaitBackfill: true },
  )
}

const publish = () =>
  publishSkill({ projectDirectory: project, skillDirectory: skillDir, name: "deploy", description: "d" })

describe("collectBundle", () => {
  test("refuses a file that is not UTF-8, naming it", async () => {
    // The wire format carries content as a string, so a binary file cannot
    // round-trip. Caught here it is one local error; uncaught, the upload
    // succeeds and the skill is skipped on every OTHER machine's pull.
    writeFileSync(path.join(skillDir, "logo.png"), Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]))

    const err = await collectBundle(skillDir).catch((e) => e)

    expect(err).toBeInstanceOf(BinaryFileError)
    expect(String(err)).toContain("logo.png")
  })

  test("decodes strictly rather than substituting replacement characters", async () => {
    // The default TextDecoder would turn an invalid sequence into U+FFFD and hand
    // back a "valid" string, publishing a file that differs from the one on disk.
    writeFileSync(path.join(skillDir, "notes.md"), Buffer.from([0x68, 0x69, 0xc3, 0x28]))

    await expect(collectBundle(skillDir)).rejects.toBeInstanceOf(BinaryFileError)
  })

  test("walks nested directories and reports posix-style relative paths", async () => {
    mkdirSync(path.join(skillDir, "references"), { recursive: true })
    writeFileSync(path.join(skillDir, "references", "api.md"), "docs")

    const files = await collectBundle(skillDir)

    expect(files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/api.md"])
  })

  test("names a symbolic link rather than silently leaving it out", async () => {
    // `readdir` reports a link as neither file nor directory, and the walk
    // skipped it with nothing said. Local discovery follows links, so the
    // skill worked here and arrived everywhere else missing the linked files.
    const shared = path.join(project, "shared")
    mkdirSync(shared, { recursive: true })
    writeFileSync(path.join(shared, "api.md"), "docs")
    symlinkSync(shared, path.join(skillDir, "references"))

    const err = await collectBundle(skillDir).catch((e) => e)

    expect(err).toBeInstanceOf(SymlinkError)
    expect(String(err)).toContain("references")
  })
})

describe("isManagedSkill", () => {
  test("recognises the workspace-owned snapshot", () => {
    const managed = path.join(project, ".altimate-code", "skill", "_workspace", "theirs")
    expect(isManagedSkill(project, managed)).toBe(true)
  })

  test("does not mistake a sibling path with the same prefix", () => {
    // `_workspace-notes` starts with the managed path as a string but is not
    // inside it — a plain `startsWith` without the separator would refuse it.
    const sibling = path.join(project, ".altimate-code", "skill", "_workspace-notes")
    expect(isManagedSkill(project, sibling)).toBe(false)
  })

  test("does not flag the user's own skills", () => {
    expect(isManagedSkill(project, skillDir)).toBe(false)
  })
})

describe("publishSkill", () => {
  test("refuses to publish a skill the workspace sent us", async () => {
    const managed = path.join(project, ".altimate-code", "skill", "_workspace", "theirs")
    mkdirSync(managed, { recursive: true })
    writeFileSync(path.join(managed, "SKILL.md"), "---\nname: theirs\n---\n")

    const err = await publishSkill({
      projectDirectory: project,
      skillDirectory: managed,
      name: "theirs",
      description: "d",
    }).catch((e) => e)

    expect(err).toBeInstanceOf(ManagedSkillError)
    // And nothing was sent. A refusal that still uploaded would be worse than none.
    expect(requests).toHaveLength(0)
  })

  test("creates on the first publish and carries the bundle", async () => {
    const report = await publish()

    expect(report.action).toBe("created")
    expect(report.publicId).toBe("pub-1")
    const post = requests.find((r) => r.method === "POST")!
    expect(post.body.name).toBe("deploy")
    expect(post.body.files.map((f: any) => f.path)).toEqual(["SKILL.md"])
    // `privacy` is deliberately unset: the server defaults to private, and
    // publishing should not disclose a skill org-wide as a side effect.
    expect(post.body.privacy).toBeUndefined()
  })

  test("updates in place on the second publish rather than creating a duplicate", async () => {
    await publish()
    requests = []

    const report = await publish()

    expect(report.action).toBe("updated")
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)
    const patch = requests.find((r) => r.method === "PATCH")!
    expect(patch.url).toContain("pub-1")
  })

  test("reports a name conflict as its own error, not a raw API conflict", async () => {
    statuses.POST = 409
    conflictDetail = "You already have a skill named 'deploy'"

    const err = await publish().catch((e) => e)

    expect(err).toBeInstanceOf(SkillNameConflictError)
    expect(String(err)).toContain("published")
  })

  test("an empty skill directory is its own error, not a size problem", async () => {
    rmSync(path.join(skillDir, "SKILL.md"))
    const err = await publish().catch((e) => e)
    expect(err).toBeInstanceOf(EmptyBundleError)
    // The pre-flights read who we are and whose the workspace is; nothing
    // was uploaded.
    expect(requests.filter((r) => r.method !== "GET")).toHaveLength(0)
  })

  test("creates its own skill when the recorded id belongs to someone else", async () => {
    // The legacy ledger keys predate creator scoping, so on a shared machine
    // a row another user of the same tenant wrote can be found. The server
    // answers the PATCH with 403; that skill is theirs, and publishing must
    // not fail on it.
    await publish()
    requests = []
    statuses.PATCH = 403

    const report = await publish()

    expect(report.action).toBe("created")
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1)
  })

  test("re-creates a skill that has been deleted in the workspace since we published it", async () => {
    // Otherwise the user is stranded: a local id they cannot see, update or clear.
    await publish()
    requests = []
    statuses.PATCH = 404

    const report = await publish()

    expect(report.action).toBe("created")
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1)
  })
})

describe("the bundle size guard", () => {
  const sparse = (file: string, size: number) => {
    const fd = openSync(file, "w")
    try {
      ftruncateSync(fd, size) // sparse: cheap on disk, and zeros decode as UTF-8
    } finally {
      closeSync(fd)
    }
  }

  test("refuses an oversized file WITHOUT reading it into memory", async () => {
    // The guard checked the running total after the read, so a single huge
    // file was fully loaded before being rejected — the limit enforced only
    // once the memory had already been spent. The property is that the file is
    // never read at all.
    const dir = path.join(SANDBOX, `oversize-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: big\n---\n")
    sparse(path.join(dir, "huge.txt"), 64 * 1024 * 1024)

    const read: string[] = []
    const originalOpen = fsp.open
    ;(fsp as unknown as { open: unknown }).open = (async (...args: unknown[]) => {
      const handle = await (originalOpen as (...a: unknown[]) => Promise<fsp.FileHandle>)(...args)
      const inner = handle.read.bind(handle)
      ;(handle as unknown as { read: unknown }).read = (...rest: unknown[]) => {
        read.push(String(args[0]))
        return (inner as (...a: unknown[]) => unknown)(...rest)
      }
      return handle
    }) as unknown as typeof fsp.open

    try {
      await expect(collectBundle(dir)).rejects.toThrow(/larger than/i)
    } finally {
      ;(fsp as unknown as { open: unknown }).open = originalOpen
    }
    // The oversized file specifically: refused on its measurement, before a
    // single read. `SKILL.md` may well have been read first — directory order
    // is the filesystem's.
    expect(read.some((p) => p.endsWith("huge.txt"))).toBe(false)
  })

  test("a file that grew after it was measured is still refused", async () => {
    // A stat before the read only narrows the window: a file can grow between
    // the two, and a read sized by the stat then pulled the whole new file in
    // before any check ran. The read is chunked and stops the moment the
    // budget is exceeded, whatever the file measured.
    const dir = path.join(SANDBOX, `grew-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    sparse(path.join(dir, "grew.txt"), 10 * 1024 * 1024 + 1)

    const originalOpen = fsp.open
    ;(fsp as unknown as { open: unknown }).open = (async (...args: unknown[]) => {
      const handle = await (originalOpen as (...a: unknown[]) => Promise<fsp.FileHandle>)(...args)
      // The measurement lies: the file "was" tiny when stat'd.
      ;(handle as unknown as { stat: unknown }).stat = async () => ({ size: 10 })
      return handle
    }) as unknown as typeof fsp.open

    try {
      await expect(collectBundle(dir)).rejects.toThrow(/larger than/i)
    } finally {
      ;(fsp as unknown as { open: unknown }).open = originalOpen
    }
  })

  test("a symlinked skill directory into the managed snapshot is still managed", async () => {
    // `path.resolve` is lexical, so a skill directory that IS a link into the
    // workspace-owned snapshot resolved to its own path and passed the check —
    // and the bundle walk then followed the link and would have published the
    // workspace's own skills back to it.
    const proj = mkdtempSync(path.join(SANDBOX, "symproj-"))
    const managed = path.join(proj, ".altimate-code", "skill", "_workspace", "pub-a")
    mkdirSync(managed, { recursive: true })
    const link = path.join(proj, "looks-local")
    symlinkSync(managed, link)

    expect(isManagedSkill(proj, link)).toBe(true)
  })

  test("republishing after deleting a file succeeds", async () => {
    // `files` replaces the bundle server-side, and a path it omits is a
    // deletion the server refuses unless the caller says so. Without
    // `replace_bundle` this 409'd forever, and the user was told to rename a
    // skill whose name was never the problem.
    writeFileSync(path.join(skillDir, "extra.md"), "notes")
    await publish()
    rmSync(path.join(skillDir, "extra.md"))
    requests = []

    const report = await publish()

    expect(report.action).toBe("updated")
    const patch = requests.find((r) => r.method === "PATCH")!
    expect(patch.body.replace_bundle).toBe(true)
    expect(patch.body.files.map((f: any) => f.path)).toEqual(["SKILL.md"])
  })

  test("a skill edited in the workspace mid-upload says so, rather than blaming the name", async () => {
    // The server's compare-and-swap refuses and nothing is written. Renaming
    // does not help; publishing again does.
    await publish()
    statuses.PATCH = 409
    conflictDetail = "This skill changed while you were editing it, please reload"

    const err = await publish().catch((e) => e)

    expect(err).toBeInstanceOf(SkillChangedElsewhereError)
    expect(String(err)).toContain("Publish again")
  })

  test("junk a skill directory accumulates never leaves the machine", async () => {
    // A public skill's bundle is readable tenant-wide, and a secret that
    // reaches it cannot be recalled by deleting the local file.
    writeFileSync(path.join(skillDir, ".env"), "ALTIMATE_API_KEY=secret")
    writeFileSync(path.join(skillDir, ".ENV.production"), "ALTIMATE_API_KEY=secret") // case-insensitive file systems
    writeFileSync(path.join(skillDir, ".envrc"), "export ALTIMATE_API_KEY=secret") // direnv
    writeFileSync(path.join(skillDir, ".DS_Store"), "junk")
    writeFileSync(path.join(skillDir, "SKILL.md~"), "editor backup")
    mkdirSync(path.join(skillDir, ".git"), { recursive: true })
    writeFileSync(path.join(skillDir, ".git", "config"), "[core]")

    const files = await collectBundle(skillDir)

    expect(files.map((f) => f.path)).toEqual(["SKILL.md"])
  })

  test("a worktree's .git file is junk too, not only a .git directory", async () => {
    // `git worktree add` leaves a regular file named `.git` holding
    // `gitdir: /path/to/main/.git/worktrees/...`. The directory skip does not
    // see it.
    const wt = path.join(project, "skills", "wt")
    mkdirSync(wt, { recursive: true })
    writeFileSync(path.join(wt, "SKILL.md"), "---\nname: wt\n---\n")
    writeFileSync(path.join(wt, ".git"), "gitdir: /somewhere/.git/worktrees/wt\n")

    const files = await collectBundle(wt)

    expect(files.map((f) => f.path)).toEqual(["SKILL.md"])
  })

  test("the file ceiling is the server's, and file 101 is refused before it is opened", async () => {
    // The server's `MAX_BUNDLE_FILES` is 100. A local ceiling of 200 let a
    // 101–200 file bundle read in full, upload in full, and be refused with a
    // 400 — the case the constant exists to prevent.
    const dir = path.join(SANDBOX, `many-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 101; i++) writeFileSync(path.join(dir, `f${String(i).padStart(3, "0")}.md`), "x")

    const opened: string[] = []
    const originalOpen = fsp.open
    ;(fsp as unknown as { open: unknown }).open = (async (...args: unknown[]) => {
      opened.push(path.basename(String(args[0])))
      return (originalOpen as (...a: unknown[]) => unknown)(...args)
    }) as unknown as typeof fsp.open
    try {
      await expect(collectBundle(dir)).rejects.toThrow(/more than 100 files/)
    } finally {
      ;(fsp as unknown as { open: unknown }).open = originalOpen
    }
    expect(opened).toHaveLength(100)
  })

  test("a rename that collides on the update path is a typed conflict", async () => {
    // The create path mapped 409 to SkillNameConflictError; the update path did
    // not, so a PATCH that renames onto an existing name surfaced the raw
    // server envelope — the exact thing this module's typed errors exist to
    // prevent. The second publish carries a NEW name, so it is a rename.
    await publish() // records the id, so the next call takes the PATCH branch
    statuses.PATCH = 409
    conflictDetail = "You already have a skill named 'release'"
    requests = []

    const err = await publishSkill({
      projectDirectory: project,
      skillDirectory: skillDir,
      name: "release",
      description: "d",
    }).catch((e) => e)

    expect(err).toBeInstanceOf(SkillNameConflictError)
    expect((err as { skillName: string }).skillName).toBe("release")
    // It was a rename on the PATCH, not a create under the new name.
    expect(requests.find((r) => r.method === "PATCH")?.body.name).toBe("release")
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })
})

describe("the published-id ledger", () => {
  test("keeps a separate id per account for the same skill directory", async () => {
    // A bare directory key held ONE record, so publishing to a second account
    // overwrote the first account's id. Switching back created a second skill
    // and 409'd on the name already there, with no way to reach the original.
    await publish() // account "acme" -> pub-1
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1)

    // Switch accounts, publish the same directory. The binding cache is scoped
    // by tenant, so the project must be linked under the new account too —
    // publish now fails closed on an unlinked project, correctly.
    stubCreds({ altimateInstanceName: "other" })
    await link(99, "Other")
    requests = []
    await publish() // must CREATE for "other", not update acme's id
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1)

    // Back to the first account: its id must still be there, so this UPDATES.
    // The binding cache is single-tenant, so the "other" link replaced acme's
    // row — re-link, as a real account switch would resolve it again.
    stubCreds()
    await link(42, "Growth")
    requests = []
    const report = await publish()

    expect(report.action).toBe("updated")
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })

  test("keeps a separate id per user of the same tenant", async () => {
    // Skill names are unique per CREATOR server-side. Two users of one tenant
    // publishing the same directory are two creators; a ledger keyed on the
    // tenant handed the second user the first user's id, and the PATCH came
    // back 403. The user's id is in the scope.
    await publish() // user 7 -> pub-1
    me = 8 // another user of the same tenant
    workspaceOwners = { 42: 8 }
    requests = []

    const report = await publish()

    expect(report.action).toBe("created")
    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(0)
  })

  test("one directory reached by two paths is one skill", async () => {
    // `path.resolve` is lexical: the same checkout through a link (`/tmp` and
    // `/private/tmp`, a linked worktree) was two ledger keys, so the second
    // publish created again and 409'd on its own name — "published from
    // somewhere else", by this machine, a moment ago.
    // The two spellings: the sandbox's lexical path and its real path. On
    // macOS `os.tmpdir()` is under `/var`, a link to `/private/var`, so these
    // differ; elsewhere they are equal and the test still holds trivially.
    // (Not a symlinked skill root — that is refused on purpose, see "what
    // counts as a project skill".)
    const lexical = skillDir
    const real = realpathSync(skillDir)
    await publishSkill({ projectDirectory: project, skillDirectory: lexical, name: "deploy", description: "d" })
    requests = []

    const report = await publishSkill({ projectDirectory: project, skillDirectory: real, name: "deploy", description: "d" })

    expect(report.action).toBe("updated")
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })

  test("two publishes of the same directory at once create it once", async () => {
    // Serialising the ledger was not enough: both looked up before either
    // recorded, both POSTed, and the loser got a name conflict for a skill
    // this machine had just created.
    const [a, b] = await Promise.all([publish(), publish()])

    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1)
    expect([a.action, b.action].sort()).toEqual(["created", "updated"])
  })

  test("concurrent publishes do not drop each other's id", async () => {
    // Each publish read, mutated and wrote the whole ledger, so the later write
    // carried the earlier one away and that skill re-created on its next run.
    const other = path.join(project, "skills", "second")
    mkdirSync(other, { recursive: true })
    writeFileSync(path.join(other, "SKILL.md"), "---\nname: second\n---\n")

    await Promise.all([
      publish(),
      publishSkill({ projectDirectory: project, skillDirectory: other, name: "second", description: "d" }),
    ])

    // Both ids survived: neither directory creates again.
    requests = []
    const a = await publish()
    const b = await publishSkill({
      projectDirectory: project,
      skillDirectory: other,
      name: "second",
      description: "d",
    })
    expect(a.action).toBe("updated")
    expect(b.action).toBe("updated")
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })
})


describe("what counts as a project skill", () => {
  test("a skill root that is a symbolic link is refused before anything is read", async () => {
    // The walk refuses links INSIDE a skill; a root that is itself a link was
    // followed, and published whatever it pointed at — a built-in, say —
    // which `isManagedSkill` cannot see because the target is not the
    // managed snapshot.
    // The target is INSIDE the project, so the outside-project rule does not
    // catch it: only the root-is-a-link rule does.
    const target = path.join(project, "vendor", "elsewhere")
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, "SKILL.md"), "---\nname: elsewhere\n---\n")
    const link = path.join(project, "skills", "looks-local")
    symlinkSync(target, link)

    const err = await publishSkill({ projectDirectory: project, skillDirectory: link, name: "elsewhere", description: "d" }).catch(
      (e) => e,
    )

    expect(err).toBeInstanceOf(NotProjectSkillError)
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })

  test("a skill outside the project is refused", async () => {
    // A personal skill under the home directory is the user's, not this
    // project's, and publishing would share it with the whole workspace.
    const personal = mkdtempSync(path.join(SANDBOX, "personal-"))
    writeFileSync(path.join(personal, "SKILL.md"), "---\nname: personal\n---\n")

    const err = await publishSkill({ projectDirectory: project, skillDirectory: personal, name: "personal", description: "d" }).catch(
      (e) => e,
    )

    expect(err).toBeInstanceOf(NotProjectSkillError)
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })
})

describe("a workspace the caller does not own", () => {
  // Linking needs only visibility, so a project can be bound to a colleague's
  // shared workspace. Attaching a skill needs ownership, and answers 404
  // otherwise — on every publish. Without a pre-flight the create went
  // through, the attach failed, and the skill sat on the server attached to
  // nothing, forever: the UAT report this module exists to close.
  test("is refused before anything is uploaded", async () => {
    workspaceOwners = { 42: 99 } // someone else's

    const err = await publish().catch((e) => e)

    expect(err).toBeInstanceOf(NotWorkspaceOwnerError)
    expect(String(err)).toContain('"Growth"')
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })

  test("takes back a skill the workspace then refuses, when the list could not say", async () => {
    // An older server omits the owner from the list; only the attach can
    // answer. A 404 there, straight after a create, is compensated: the skill
    // just made is deleted and the id forgotten, so nothing is left behind
    // and the next publish does not PATCH an orphan.
    workspaceOwners = {}
    const originalFetch2 = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "PUT" && url.includes("/datamates")) {
        requests.push({ method, url, body: undefined })
        return new Response(JSON.stringify({ detail: "Workspace not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }
      return originalFetch2(input, init)
    }) as typeof fetch
    try {
      const err = await publish().catch((e) => e)
      expect(err).toBeInstanceOf(NotWorkspaceOwnerError)
      expect(deleted).toEqual(["pub-1"])
      requests = []
      // The id was forgotten: the next publish creates, not updates.
      await publish().catch(() => {})
      expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(0)
      expect(requests.filter((r) => r.method === "POST")).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch2
    }
  })
})

describe("the published-id ledger survives a key rotation", () => {
  test("a rotated API key for the same user still finds the id", async () => {
    // The scope was a digest of the key, so a rotation made every id on this
    // machine unreachable and the next publish created again — 409 on the
    // name, and "published from somewhere else". The user is the identity.
    await publish()
    stubCreds({ altimateApiKey: "k-rotated" })
    requests = []

    const report = await publish()

    expect(report.action).toBe("updated")
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })

  test("a legacy row is re-homed once the server confirms the skill is this user's", async () => {
    // Rows written under the digest scheme carry no creator. One GET decides,
    // and the row is rewritten under the current key so it is not asked again.
    await publish()
    const file = ledgerPathForTests()
    const ledger = JSON.parse(readFileSync(file, "utf8"))
    const mine = Object.keys(ledger).find((k) => k.endsWith(realpathSync(skillDir)))!
    const { createdBy, ...legacy } = ledger[mine]
    delete ledger[mine]
    // The digest of a key that is NOT the current one — which is what a real
    // rotation leaves on disk, and why the lookup cannot be by digest.
    ledger[`acme|https://api.example.com|${createHash("sha256").update("the-key-before-rotation").digest("hex").slice(0, 16)}|${realpathSync(skillDir)}`] = legacy
    writeFileSync(file, JSON.stringify(ledger))
    requests = []

    const report = await publish()

    expect(report.action).toBe("updated")
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)
    const after = JSON.parse(readFileSync(file, "utf8"))
    expect(Object.keys(after).some((k) => k.includes("|u7|"))).toBe(true)
  })

  test("a legacy row for someone else's skill is not trusted", async () => {
    await publish()
    const file = ledgerPathForTests()
    const ledger = JSON.parse(readFileSync(file, "utf8"))
    const mine = Object.keys(ledger).find((k) => k.endsWith(realpathSync(skillDir)))!
    const { createdBy, ...legacy } = ledger[mine]
    delete ledger[mine]
    // The tenant-only shape keyed on `path.resolve`, not the real path.
    ledger[`acme|https://api.example.com|${path.resolve(skillDir)}`] = legacy
    writeFileSync(file, JSON.stringify(ledger))
    skillCreator = 99 // the server says the skill is another user's
    requests = []

    const report = await publish()

    expect(report.action).toBe("created")
    // Decided by asking, not by assuming: the server was asked whose the
    // skill is BEFORE anything was uploaded, and no PATCH went out.
    const firstUpload = requests.findIndex((r) => r.method === "POST" || r.method === "PATCH")
    const asked = requests.findIndex((r) => r.method === "GET" && r.url.endsWith("/skills/pub-1"))
    expect(asked).toBeGreaterThanOrEqual(0)
    expect(asked).toBeLessThan(firstUpload)
    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(0)
  })
})

describe("attaching to the workspace", () => {
  // Creating a skill and attaching it to a workspace are two calls on the
  // server, and only the first was ever made. The result was a skill that
  // existed but appeared in no workspace — the CLI and the web UI both list
  // workspace skills by datamate id — which is the UAT report this closes.
  const puts = () => requests.filter((r) => r.method === "PUT" && r.url.includes("/datamates"))

  test("attaches a newly created skill to the bound workspace", async () => {
    const report = await publish()
    expect(report.action).toBe("created")
    expect(report.datamateId).toBe(42)
    expect(puts()).toHaveLength(1)
    expect(puts()[0].body).toEqual({ datamate_ids: [42] })
  })

  test("merges with the workspaces the skill is already on, because the endpoint replaces", async () => {
    // A bare put of [42] would silently detach the skill from workspace 7.
    attached = [7]
    await publish()
    expect(puts()[0].body).toEqual({ datamate_ids: [7, 42] })
  })

  test("does not re-attach a skill already on this workspace", async () => {
    attached = [42]
    await publish()
    expect(puts()).toHaveLength(0)
  })

  test("attaches on the update path too, keeping the workspace it was on", async () => {
    // Published while the project was linked to one workspace, then the
    // project is re-linked to another: the update must attach to the new one,
    // or the skill is refreshed but still absent from it — and must not drop
    // the first, which the replace semantics would do with a bare put.
    await publish() // attached to 42
    attached = [42]
    await link(77, "Platform")
    requests = []

    const report = await publish()

    expect(report.action).toBe("updated")
    expect(report.datamateId).toBe(77)
    expect(puts()).toHaveLength(1)
    expect(puts()[0].body).toEqual({ datamate_ids: [42, 77] })
  })

  test("refuses to publish from an unlinked project, before uploading anything", async () => {
    const unlinked = mkdtempSync(path.join(SANDBOX, "unlinked-"))
    const dir = path.join(unlinked, "skills", "x")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: x\n---\n")

    const err = await publishSkill({ projectDirectory: unlinked, skillDirectory: dir, name: "x", description: "d" }).catch(
      (e) => e,
    )

    expect(err).toBeInstanceOf(NotLinkedError)
    // The property that matters: nothing reached the server. Uploading first
    // would create exactly the orphan the attach step exists to prevent.
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })
})

describe("what a surface says", () => {
  // The CLI and the TUI share these lines so a user moving between them
  // recognises the outcome.
  test("names the outcome, the skill, and the size", () => {
    const line = describePublish({ action: "created", publicId: "p", name: "deploy", files: 3, bytes: 2048, datamateId: 1 })
    expect(line).toContain("Published")
    expect(line).toContain('"deploy"')
    expect(line).toContain("3 files")
    expect(line).toContain("2KB")
    expect(describePublish({ action: "updated", publicId: "p", name: "d", files: 1, bytes: 12, datamateId: 1 })).toContain(
      "Updated",
    )
    expect(describePublish({ action: "updated", publicId: "p", name: "d", files: 1, bytes: 12, datamateId: 1 })).toContain(
      "1 file,",
    )
  })

  test("passes a deliberate error through and wraps nothing else", async () => {
    // Each typed error already says what to do; an unexpected one must not be
    // shown as if it were advice.
    const unlinked = mkdtempSync(path.join(SANDBOX, "unlinked-"))
    const dir = path.join(unlinked, "skills", "x")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: x\n---\n")
    const err = await publishSkill({ projectDirectory: unlinked, skillDirectory: dir, name: "x", description: "d" }).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(NotLinkedError)
    expect(explainPublishError(err)).toContain("altimate-code link")
    expect(explainPublishError(new SymlinkError("references"))).toContain("references")
    // Advice, not a failure: the surfaces show this one as-is.
    expect(explainPublishError(new NotWorkspaceOwnerError("ws"))).toContain("Skills can only be published")
    expect(explainPublishError(new Error("ECONNRESET"))).toBeNull()
  })
})
