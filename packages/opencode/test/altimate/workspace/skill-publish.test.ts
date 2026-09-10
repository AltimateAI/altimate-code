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
  ManagedSkillError,
  SkillNameConflictError,
  collectBundle,
  isManagedSkill,
  publishSkill,
} = await import("../../../src/altimate/workspace/skill-publish")

type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>
// Saved and restored. Bun runs every test file in one process, so a stub left in
// place here leaks into sibling suites — which is exactly what happened: 47
// unrelated workspace tests failed until this was put back.
const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => true
;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
  ({ altimateInstanceName: "acme", altimateUrl: "https://api.example.com", altimateApiKey: "k" }) as Creds

afterAll(() => {
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured = originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: typeof originalGetCreds }).getCredentials = originalGetCreds
})

const originalFetch = globalThis.fetch
let requests: { method: string; url: string; body: any }[] = []
/** Per-method status. `POST` 409 exercises the name conflict; `PATCH` 404 the
 * published-then-deleted fallback. */
let statuses: Record<string, number> = {}

let project = ""
let skillDir = ""

beforeEach(() => {
  requests = []
  statuses = {}
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
    return new Response(JSON.stringify({ public_id: "pub-1" }), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

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
  test("refuses an oversized file WITHOUT reading it into memory", async () => {
    // The guard checked the running total after `readFile`, so a single huge
    // file was fully loaded before being rejected — the limit enforced only
    // once the memory had already been spent. Asserting on the rejection alone
    // does not test that: the post-read check rejects too, and the mutation
    // survived. The property is that `readFile` is never called for the file.
    const dir = path.join(SANDBOX, `oversize-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: big\n---\n")
    const huge = path.join(dir, "huge.txt")
    const fd = openSync(huge, "w")
    try {
      ftruncateSync(fd, 64 * 1024 * 1024) // sparse: past the limit, cheap on disk
    } finally {
      closeSync(fd)
    }

    const read: string[] = []
    const originalReadFile = fsp.readFile
    ;(fsp as unknown as { readFile: unknown }).readFile = ((...args: unknown[]) => {
      read.push(String(args[0]))
      return (originalReadFile as (...a: unknown[]) => unknown)(...args)
    }) as unknown as typeof fsp.readFile

    try {
      await expect(collectBundle(dir)).rejects.toThrow(/larger than/i)
    } finally {
      ;(fsp as unknown as { readFile: unknown }).readFile = originalReadFile
    }
    expect(read.some((r) => r.endsWith("huge.txt"))).toBe(false)
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

    // Switch accounts, publish the same directory.
    ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
      ({ altimateInstanceName: "other", altimateUrl: "https://api.example.com", altimateApiKey: "k" }) as Creds
    requests = []
    await publish() // must CREATE for "other", not update acme's id
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1)

    // Back to the first account: its id must still be there, so this UPDATES.
    ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
      ({ altimateInstanceName: "acme", altimateUrl: "https://api.example.com", altimateApiKey: "k" }) as Creds
    requests = []
    const report = await publish()

    expect(report.action).toBe("updated")
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)
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
