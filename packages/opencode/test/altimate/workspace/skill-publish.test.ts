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
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
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
  ManagedSkillError,
  NotLinkedError,
  SkillNameConflictError,
  SymlinkError,
  collectBundle,
  isManagedSkill,
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

let project = ""
let skillDir = ""

beforeEach(async () => {
  requests = []
  statuses = {}
  attached = []
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
    const status = statuses[method] ?? (method === "POST" ? 201 : 200)
    if (status >= 400)
      return new Response(JSON.stringify({ detail: "nope" }), {
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
        : { skill: { public_id: "pub-1", attached_datamate_ids: attached } }
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

    const err = await publish().catch((e) => e)

    expect(err).toBeInstanceOf(SkillNameConflictError)
    expect(String(err)).toContain("published")
  })

  test("an empty skill directory is its own error, not a size problem", async () => {
    rmSync(path.join(skillDir, "SKILL.md"))
    const err = await publish().catch((e) => e)
    expect(err).toBeInstanceOf(EmptyBundleError)
    expect(requests).toHaveLength(0)
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

    const reads: number[] = []
    const originalOpen = fsp.open
    ;(fsp as unknown as { open: unknown }).open = (async (...args: unknown[]) => {
      const handle = await (originalOpen as (...a: unknown[]) => Promise<fsp.FileHandle>)(...args)
      const read = handle.read.bind(handle)
      ;(handle as unknown as { read: unknown }).read = (buffer: Buffer, ...rest: unknown[]) => {
        reads.push(buffer.length)
        return (read as (...a: unknown[]) => unknown)(buffer, ...rest)
      }
      return handle
    }) as unknown as typeof fsp.open

    try {
      await expect(collectBundle(dir)).rejects.toThrow(/larger than/i)
    } finally {
      ;(fsp as unknown as { open: unknown }).open = originalOpen
    }
    // Refused on the measurement, before a single read.
    expect(reads).toHaveLength(0)
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

  test("a rename that collides on the update path is a typed conflict", async () => {
    // The create path mapped 409 to SkillNameConflictError; the update path did
    // not, so a PATCH that renames onto an existing name surfaced the raw
    // server envelope — the exact thing this module's typed errors exist to
    // prevent.
    await publish() // records the id, so the next call takes the PATCH branch
    statuses.PATCH = 409

    const err = await publish().catch((e) => e)

    expect(err).toBeInstanceOf(SkillNameConflictError)
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
    // back 403. The account's key is in the scope as a digest.
    await publish() // user "k" -> pub-1
    stubCreds({ altimateApiKey: "someone-else" })
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
    const alias = path.join(project, "skills", "deploy-alias")
    symlinkSync(skillDir, alias)
    await publishSkill({ projectDirectory: project, skillDirectory: alias, name: "deploy", description: "d" })
    requests = []

    const report = await publish()

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
