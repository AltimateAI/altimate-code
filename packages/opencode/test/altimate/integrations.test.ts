import { afterAll, afterEach, describe, expect, spyOn, test, beforeEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import path from "node:path"
import { IntegrationsCore as core } from "../../src/altimate/integrations/core"
import { skipsSynced, clean, syncedTo, SyncCommand, ConnectCommand } from "../../src/cli/cmd/integrations"
import { IntegrationsBackend as backend } from "../../src/altimate/integrations/backend"
import { IntegrationsCredentials as creds } from "../../src/altimate/integrations/credentials"
import { AltimateApi } from "../../src/altimate/api/client"
import * as workspaceState from "../../src/altimate/workspace/state"

const envBefore = { ...process.env }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "integrations-test-"))
process.env.ALTIMATE_INTEGRATIONS_DIR = tmp
process.env.ALTIMATE_INTEGRATIONS_MOCK = "1"

const extraDirs: string[] = []
const osTmp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  extraDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of extraDirs) fs.rmSync(dir, { recursive: true, force: true })
  for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k]
  for (const [k, v] of Object.entries(envBefore)) if (v !== undefined) process.env[k] = v
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true })
  delete process.env.ALTIMATE_INTEGRATIONS_DEMO
})

describe("sameRecord", () => {
  const base = { registered: true, synced: false, variant: "v", connectionId: null, validatedAt: "t", credentialStamp: "a", secretFields: ["token"], values: { url: "x" } }
  test("a credential saved again, or changed in any field, is a different record", () => {
    expect(core.sameRecord(base, { ...base })).toBe(true)
    expect(core.sameRecord({ ...base, values: { url: "x" } }, { ...base, updatedAt: "later" })).toBe(true)
    expect(core.sameRecord({ ...base, credentialStamp: "b" }, base)).toBe(false)
    expect(core.sameRecord({ ...base, values: { url: "y" } }, base)).toBe(false)
    expect(core.sameRecord({ ...base, secretFields: ["other"] }, base)).toBe(false)
  })
})

describe("detection parsing", () => {
  test("claude.json and .mcp.json servers", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"))
    const cwd = fs.mkdtempSync(path.join(tmp, "proj-"))
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { github: { command: "npx", args: ["@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "x" } } },
        projects: { [cwd]: { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } } },
      }),
    )
    fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { atlassian: { type: "sse", url: "https://mcp.atlassian.com/v1/sse" } } }))
    const found = core.detectFromClaudeConfigs(home, cwd)
    const by = Object.fromEntries(found.map((d) => [d.id, d]))
    expect(by.github.source.kind).toBe("mcp")
    expect(by.github.syncable).toBe(true)
    expect(by.linear.source.kind).toBe("mcp-remote")
    expect(by.linear.syncable).toBe(false)
    expect(by.jira.source.kind).toBe("mcp-remote")
    expect(by.jira.note).toBe("usable in Claude; connect in browser to sync")
  })

  test("an MCP server env value counts as a credential only when it is one the provider reads", () => {
    const github = (env: Record<string, string>) => core.detectFromMcpServers({ github: { command: "npx", args: ["server-github"], env } }, "~/.claude.json")
    expect(github({ LOG_LEVEL: "debug", GITHUB_API_URL: "https://x" })).toEqual([])
    expect(github({ GITHUB_PERSONAL_ACCESS_TOKEN: "   " })).toEqual([])
    expect(github({ GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" })[0].syncable).toBe(true)
    expect(core.detectFromMcpServers({ linear: { command: "npx", args: ["linear-mcp"], env: { PLACEHOLDER: "x" } } }, "~/.claude.json")).toEqual([])
  })

  test("jira-cli config", () => {
    expect(core.parseJiraCliConfig("server: https://a.atlassian.net\nlogin: me@a.com\n")).toEqual({
      server: "https://a.atlassian.net",
      login: "me@a.com",
    })
  })
})

describe("status", () => {
  test("shape and states in demo mode", () => {
    process.env.ALTIMATE_INTEGRATIONS_DEMO = "1"
    const s = core.status()
    expect(Object.keys(s)).toEqual(["workspace", "providers"])
    expect(Object.keys(s.providers[0])).toEqual(["id", "name", "state", "source", "account", "syncable", "sync", "updatedAt", "expiresAt", "note"])
    expect(s.providers.map((p) => [p.id, p.state, p.sync, p.syncable])).toEqual([
      ["github", "detected", "pending", true],
      ["jira", "detected", "pending", true],
      ["linear", "available", "local", false],
    ])
    expect(core.status().providers[0].account).toBe("demo-user")
  })

  test("a signed-out user is not shown a linked workspace; mock mode keeps the demo one", () => {
    expect(core.workspaceInfo()).toEqual({ name: "Altimate Demo", tenant: "altimate", linked: true, id: null, signedIn: true })
    delete process.env.ALTIMATE_INTEGRATIONS_MOCK
    try {
      expect(core.workspaceInfo()).toEqual({ name: "not signed in", tenant: "", linked: false, id: null, signedIn: false })
      expect(core.status().workspace.signedIn).toBe(false)
    } finally {
      process.env.ALTIMATE_INTEGRATIONS_MOCK = "1"
    }
  })

  test("not_found without detections", () => {
    expect(core.status().providers.every((p) => p.state === "not_found")).toBe(true)
  })
})

describe("block policy and sync", () => {
  test("blocked providers stay local, unblocked sync", async () => {
    process.env.ALTIMATE_INTEGRATIONS_DEMO = "1"
    await core.recordDetections(core.scan())
    await core.setBlocked(["github"], true)
    expect(core.status().providers[0].sync).toBe("blocked")
    expect((await core.syncProvider("github")).result).toBe("kept_local")
    await core.setBlocked(["github"], false)
    const o = await core.syncProvider("github")
    expect(o.result).toBe("synced")
    expect(o.request?.body.name).toStartWith("GitHub (from ")
    expect(o.request?.privacy).toBe("private")
    const p = core.status().providers[0]
    expect([p.state, p.sync]).toEqual(["connected", "synced"])
    expect((await core.syncProvider("linear")).result).toBe("skipped")
    await core.disconnect("github")
    expect(core.status().providers[0].state).toBe("detected")
  })
})

describe("a block set while a mock sync runs", () => {
  test("stops the sync from being recorded", async () => {
    process.env.ALTIMATE_INTEGRATIONS_DEMO = "1"
    await core.recordDetections(core.scan())
    const o = await core.syncProvider("github", (label, done) => {
      if (done && label === "Enable on workspace") core.saveStore({ ...core.loadStore(), blocked: { github: true } })
    })
    expect([o.result, o.reason]).toEqual(["kept_local", "blocked by policy"])
    expect(core.loadStore().providers.github?.synced).toBeFalsy()
    expect(fs.existsSync(path.join(tmp, "integrations-remote-mock.json"))).toBe(false)
  })
})

const connected = async (id: core.ProviderId, expiresAt: string | null, extra: Partial<core.StoredProvider> = {}, secret: string | null = "tok_" + id) => {
  if (secret) await core.storeSecret(id, secret)
  const store = core.loadStore()
  store.providers[id] = { registered: true, account: "octo", source: { kind: "cli", label: "test" }, synced: false, expiresAt, updatedAt: new Date().toISOString(), ...extra }
  core.saveStore(store)
}

const HOST = os.hostname()

/** A stand-in for the existing connections endpoints (own list, create, update, delete). */
function connectionsStub() {
  const state = {
    rows: [] as any[],
    next: 21,
    valid: true,
    fail: null as null | { status: number; body: unknown },
    listFails: false,
  }
  const seed = (row: Record<string, unknown>) => {
    const full = { id: state.next++, user_id: 1, is_valid: true, is_owner: true, privacy: "private", config: {}, last_validated_at: null, created_at: "2030-01-01T00:00:00Z", ...row }
    state.rows.push(full)
    return full
  }
  const handle = (req: Request, url: URL, body: any): Response | undefined => {
    if (!url.pathname.startsWith("/connections")) return
    if (state.fail && req.method !== "GET") return Response.json(state.fail.body, { status: state.fail.status })
    const id = Number(url.pathname.split("/")[2])
    if (state.listFails && req.method === "GET" && url.pathname === "/connections/") return Response.json({ detail: "unavailable" }, { status: 503 })
    if (req.method === "GET" && url.pathname === "/connections/")
      return Response.json({ connections: state.rows.filter((r) => !r.deleted && (url.searchParams.get("include_shared") === "true" || r.is_owner)) })
    if (req.method === "POST" && url.pathname === "/connections/") {
      if (!body?.name?.trim()) return Response.json({ detail: [{ loc: ["body", "name"], msg: "Name can't be blank", type: "blank_field" }] }, { status: 422 })
      return Response.json(seed({ name: body.name, integration_id: body.integration_id, config: body.config, is_valid: state.valid, last_validated_at: state.valid ? "2030-06-01T00:00:00Z" : null }), { status: 201 })
    }
    const row = state.rows.find((r) => r.id === id && r.is_owner && !r.deleted)
    if (!row) return Response.json({ detail: "Connection not found" }, { status: 404 })
    if (req.method === "PATCH" && url.pathname === `/connections/${id}`) {
      Object.assign(row, { config: body.config, is_valid: state.valid, updated_at: "2030-07-01T00:00:00Z" })
      return Response.json(row)
    }
    if (req.method === "DELETE" && url.pathname === `/connections/${id}`) {
      row.deleted = true
      return Response.json({ ok: true })
    }
  }
  return { state, seed, handle }
}

describe("expiry", () => {
  test("isExpired uses a 60 second skew", () => {
    const now = Date.parse("2030-01-01T00:00:00Z")
    expect(core.isExpired(null, now)).toBe(false)
    expect(core.isExpired("2030-01-01T00:02:00Z", now)).toBe(false)
    expect(core.isExpired("2030-01-01T00:01:00Z", now)).toBe(true)
    expect(core.isExpired("2029-12-31T00:00:00Z", now)).toBe(true)
  })

  test("status reports expired and expiresAt", async () => {
    await connected("github", new Date(Date.now() + 3_600_000).toISOString())
    let p = core.status().providers[0]
    expect([p.state, p.expiresAt === null]).toEqual(["connected", false])
    await core.updateStore((st) => {
      st.providers.github!.expiresAt = new Date(Date.now() - 1000).toISOString()
    })
    p = core.status().providers[0]
    expect(p.state).toBe("expired")
  })

})

describe("keychain", () => {
  const realDir = process.env.ALTIMATE_INTEGRATIONS_DIR
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  const calls: { cmd: string; args: string[]; input?: string }[] = []
  const kills: string[] = []
  let spawn: ReturnType<typeof spyOn> | undefined
  let hold: Promise<void> | undefined
  const on = (status = 0, stdout = "", stderr = "") => {
    hold = undefined
    spawn?.mockRestore()
    delete process.env.ALTIMATE_INTEGRATIONS_DIR
    Object.defineProperty(process, "platform", { value: "darwin" })
    calls.length = 0
    kills.length = 0
    spawn = spyOn(childProcess, "spawn").mockImplementation(((cmd: string, args: string[]) => {
      const child: any = new EventEmitter()
      const chunks: string[] = []
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      child.stdin.on("data", (d: Buffer) => chunks.push(d.toString()))
      child.kill = (signal: string) => kills.push(signal) > 0
      const entry: { cmd: string; args: string[]; input?: string } = { cmd, args }
      calls.push(entry)
      const finish = () => {
        if (chunks.length) entry.input = chunks.join("")
        child.stdout.end(stdout)
        child.stderr.end(stderr)
        child.emit("close", status)
      }
      if (hold) hold.then(() => setTimeout(finish, 0))
      else setTimeout(finish, 0)
      return child
    }) as any)
  }
  afterEach(() => {
    spawn?.mockRestore()
    spawn = undefined
    hold = undefined
    process.env.ALTIMATE_INTEGRATIONS_DIR = realDir
    Object.defineProperty(process, "platform", platform)
  })

  test("a secret goes to security on stdin, quoted, and never in argv", async () => {
    on()
    await core.storeSecret("cred:github:github_token", 'a"b\\c')
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe("security")
    expect(calls[0].args).toEqual(["-i"])
    expect(calls[0].input).toBe('add-generic-password -U -s "altimate-code-integrations" -a "cred:github:github_token" -w "a\\"b\\\\c"\n')
  })

  test("read and delete use the keychain by account", async () => {
    on(0, "stored-value\n")
    expect(await core.readSecret("cred:github:github_token")).toBe("stored-value")
    await core.deleteSecret("cred:github:github_token")
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["security", "find-generic-password", "-s", "altimate-code-integrations", "-a", "cred:github:github_token", "-w"],
      ["security", "delete-generic-password", "-s", "altimate-code-integrations", "-a", "cred:github:github_token"],
    ])
  })

  test("a slow keychain call does not block the event loop", async () => {
    on(0, "v\n")
    let release!: () => void
    hold = new Promise<void>((r) => (release = r))
    let ticked = false
    const read = core.readSecret("cred:github:github_token")
    const store = core.storeSecret("cred:github:github_token", "x")
    await new Promise<void>((r) =>
      setTimeout(() => {
        ticked = true
        r()
      }, 20),
    )
    expect(ticked).toBe(true)
    expect(calls).toHaveLength(2)
    release()
    expect(await read).toBe("v")
    await store
  })

  test("a failed keychain delete is an error unless the item was already absent", async () => {
    const del = () => core.deleteSecret("cred:github:github_token")
    on(0)
    await del()
    on(44)
    await del()
    on(1)
    await expect(del()).rejects.toThrow("macOS keychain")
    on(51)
    await expect(del()).rejects.toThrow("exit 51")
  })

  test("a disconnect the keychain refuses keeps the record, so it can be retried", async () => {
    // The data dir falls back to the suite's temporary XDG location here, never the real one.
    on(1)
    await core.updateStore((s) => {
      s.providers.github = { registered: true, synced: false, account: "me", variant: "token", values: {}, secretFields: ["github_token"], updatedAt: null } as any
    })
    await expect(core.disconnect("github")).rejects.toThrow("macOS keychain")
    expect(core.loadStore().providers.github?.registered).toBe(true)
    await core.updateStore((s) => {
      delete s.providers.github
    })
  })

  test("a keychain read is empty only when the item is missing; any other failure is an error", async () => {
    const read = () => core.readSecret("cred:github:github_token")
    on(44)
    expect(await read()).toBeUndefined()
    on(36)
    await expect(read()).rejects.toThrow("Could not read a stored credential from the macOS keychain (exit 36)")
    expect(calls.map((c) => c.args[0])).toEqual(["find-generic-password"])
    // A missing keychain prints "could not be found" too, but it is not a missing item.
    on(50, "", "security: SecKeychainSearchCopyNext: The specified keychain could not be found.")
    await expect(read()).rejects.toThrow("exit 50")
    on(50, "", "The specified keychain could not be found.")
    await expect(core.deleteSecret("cred:github:github_token")).rejects.toThrow("exit 50")
  })

  test("a keychain call that never answers is killed and reported, for reads and writes", async () => {
    const limit = core.keychainLimits.timeoutMs
    core.keychainLimits.timeoutMs = 20
    try {
      on(0, "never")
      hold = new Promise<void>(() => {})
      await expect(core.readSecret("cred:github:github_token")).rejects.toThrow("timed out")
      await expect(core.storeSecret("cred:github:github_token", "x")).rejects.toThrow("Could not save the credential to the macOS keychain")
      expect(calls).toHaveLength(2)
      expect(kills).toEqual(["SIGKILL", "SIGKILL"])
    } finally {
      core.keychainLimits.timeoutMs = limit
    }
  })

  test("a failed keychain write is an error", async () => {
    on(1)
    await expect(core.storeSecret("cred:github:github_token", "x")).rejects.toThrow("macOS keychain")
  })

  test("an account id outside the allowed characters is refused before security runs", async () => {
    on()
    for (const id of ["a\nadd-generic-password -a x", 'a"b', "a b", ""]) await expect(core.storeSecret(id, "x")).rejects.toThrow("not valid")
    expect(calls).toEqual([])
  })
})

describe("state file", () => {
  test("is written for the owner only", () => {
    core.saveStore({ blocked: {}, providers: {} })
    expect(fs.statSync(path.join(tmp, "integrations.json")).mode & 0o777).toBe(0o600)
  })
})

describe("state files that are not objects", () => {
  test("an array, null or scalar root is an error and is left as it was", async () => {
    const file = path.join(tmp, "integrations-secrets.json")
    for (const text of ["[]", "null", "3", '"x"']) {
      fs.writeFileSync(file, text)
      await expect(core.storeSecret("cred:github:github_token", "x")).rejects.toThrow("expected a JSON object")
      expect(fs.readFileSync(file, "utf8")).toBe(text)
    }
    fs.rmSync(file)
  })
})

describe("secret storage", () => {
  test("a value with a line break is refused as not a token", async () => {
    await expect(core.storeSecret("github", "abc\ndef")).rejects.toThrow("not a token")
    expect(await core.readSecret("github")).toBeUndefined()
  })
})

describe("workspace connections", () => {
  const calls: { method: string; path: string; query: string; auth: string | null; tenant: string | null; body: any }[] = []
  const api = connectionsStub()
  let server: ReturnType<typeof Bun.serve>
  const saved = { ...process.env }
  let githubApiBefore: string | undefined

  beforeEach(async () => {
    calls.length = 0
    api.state.rows.length = 0
    api.state.next = 21
    api.state.valid = true
    api.state.fail = null
    api.state.listFails = false
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const body = req.method === "POST" || req.method === "PATCH" ? await req.json().catch(() => null) : null
        if (url.pathname === "/user") {
          const auth = req.headers.get("authorization")
          if (auth === "Bearer gh_bad") return Response.json({ message: "Bad credentials" }, { status: 401 })
          // A token without an expiry is answered without the expiration header.
          if (auth === "Bearer gh_no_expiry") return Response.json({ login: "octo" })
          return Response.json({ login: "octo" }, { headers: { "github-authentication-token-expiration": "2031-01-02 03:04:05 UTC" } })
        }
        calls.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.get("authorization"), tenant: req.headers.get("x-tenant"), body })
        return api.handle(req, url, body) ?? new Response("no", { status: 404 })
      },
    })
    delete process.env.ALTIMATE_INTEGRATIONS_MOCK
    process.env.ALTIMATE_INTEGRATIONS_API_URL = `http://127.0.0.1:${server.port}`
    process.env.ALTIMATE_INTEGRATIONS_TOKEN = "bearer-1"
    process.env.ALTIMATE_INTEGRATIONS_TENANT = "acme"
    process.env.ALTIMATE_INTEGRATIONS_HOME = fs.mkdtempSync(path.join(tmp, "empty-"))
    process.env.GITHUB_TOKEN = "gh_env_token"
    githubApiBefore = process.env.ALTIMATE_INTEGRATIONS_GITHUB_API
    process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = `http://127.0.0.1:${server.port}`
    spyOn(workspaceState, "resolveBindingOutcome").mockResolvedValue({ status: "unbound" })
    await core.recordDetections([{ id: "github", source: { kind: "env", label: "GITHUB_TOKEN" }, account: null, syncable: true, note: null }])
  })
  afterEach(() => {
    ;(workspaceState.resolveBindingOutcome as any).mockRestore?.()
    server.stop(true)
    process.env.ALTIMATE_INTEGRATIONS_MOCK = "1"
    for (const k of ["ALTIMATE_INTEGRATIONS_API_URL", "ALTIMATE_INTEGRATIONS_TOKEN", "ALTIMATE_INTEGRATIONS_TENANT", "ALTIMATE_INTEGRATIONS_HOME"]) delete process.env[k]
    if (githubApiBefore === undefined) delete process.env.ALTIMATE_INTEGRATIONS_GITHUB_API
    else process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = githubApiBefore
    if (saved.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN
  })
  const writes = () => calls.filter((c) => c.method !== "GET")

  test("sync of a replaced detected token does not carry over the old token's expiry", async () => {
    expect((await core.syncProvider("github")).result).toBe("synced")
    expect(core.loadStore().providers.github?.expiresAt).toBe("2031-01-02T03:04:05.000Z")
    process.env.GITHUB_TOKEN = "gh_no_expiry"
    expect((await core.syncProvider("github")).result).toBe("synced")
    expect(writes()[1].body).toEqual({ config: { github_token: "gh_no_expiry" } })
  })

  test("sync does not upload into a connection that is already shared without --share", async () => {
    expect((await core.syncProvider("github")).shared).toBeUndefined()
    api.state.rows[0].privacy = "public"
    process.env.GITHUB_TOKEN = "gh_no_expiry"
    const refused = await core.syncProvider("github")
    expect([refused.result, refused.reason, refused.shared]).toEqual(["failed", core.SHARED_CONNECTION_REFUSAL("github"), undefined])
    expect(writes()).toHaveLength(1)
    const shared = await core.syncProvider("github", undefined, 0, false, true)
    expect([shared.result, shared.shared, shared.steps.map((x) => x.label)]).toEqual(["synced", true, [`Updated connection${core.SHARED_CONNECTION_AUDIENCE}`, core.NOT_LINKED_LABEL]])
    expect(writes()).toHaveLength(2)
    // A rewrite the workspace marks invalid, or whose record cannot be written, still says it is shared.
    api.state.valid = false
    const invalid = await core.syncProvider("github", undefined, 0, false, true)
    expect([invalid.result, invalid.shared]).toEqual(["failed", true])
    expect(invalid.reason).toContain(core.SHARED_REWRITE_NOTE)
    api.state.valid = true
    const rename = fs.renameSync
    const disk = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
      if (String(to).endsWith("integrations.json")) throw new Error("disk full")
      return rename(from, to)
    }) as any)
    try {
      const unrecorded = await core.syncProvider("github", undefined, 0, false, true)
      expect([unrecorded.result, unrecorded.shared]).toEqual(["failed", true])
    } finally {
      disk.mockRestore()
    }
    // An attach that fails after the shared connection was rewritten still says it is shared.
    ;(workspaceState.resolveBindingOutcome as any).mockResolvedValue({ status: "unknown" })
    spyOn(AltimateApi, "isConfigured").mockResolvedValue(true)
    try {
      const failed = await core.syncProvider("github", undefined, 0, false, true)
      expect([failed.result, failed.shared]).toEqual(["failed", true])
      expect(failed.reason).toContain(core.SHARED_REWRITE_NOTE)
    } finally {
      ;(AltimateApi.isConfigured as any).mockRestore()
    }
  })

  test("sync creates the managed connection, then updates it in place", async () => {
    const first = await core.syncProvider("github")
    expect(first.result).toBe("synced")
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({ method: "POST", path: "/connections/", auth: "Bearer bearer-1", tenant: "acme" })
    expect(writes()[0].body).toEqual({ name: `GitHub (from ${HOST})`, integration_id: "github", config: { github_token: "gh_env_token", expires_at: "2031-01-02T03:04:05.000Z" } })
    expect(calls.find((c) => c.path.startsWith("/connections"))).toMatchObject({ method: "GET", path: "/connections/", query: "?include_shared=true" })
    expect(calls.filter((c) => c.method === "GET" && c.path === "/connections/")).toHaveLength(1)
    expect(core.loadStore().providers.github).toMatchObject({ registered: true, synced: true, connectionId: 21 })

    process.env.GITHUB_TOKEN = "gh_env_token_2"
    const second = await core.syncProvider("github")
    expect(second.result).toBe("synced")
    expect(second.steps).toEqual([{ label: "Updated connection", ok: true }, { label: "Not linked to a workspace: run altimate link", ok: false }])
    expect(writes()[1]).toMatchObject({ method: "PATCH", path: "/connections/21", auth: "Bearer bearer-1", tenant: "acme" })
    expect(writes()[1].body).toEqual({ config: { github_token: "gh_env_token_2", expires_at: "2031-01-02T03:04:05.000Z" } })
    expect(api.state.rows).toHaveLength(1)
  })

  test("a new connection the workspace marks invalid is removed again and nothing is stored", async () => {
    api.state.valid = false
    const o = await core.syncProvider("github")
    expect(o.result).toBe("failed")
    expect(o.reason).toContain("refused")
    expect(api.state.rows.filter((r) => !r.deleted)).toHaveLength(0)
    expect(core.loadStore().providers.github?.registered).toBeUndefined()
    api.state.valid = true
    expect((await core.syncProvider("github")).result).toBe("synced")
    expect(writes().map((c) => c.method)).toEqual(["POST", "DELETE", "POST"])
    expect(core.status().providers[0].state).toBe("connected")
  })

  test("backend errors keep the message (code) format", async () => {
    api.state.fail = { status: 422, body: { detail: [{ loc: ["body", "config", "jiraEmail"], msg: "Email is not a valid email address", type: "value_error.format" }] } }
    const o = await core.syncProvider("github")
    expect([o.result, o.reason]).toEqual(["failed", "Email is not a valid email address (value_error.format)"])
    api.state.fail = { status: 400, body: { detail: "Fill in the required connection fields: Api Key" } }
    expect((await core.syncProvider("github")).reason).toBe("Fill in the required connection fields: Api Key")
    api.state.fail = { status: 409, body: { detail: "Reload this connection before saving: the stored github_token has changed" } }
    expect((await core.syncProvider("github")).reason).toContain("Reload this connection")
    expect(core.status().providers[0].state).not.toBe("connected")
  })

  test("status prefers the managed connection, else the latest validated own one, and skips shared ones", async () => {
    api.seed({ name: "Old", integration_id: "jira", last_validated_at: "2030-01-01T00:00:00Z" })
    api.seed({ name: "Hand made", integration_id: "jira", last_validated_at: "2030-05-01T00:00:00Z" })
    api.seed({ name: "Teammate", integration_id: "linear", is_owner: false })
    api.seed({ name: `GitHub (from ${HOST})`, integration_id: "github", is_valid: false })
    api.seed({ name: "GitHub (from elsewhere)", integration_id: "github", last_validated_at: "2031-01-01T00:00:00Z" })
    const derived = core.deriveRemote(await backend.listOwnConnections((await backend.backendConfig())!))
    expect(derived.map((d) => [d.integration_id, d.name, d.managed, d.managedId])).toEqual([
      ["github", "GitHub (from elsewhere)", false, 24],
      ["jira", "Hand made", false, null],
    ])
    const s = await core.statusRemote()
    expect(Object.keys(s.providers[0])).toEqual(["id", "name", "state", "source", "account", "syncable", "sync", "updatedAt", "expiresAt", "note"])
    expect(Object.keys(s.providers[1])).toContain("managed")
    expect(s.providers.map((p) => [p.id, p.state, p.sync, p.source?.label ?? null])).toEqual([
      ["github", "connected", "synced", "Altimate workspace"],
      ["jira", "connected", "synced", "Altimate workspace"],
      ["linear", "not_found", "local", null],
    ])
  })

  test("a newer hand-made connection stays what is shown while the deleted-elsewhere check follows the managed one", async () => {
    await core.syncProvider("github")
    api.seed({ name: "GitHub (from elsewhere)", integration_id: "github", last_validated_at: "2031-01-01T00:00:00Z" })
    expect((await core.statusRemote()).providers[0]).toMatchObject({ state: "connected", sync: "synced" })
    api.state.rows.find((r) => r.name === `GitHub (from ${HOST})`)!.is_valid = false
    const shown = (await core.statusRemote()).providers[0]
    expect([shown.state, shown.managed]).toEqual(["rejected", undefined])
    api.state.rows.find((r) => r.name === `GitHub (from ${HOST})`)!.deleted = true
    const gone = (await core.statusRemote()).providers[0]
    expect([gone.state, gone.sync, gone.managed]).toEqual(["connected", "synced", false])
    api.state.rows.find((r) => r.name === "GitHub (from elsewhere)")!.deleted = true
    const none = (await core.statusRemote()).providers[0]
    // gh still holds the token here, so it is offered again rather than shown as missing.
    expect([none.state, none.sync]).toEqual(["detected", "local"])
  })

  test("a synced credential deleted in the workspace is offered again when it is still found here", () => {
    const now = Date.parse("2026-11-03T00:00:00Z")
    const detection = { id: "github" as const, source: { kind: "cli" as const, label: "gh CLI" }, account: "me", syncable: true, note: null }
    const store = { blocked: {}, providers: { github: { detection, registered: true, synced: true, connectionId: 9, account: "me", variant: "token", values: {}, secretFields: ["github_token"], updatedAt: null, validatedAt: null } } } as any
    const local = core.buildStatus(store, [], now)
    const found = core.mergeRemote(local, [], now, [detection]).providers.find((p) => p.id === "github")!
    expect([found.state, found.sync, found.source?.label, found.account]).toEqual(["detected", "local", "gh CLI", "me"])
    const gone = core.mergeRemote(local, [], now).providers.find((p) => p.id === "github")!
    expect([gone.state, gone.note]).toEqual(["not_found", "The workspace connection was removed. Add the credentials again."])
  })

  test("a synced record reports the managed connection's validity, whichever connection is shown", () => {
    const now = Date.parse("2030-01-01T00:00:00Z")
    const mine = { id: 3, user_id: 1, name: `Linear (from ${HOST})`, integration_id: "linear", is_valid: false, last_validated_at: "2029-01-01T00:00:00Z" } as any
    const hand = { id: 4, user_id: 1, name: "Linear", integration_id: "linear", is_valid: true, last_validated_at: "2029-06-01T00:00:00Z" } as any
    const remote = core.deriveRemote([mine, hand])
    expect([remote[0].connection_id, remote[0].managedId]).toEqual([4, 3])
    const rec = { registered: true, synced: true, account: "me", source: { kind: "cli", label: "test" }, updatedAt: new Date(now).toISOString() } as core.StoredProvider
    const store = { blocked: {}, providers: { linear: rec } } as core.Store
    const state = (rows: any[]) => core.mergeRemote(core.buildStatus(store, [], now), core.deriveRemote(rows), now).providers.find((p) => p.id === "linear")!.state
    expect(state([mine, hand])).toBe("rejected")
    expect(state([{ ...mine, is_valid: true }, { ...hand, is_valid: false }])).toBe("connected")
  })

  test("a synced record's expiry comes from the managed connection, not the one shown", () => {
    const now = Date.parse("2030-01-01T00:00:00Z")
    const mine = { id: 3, user_id: 1, name: `Linear (from ${HOST})`, integration_id: "linear", is_valid: true, last_validated_at: "2029-01-01T00:00:00Z", config: { expires_at: "2029-12-31T00:00:00Z" } } as any
    const hand = { id: 4, user_id: 1, name: "Linear", integration_id: "linear", is_valid: true, last_validated_at: "2029-06-01T00:00:00Z", config: { expires_at: "2031-01-01T00:00:00Z" } } as any
    const rec = { registered: true, synced: true, account: "me", source: { kind: "cli", label: "test" }, updatedAt: new Date(now).toISOString() } as core.StoredProvider
    const store = { blocked: {}, providers: { linear: rec } } as core.Store
    const p = core.mergeRemote(core.buildStatus(store, [], now), core.deriveRemote([mine, hand]), now).providers.find((x) => x.id === "linear")!
    expect([p.state, p.expiresAt]).toEqual(["expired", "2029-12-31T00:00:00Z"])
  })

  test("sync <provider> --keep-synced takes the attach-only path that sync --all takes", async () => {
    expect(skipsSynced({ provider: undefined, all: true })).toBe(true)
    expect(skipsSynced({ provider: "github" })).toBe(false)
    expect(skipsSynced({ provider: "github", keepSynced: true })).toBe(true)
    await core.syncProvider("github")
    const before = writes().length
    process.env.GITHUB_TOKEN = "gh_env_token_other"
    const kept = await core.syncProvider("github", undefined, 0, skipsSynced({ provider: "github", keepSynced: true }))
    expect(kept.steps[0]).toEqual({ label: "Connection already in the workspace", ok: true })
    expect(writes()).toHaveLength(before)
    await core.setBlocked(["github"], true)
    expect((await core.syncProvider("github", undefined, 0, true)).result).toBe("kept_local")
  })

  test("a saved credential whose config cannot be collected fails that provider's sync with the reason, instead of stopping the run", async () => {
    await connected("github", null, { variant: "token", values: {}, secretFields: ["github_token"] })
    const unreadable = "Could not read a stored credential from the macOS keychain (exit 36). Unlock the keychain and try again."
    const catalog = spyOn(creds, "loadCatalog").mockRejectedValue(new Error(unreadable))
    try {
      const o = await core.syncProvider("github")
      expect([o.result, o.reason]).toEqual(["failed", unreadable])
      expect(writes()).toEqual([])
    } finally {
      catalog.mockRestore()
    }
  })

  test("sync to a shared workspace attaches nothing without --share and reports why; with it the outcome is marked shared", async () => {
    await core.syncProvider("github")
    const spies = [
      spyOn(workspaceState, "resolveBindingOutcome").mockResolvedValue({ status: "bound", binding: { datamateId: 5, datamateName: "WS" } } as any),
      spyOn(backend, "getDatamate").mockResolvedValue({ id: "5", name: "WS", is_owner: true, privacy: "public", integrations: [{ id: "github", tools: [], connection_id: null }] } as any),
    ]
    const update = spyOn(backend, "updateDatamateIntegrations").mockResolvedValue(undefined as any)
    try {
      const refused = await core.syncProvider("github", undefined, 0, true)
      expect([refused.result, refused.reason]).toEqual(["failed", core.ATTACH_FAILED_PREFIX + core.SHARED_WORKSPACE_REFUSAL("WS", "github")])
      expect(update).not.toHaveBeenCalled()
      const shared = await core.syncProvider("github", undefined, 0, true, true)
      expect([shared.result, shared.shared]).toEqual(["synced", true])
      expect([syncedTo(shared), syncedTo(refused)]).toEqual(["synced to workspace, shared with other people", "synced to workspace (private)"])
      expect(update).toHaveBeenCalledTimes(1)
    } finally {
      for (const sp of [...spies, update]) sp.mockRestore()
    }
  })

  test("attach-only runs under the lock and names the kept workspace inert, with its id", async () => {
    await core.syncProvider("github")
    const events: string[] = []
    const spies = [
      spyOn(workspaceState, "resolveBindingOutcome").mockResolvedValue({ status: "bound", binding: { datamateId: 5, datamateName: "WS\nx" } } as any),
      spyOn(backend, "getDatamate").mockResolvedValue({ id: "5", name: "WS", is_owner: true, privacy: "private", integrations: [{ id: "github", tools: [], connection_id: "999" }] } as any),
      spyOn(backend, "updateDatamateIntegrations").mockImplementation((async () => void events.push("patch")) as any),
    ]
    api.seed({ name: "Teammate's", integration_id: "github", is_owner: false })
    api.state.rows[api.state.rows.length - 1].id = 999
    let release = () => {}
    let acquired!: () => void
    const ready = new Promise<void>((resolve) => (acquired = resolve))
    const holder = core.withLock(() => {
      acquired()
      return new Promise<void>((r) => (release = r))
    })
    await ready
    try {
      const pending = core.syncProvider("github", undefined, 0, true)
      await Bun.sleep(400)
      expect(events).toEqual([])
      release()
      await holder
      const out = await pending
      expect(events).toEqual(["patch"])
      const kept = out.steps.find((st) => st.label.startsWith("Kept"))!.label
      expect(kept).toContain("(id 5)")
      expect(kept).not.toContain("\n")
    } finally {
      release()
      for (const sp of spies) sp.mockRestore()
    }
  })

  test("sync over every provider leaves a saved connection alone and only attaches it", async () => {
    await core.syncProvider("github")
    const before = writes().length
    process.env.GITHUB_TOKEN = "gh_env_token_other"
    const all = await core.syncProvider("github", undefined, 0, true)
    expect(all.result).toBe("synced")
    expect(all.steps[0]).toEqual({ label: "Connection already in the workspace", ok: true })
    expect(writes()).toHaveLength(before)
    expect((await core.syncProvider("github")).steps[0].label).toBe("Updated connection")
    expect(writes()).toHaveLength(before + 1)
  })

  test("block still sets the policy when the workspace cannot be read, and says it was not checked", async () => {
    api.state.listFails = true
    expect(await core.blockProviders(["github"])).toEqual({ blocked: ["github"], refused: [], unchecked: ["github"] })
    expect(core.isBlocked("github")).toBe(true)
  })

  test("block refuses a provider whose managed connection is in the workspace", async () => {
    api.seed({ name: `Linear (from ${HOST})`, integration_id: "linear" })
    expect(await core.blockProviders(["linear", "github"])).toEqual({ blocked: ["github"], refused: ["linear"], unchecked: [] })
    expect(core.isBlocked("linear")).toBe(false)
  })

  test("disconnect waits for a running upload instead of interleaving with it", async () => {
    await core.syncProvider("github")
    let release = () => {}
    let acquired!: () => void
    const ready = new Promise<void>((resolve) => (acquired = resolve))
    const holder = core.withLock(() => {
      acquired()
      return new Promise<void>((r) => (release = r))
    })
    await ready
    const pending = core.disconnect("github")
    await Bun.sleep(400)
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([])
    release()
    await holder
    expect((await pending).removedRemote).toBe(1)
    expect(core.isSynced("github")).toBe(false)
  })

  test("sync only uploads a detected or registered credential, never a typed-in draft", async () => {
    await core.storeSecret(core.secretKey("draft", "github", "github_token"), "draft_never_validated")
    const o = await core.syncProvider("github")
    expect(o.result).toBe("synced")
    expect(writes()[0].body.config).toEqual({ github_token: "gh_env_token", expires_at: "2031-01-02T03:04:05.000Z" })
  })

  test("sync moves a local credential to the workspace and leaves no secret here", async () => {
    await core.storeSecret(core.secretKey("cred", "github", "github_token"), "gh_local_tok")
    await core.storeSecret("github", "gh_local_tok")
    const store = core.loadStore()
    store.providers.github = { registered: true, synced: false, variant: "token", secretFields: ["github_token"], values: {} }
    core.saveStore(store)
    expect((await core.syncProvider("github")).result).toBe("synced")
    expect(writes()[0].body.config).toEqual({ github_token: "gh_local_tok", expires_at: "2031-01-02T03:04:05.000Z" })
    expect(await core.readSecret(core.secretKey("cred", "github", "github_token"))).toBeUndefined()
    expect(await core.readSecret("github")).toBeUndefined()
    expect(await core.readSecret("github")).toBeUndefined()
  })

  test("a sync that lost the race to Keep local uploads nothing", async () => {
    await core.setBlocked(["github"], true)
    const o = await core.syncProvider("github")
    expect(o.result).toBe("kept_local")
    expect(writes()).toEqual([])
  })

  test("a block that lands while an attach-only sync waits for the lock keeps the credential local and says why", async () => {
    await core.syncProvider("github")
    let acquired!: () => void
    const ready = new Promise<void>((resolve) => (acquired = resolve))
    const holder = core.withLock(async () => {
      acquired()
      await Bun.sleep(300)
      await core.setBlocked(["github"], true)
    })
    await ready
    const o = await core.syncProvider("github", undefined, 0, true)
    await holder
    expect([o.result, o.reason]).toEqual(["kept_local", "blocked by policy"])
  })

  test("a refusal of a record that was replaced while the provider was being asked does not mark the new record rejected", async () => {
    const keep = async () => {
      await core.storeSecret(core.secretKey("cred", "github", "github_token"), "old_token_value")
      await core.updateStore((st) => {
        st.providers.github = { registered: true, synced: false, account: "me", variant: "token", values: {}, secretFields: ["github_token"], validatedAt: "2030-01-01T00:00:00Z" }
      })
    }
    const refused = { ok: false, rejected: true, unavailable: false, account: null, expiresAt: null, message: "GitHub rejected the token (401)" }
    await keep()
    const replaced = spyOn(creds, "validate").mockImplementation(async () => {
      await core.updateStore((st) => {
        st.providers.github = { ...st.providers.github!, validatedAt: "2030-02-02T00:00:00Z" }
      })
      return refused
    })
    try {
      expect((await core.syncProvider("github")).result).toBe("failed")
      expect(core.loadStore().providers.github?.rejected).toBeFalsy()
      replaced.mockImplementation(async () => refused)
      expect((await core.syncProvider("github")).result).toBe("failed")
      expect(core.loadStore().providers.github?.rejected).toBe(true)
    } finally {
      replaced.mockRestore()
    }
  })

  test("a link that cannot be looked up is reported, not read as not linked; without a login there is nothing to look up", async () => {
    const outcome = workspaceState.resolveBindingOutcome as any
    outcome.mockResolvedValue({ status: "unknown" })
    const login = spyOn(AltimateApi, "isConfigured").mockResolvedValue(true)
    try {
      const o = await core.syncProvider("github")
      expect([o.result, o.reason]).toEqual(["failed", expect.stringContaining(core.ATTACH_FAILED_PREFIX)])
      expect(o.reason).toContain("could not tell whether this directory is linked")
      await core.disconnect("github")
      login.mockResolvedValue(false)
      const bare = await core.syncProvider("github")
      expect([bare.result, bare.steps.at(-1)?.label]).toEqual(["synced", core.NOT_LINKED_LABEL])
    } finally {
      login.mockRestore()
    }
  })

  test("a local cleanup that fails after the workspace accepted the connection is reported on a synced result", async () => {
    await core.storeSecret("github", "leftover_token")
    const rename = fs.renameSync
    const spy = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
      if (String(to).endsWith("integrations-secrets.json")) throw new Error("disk full")
      return rename(from, to)
    }) as any)
    try {
      const o = await core.syncProvider("github")
      expect(o.result).toBe("synced")
      expect(o.steps.find((st) => !st.ok)?.label).toContain("local copy could not be removed: disk full")
    } finally {
      spy.mockRestore()
    }
    expect(core.isSynced("github")).toBe(true)
  })

  test("a record that cannot be written after the workspace accepted the upload is reported, and a retry updates the same connection", async () => {
    await core.storeSecret("github", "leftover_token")
    const rename = fs.renameSync
    const spy = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
      if (String(to).endsWith("integrations.json")) throw new Error("disk full")
      return rename(from, to)
    }) as any)
    let first: core.SyncOutcome
    try {
      first = await core.syncProvider("github")
    } finally {
      spy.mockRestore()
    }
    expect(first.result).toBe("failed")
    expect(first.reason).toContain("Saved to your workspace, but the record on this machine could not be written (disk full)")
    expect(core.isSynced("github")).toBe(false)
    const again = await core.syncProvider("github")
    expect(again.result).toBe("synced")
    expect(again.steps[0]?.label).toBe("Updated connection")
  })

  test("disconnect says when the connection could not be detached from the linked workspace", async () => {
    api.seed({ name: `Linear (from ${HOST})`, integration_id: "linear" })
    const spy = spyOn(workspaceState, "resolveBindingOutcome").mockResolvedValue({ status: "bound", binding: { datamateId: 5, datamateName: "WS" } } as any)
    try {
      const r = await core.disconnect("linear")
      expect([r.removedRemote, r.detached, typeof r.detachMessage]).toEqual([1, false, "string"])
      expect(api.state.rows.filter((x) => !x.deleted)).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  test("disconnect warns when it cannot tell whether the directory is linked, and not when it is unlinked", async () => {
    const spy = spyOn(workspaceState, "resolveBindingOutcome")
    try {
      api.seed({ name: `Linear (from ${HOST})`, integration_id: "linear" })
      spy.mockResolvedValue({ status: "unknown" })
      const unknown = await core.disconnect("linear")
      expect([unknown.removedRemote, unknown.detached, unknown.detachMessage]).toEqual([1, false, expect.stringContaining("could not tell")])
      api.seed({ name: `Linear (from ${HOST})`, integration_id: "linear" })
      spy.mockResolvedValue({ status: "unbound" })
      const unbound = await core.disconnect("linear")
      expect([unbound.removedRemote, unbound.detached]).toEqual([1, true])
    } finally {
      spy.mockRestore()
    }
  })

  test("a synced record marked rejected locally is connected once the workspace shows the connection valid", async () => {
    await core.syncProvider("github")
    await core.updateStore((st) => {
      st.providers.github!.rejected = true
    })
    const row = api.state.rows.find((r) => r.name === `GitHub (from ${HOST})`)!
    row.is_valid = false
    expect((await core.statusRemote()).providers[0].state).toBe("rejected")
    row.is_valid = true
    expect((await core.statusRemote()).providers[0]).toMatchObject({ state: "connected", sync: "synced", note: null })
  })

  test("sync over every provider leaves a workspace connection alone when this machine has no record of it", async () => {
    api.seed({ name: `GitHub (from ${HOST})`, integration_id: "github", config: { github_token: "from_web" } })
    const all = await core.syncProvider("github", undefined, 0, true)
    expect(all.result).toBe("synced")
    expect(all.steps[0]).toEqual({ label: "Connection already in the workspace", ok: true })
    expect(writes()).toEqual([])
    expect(core.loadStore().providers.github?.registered).toBeFalsy()
  })

  test("sync over every provider does not attach a workspace connection the workspace marks invalid", async () => {
    api.seed({ name: `GitHub (from ${HOST})`, integration_id: "github", is_valid: false })
    const all = await core.syncProvider("github", undefined, 0, true)
    expect(all.result).toBe("skipped")
    expect(all.reason).toBe("the workspace connection is marked invalid; run update")
    expect(writes()).toEqual([])
  })

  test("sync over every provider attaches a workspace connection when nothing for the provider is detected here", async () => {
    api.seed({ name: `Linear (from ${HOST})`, integration_id: "linear" })
    const all = await core.syncProvider("linear", undefined, 0, true)
    expect([all.result, all.steps[0]]).toEqual(["synced", { label: "Connection already in the workspace", ok: true }])
    expect(writes()).toEqual([])
    expect((await core.syncProvider("jira", undefined, 0, true)).result).toBe("skipped")
    expect(writes()).toEqual([])
  })

  test("the status of a synced record takes the workspace connection's expiry on the real path", async () => {
    const row = api.seed({ name: `Linear (from ${HOST})`, integration_id: "linear", config: { expires_at: "2031-01-01T00:00:00Z" } })
    await connected("linear", "2029-12-31T00:00:00Z", { account: "me", synced: true })
    await core.updateStore((st) => {
      st.providers.linear!.connectionId = row.id
    })
    const linear = (await core.statusRemote()).providers.find((p) => p.id === "linear")!
    expect([linear.state, linear.expiresAt]).toEqual(["connected", "2031-01-01T00:00:00Z"])
  })

  test("a synced record fixed in the workspace is attached by a run over every provider", async () => {
    const row = api.seed({ name: `GitHub (from ${HOST})`, integration_id: "github" })
    const store = core.loadStore()
    store.providers.github = { registered: true, synced: true, rejected: true, connectionId: row.id, variant: "default", secretFields: ["github_token"], values: {} } as any
    core.saveStore(store)
    const all = await core.syncProvider("github", undefined, 0, true)
    expect(all.result).toBe("synced")
  })

  test("a synced record takes its expiry from the workspace over an older local one", () => {
    const now = Date.parse("2030-01-01T00:00:00Z")
    const remote: core.RemoteProvider[] = [{ integration_id: "linear", connection_id: 3, name: "Linear", account: null, managed: true, source: null, expires_at: "2031-01-01T00:00:00Z", expired: false, is_valid: true }]
    return connected("linear", "2029-12-31T00:00:00Z", { account: "me", synced: true }).then(() => {
      const merged = core.mergeRemote(core.buildStatus(core.loadStore(), [], now), remote, now).providers.find((p) => p.id === "linear")!
      expect([merged.state, merged.expiresAt]).toEqual(["connected", "2031-01-01T00:00:00Z"])
      const gone = core.mergeRemote(core.buildStatus(core.loadStore(), [], Date.parse("2029-06-01T00:00:00Z")), [{ ...remote[0], expires_at: "2029-07-01T00:00:00Z" }], now).providers.find((p) => p.id === "linear")!
      expect([gone.state, gone.expiresAt]).toEqual(["expired", "2029-07-01T00:00:00Z"])
    })
  })

  test("a sync prepared before a same-variant local update uploads nothing", async () => {
    await connected("github", null, { account: "me", variant: "token", secretFields: ["github_token"], values: {} })
    await core.storeSecret(core.secretKey("cred", "github", "github_token"), "gh_local_tok")
    const original = creds.validate
    const spy = spyOn(creds, "validate").mockImplementation(async (...args: Parameters<typeof original>) => {
      const checked = await original(...args)
      await core.updateStore((st) => {
        st.providers.github = { ...st.providers.github, validatedAt: "2031-01-01T00:00:00Z" }
      })
      return checked
    })
    try {
      const out = await core.syncProvider("github")
      expect(out.result).toBe("failed")
      expect(writes()).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  test("a sync prepared before the record changed uploads nothing", async () => {
    const original = creds.detectedConfig
    const spy = spyOn(creds, "detectedConfig").mockImplementation(async (id: any) => {
      const prepared = await original(id)
      await core.updateStore((st) => {
        st.providers.github = { ...st.providers.github, registered: true, synced: true, connectionId: 99 }
      })
      return prepared
    })
    try {
      const out = await core.syncProvider("github")
      expect(out.result).toBe("failed")
      expect(writes()).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  test("sync records the provider check: validatedAt and account on success, rejected for a refused stored credential", async () => {
    const ok = await core.syncProvider("github")
    expect(ok.result).toBe("synced")
    const rec = core.loadStore().providers.github!
    expect([rec.account, typeof rec.validatedAt, rec.rejected]).toEqual(["octo", "string", false])

    await connected("github", null, { account: "me", variant: "token", secretFields: ["github_token"], values: {} }, null)
    await core.storeSecret(core.secretKey("cred", "github", "github_token"), "gh_bad")
    const before = writes().length
    const refused = await core.syncProvider("github")
    expect(refused.result).toBe("failed")
    expect(writes().length).toBe(before)
    const after = core.loadStore().providers.github!
    expect([after.rejected, typeof after.validatedAt, after.registered, after.synced]).toEqual([true, "string", true, false])
  })

  test("sync uploads nothing when the provider rejects the detected credential, or cannot be reached", async () => {
    process.env.GITHUB_TOKEN = "gh_bad"
    const refused = await core.syncProvider("github")
    expect([refused.result, refused.reason]).toEqual(["failed", "GitHub rejected the token (401): Bad credentials"])
    expect(writes()).toEqual([])
    expect(core.loadStore().providers.github?.registered).toBeFalsy()
    process.env.GITHUB_TOKEN = "gh_env_token"
    process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = "http://127.0.0.1:1"
    const down = await core.syncProvider("github")
    expect(down.result).toBe("failed")
    expect(down.reason).toContain("Could not reach GitHub")
    expect(writes()).toEqual([])
  })

  test("a synced connection carries the known expiry, so the workspace view shows it", async () => {
    expect((await core.syncProvider("github")).result).toBe("synced")
    expect((writes()[0].body.config as any).expires_at).toBe("2031-01-02T03:04:05.000Z")
    expect((await core.statusRemote()).providers[0]).toMatchObject({ state: "connected", sync: "synced", expiresAt: "2031-01-02T03:04:05.000Z" })
  })

  test("sync over every provider says a synced connection deleted in the workspace is gone, not already there", async () => {
    await core.syncProvider("github")
    api.state.rows.find((r) => r.name === `GitHub (from ${HOST})`)!.deleted = true
    const all = await core.syncProvider("github", undefined, 0, true)
    expect([all.result, all.reason]).toEqual(["skipped", "The workspace connection was removed. Add the credentials again."])
  })

  test("sync over every provider attaches a workspace connection even when the only thing found here is a remote MCP server", async () => {
    await core.recordDetections([{ id: "linear", source: { kind: "mcp-remote", label: "Claude MCP" }, account: null, syncable: false, note: "usable in Claude; connect in browser to sync" }])
    api.seed({ name: `Linear (from ${HOST})`, integration_id: "linear" })
    const all = await core.syncProvider("linear", undefined, 0, true)
    expect([all.result, all.steps[0]]).toEqual(["synced", { label: "Connection already in the workspace", ok: true }])
    const plain = await core.syncProvider("linear")
    expect([plain.result, plain.reason]).toEqual(["skipped", "usable in Claude; connect in browser to sync"])
  })

  test("a credential found here is still offered next to a hand-made workspace connection", async () => {
    api.seed({ name: "Hand made", integration_id: "github", last_validated_at: "2030-05-01T00:00:00Z" })
    const shown = (await core.statusRemote()).providers[0]
    expect([shown.state, shown.managed, shown.found]).toEqual(["connected", false, { source: { kind: "env", label: "GITHUB_TOKEN" }, account: null }])
    const plain = (await core.statusRemote()).providers[1]
    expect(plain.found).toBeUndefined()
  })

  test("purging a provider's secrets covers every variant, not only the connected one", async () => {
    await core.storeSecret(core.secretKey("cred", "jira", "jiraApiToken"), "cloud-token")
    await core.storeSecret(core.secretKey("cred", "jira", "jiraPatToken"), "server-token")
    await core.purgeCredentialSecrets("jira", { registered: true, secretFields: ["jiraPatToken"] } as any, false)
    expect(await core.readSecret(core.secretKey("cred", "jira", "jiraApiToken"))).toBeFalsy()
    expect(await core.readSecret(core.secretKey("cred", "jira", "jiraPatToken"))).toBeFalsy()
  })

  test("purging a provider's secrets keeps the fields just written", async () => {
    await core.storeSecret(core.secretKey("cred", "jira", "jiraApiToken"), "new-token")
    await core.storeSecret(core.secretKey("cred", "jira", "jiraPatToken"), "old-token")
    await core.purgeCredentialSecrets("jira", undefined, false, new Set(["jiraApiToken"]))
    expect(await core.readSecret(core.secretKey("cred", "jira", "jiraApiToken"))).toBe("new-token")
    expect(await core.readSecret(core.secretKey("cred", "jira", "jiraPatToken"))).toBeFalsy()
  })

  test("a refused new connection that cannot be removed still reports the refusal", async () => {
    api.state.valid = false
    const del = spyOn(backend, "deleteConnection").mockRejectedValue(new Error("delete down"))
    try {
      const out = await core.syncProvider("github")
      expect(out.result).toBe("failed")
      expect(out.reason).toContain("refused")
      expect(out.reason).toContain("It could not be removed from the workspace, remove it there")
    } finally {
      del.mockRestore()
    }
  })

  test("a fresh local connection wins over the remote one", async () => {
    const now = Date.parse("2030-01-01T00:00:00Z")
    const remote: core.RemoteProvider[] = [{ integration_id: "linear", connection_id: 3, name: "Linear", account: null, managed: true, source: null, expires_at: null, expired: false, is_valid: false }]
    await connected("linear", "2030-01-01T01:00:00Z", { account: "me" })
    const merged = core.mergeRemote(core.buildStatus(core.loadStore(), [], now), remote, now).providers.find((p) => p.id === "linear")!
    expect([merged.state, merged.sync, merged.note]).toEqual(["rejected", "synced", "Token rejected, update it"])
    const hand = core.mergeRemote(core.buildStatus(core.loadStore(), [], now), [{ ...remote[0], managed: false, is_valid: true }], now).providers.find((p) => p.id === "linear")!
    expect([hand.state, hand.sync]).toEqual(["connected", "local"])
  })

  test("disconnect deletes only the managed connections", async () => {
    api.seed({ name: `Linear (from ${HOST})`, integration_id: "linear" })
    api.seed({ name: `Linear (from ${HOST})`, integration_id: "linear" })
    api.seed({ name: "Linear", integration_id: "linear" })
    api.seed({ name: `GitHub (from ${HOST})`, integration_id: "github" })
    api.seed({ name: "Linear (from another-host)", integration_id: "linear" })
    expect(await core.disconnectRemote("linear")).toBe(2)
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/connections/21", "/connections/22"])
    expect(api.state.rows.filter((r) => !r.deleted).map((r) => r.name)).toEqual(["Linear", `GitHub (from ${HOST})`, "Linear (from another-host)"])
  })

  test("a failed workspace delete keeps the local credential so disconnect can be retried", async () => {
    await connected("linear", null)
    api.seed({ name: `Linear (from ${HOST})`, integration_id: "linear" })
    api.state.fail = { status: 500, body: { detail: "boom" } }
    await expect(core.disconnect("linear")).rejects.toThrow()
    expect(core.status().providers.find((p) => p.id === "linear")!.state).toBe("connected")
    expect(await core.readSecret("linear")).toBe("tok_linear")
    api.state.fail = null
    expect(await core.disconnect("linear")).toEqual({ removedLocal: true, removedRemote: 1, detached: true })
    expect(core.status().providers.find((p) => p.id === "linear")!.state).toBe("not_found")
    expect(await core.readSecret("linear")).toBeUndefined()
  })

  test("upsertManaged reports when the project is not linked to a workspace", async () => {
    const cfg = (await backend.backendConfig())!
    const res = await core.upsertManaged(cfg, "github", { github_token: "t" })
    expect(res.workspace).toEqual({ notLinked: true })
    expect(calls.filter((c) => c.path.startsWith("/datamates/"))).toEqual([])
  })

  test("workspace info reports an unlinked project", async () => {
    expect(await core.liveWorkspaceInfo()).toEqual({ name: "acme", tenant: "acme", linked: false, id: null, signedIn: true })
  })

  test("an already saved connection with no local secret is verified and reported as not linked", async () => {
    const row = api.seed({ name: `GitHub (from ${HOST})`, integration_id: "github" })
    const store = core.loadStore()
    store.providers.github = { registered: true, synced: true, connectionId: row.id, variant: "default", secretFields: ["github_token"], values: {} } as any
    core.saveStore(store)
    delete process.env.GITHUB_TOKEN
    const out = await core.syncProvider("github")
    expect(out.result).toBe("synced")
    expect(out.steps).toEqual([{ label: "Connection already in the workspace", ok: true }, { label: "Not linked to a workspace: run altimate link", ok: false }])
    expect(writes()).toEqual([])
  })

  test("a saved connection that is gone from the workspace is still skipped", async () => {
    const store = core.loadStore()
    store.providers.github = { registered: true, synced: true, connectionId: 999, variant: "default", secretFields: ["github_token"], values: {} } as any
    core.saveStore(store)
    delete process.env.GITHUB_TOKEN
    expect((await core.syncProvider("github")).result).toBe("skipped")
  })

  test("only the existing connections endpoints are called", async () => {
    await core.syncProvider("github")
    await core.statusRemote()
    await core.disconnectRemote("github")
    expect(calls.length).toBeGreaterThan(3)
    expect(calls.filter((c) => c.path.startsWith("/integrations/"))).toEqual([])
    expect(calls.every((c) => c.auth === "Bearer bearer-1" && c.tenant === "acme")).toBe(true)
    expect(calls.filter((c) => !c.path.startsWith("/datamate-project-bindings/")).every((c) => c.path === "/datamate_integrations/" || c.path === "/connections/" || /^\/connections\/\d+$/.test(c.path))).toBe(true)
  })

  test("the CLI exits non-zero on a failed sync, reports step outcomes, and refuses to block a synced connection", async () => {
    const cli = path.join(import.meta.dir, "../../src/index.ts")
    const run = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, "run", cli, "integrations", ...args], { env: { ...process.env, ALTIMATE_INTEGRATIONS_DIR: tmp }, stdout: "pipe", stderr: "pipe" })
      const [stdout] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      return { code: await p.exited, data: JSON.parse(stdout) }
    }
    api.state.valid = false
    const failed = await run("sync", "github", "--json")
    expect([failed.code, failed.data.results[0].result]).toEqual([1, "failed"])
    expect(failed.data.results[0].steps).toEqual([])
    api.state.valid = true
    expect((await run("sync", "github", "--json")).code).toBe(0)
    const blocked = await run("block", "github", "--json")
    expect([blocked.code, blocked.data.refused, blocked.data.providers]).toEqual([1, ["github"], []])
    expect(core.isBlocked("github")).toBe(false)
    api.seed({ name: `Linear (from ${HOST})`, integration_id: "linear" })
    const remoteOnly = await run("block", "linear", "--json")
    expect([remoteOnly.code, remoteOnly.data.refused, remoteOnly.data.providers]).toEqual([1, ["linear"], []])
    expect(core.isBlocked("linear")).toBe(false)
  }, 60_000)

  test("a hand-made connection is shown as not managed", async () => {
    api.seed({ name: "Hand made", integration_id: "jira" })
    const jira = (await core.statusRemote()).providers.find((p) => p.id === "jira")!
    expect([jira.state, jira.managed]).toEqual(["connected", false])
  })

  test("a local expiry is not erased by a workspace copy of unknown expiry", async () => {
    const now = Date.parse("2030-01-01T00:00:00Z")
    const remote: core.RemoteProvider[] = [{ integration_id: "linear", connection_id: 3, name: "Linear", account: null, managed: true, source: null, expires_at: null, expired: false, is_valid: false }]
    await connected("linear", "2029-12-31T00:00:00Z", { account: "me", synced: true })
    const merged = core.mergeRemote(core.buildStatus(core.loadStore(), [], now), remote, now).providers.find((p) => p.id === "linear")!
    expect([merged.state, merged.expiresAt]).toEqual(["expired", "2029-12-31T00:00:00Z"])
  })

  test("without a signed-in backend nothing is removed", async () => {
    expect(await core.disconnectRemote("linear", null)).toEqual(0)
  })

  test("status says so when the workspace could not be read, instead of showing local states as current", async () => {
    await connected("github", null, { synced: true, connectionId: 21 }, null)
    expect((await core.statusRemote()).workspaceUnchecked).toBeUndefined()
    api.state.listFails = true
    const r = await core.statusRemote()
    expect(r.workspaceUnchecked).toContain("unavailable")
    expect(r.providers.find((p) => p.id === "github")?.state).toBe("connected")
  })

  test("a link remembered from earlier is not attached to or detached from", async () => {
    const outcome = workspaceState.resolveBindingOutcome as any
    outcome.mockResolvedValue({ status: "bound", stale: true, binding: { datamateId: "9", datamateName: "Old" } })
    const login = spyOn(AltimateApi, "isConfigured").mockResolvedValue(true)
    try {
      const cfg = (await backend.backendConfig())!
      const attached = await core.attachToBoundWorkspace(cfg, "github", 21)
      expect(attached).toEqual({ error: expect.stringContaining("could not confirm which workspace") })
      api.seed({ name: `Linear (from ${HOST})`, integration_id: "linear" })
      const gone = await core.disconnect("linear")
      expect([gone.removedRemote, gone.detached, gone.detachMessage]).toEqual([1, false, expect.stringContaining("could not confirm which workspace")])
      expect(calls.some((c) => c.path.startsWith("/datamates"))).toBe(false)
      expect(api.state.rows.filter((x) => !x.deleted)).toHaveLength(0)
      login.mockResolvedValue(false)
      expect(await core.attachToBoundWorkspace(cfg, "github", 21)).toEqual({ notLinked: true })
    } finally {
      login.mockRestore()
    }
  })

  test("a state file that cannot be parsed is an error and is not replaced by an empty one", async () => {
    const file = path.join(tmp, "integrations.json")
    fs.writeFileSync(file, "{not json")
    expect(() => core.loadStore()).toThrow(/Could not read .*integrations\.json/)
    await expect(core.setBlocked(["github"], true)).rejects.toThrow("Could not read")
    expect(fs.readFileSync(file, "utf8")).toBe("{not json")
    fs.rmSync(file)
    expect(core.loadStore()).toEqual({ blocked: {}, providers: {} })
  })

  test("a secrets file that cannot be parsed is not replaced when another secret is stored", async () => {
    const file = path.join(tmp, "integrations-secrets.json")
    fs.writeFileSync(file, "[oops")
    await expect(core.storeSecret("cred:github:github_token", "x")).rejects.toThrow("Could not read")
    expect(fs.readFileSync(file, "utf8")).toBe("[oops")
  })

  test("an unreadable Altimate login does not stop the local paths, but does stop removing a workspace copy", async () => {
    const login = spyOn(AltimateApi, "getCredentials").mockRejectedValue(new SyntaxError("Unexpected token n in JSON"))
    for (const k of ["ALTIMATE_INTEGRATIONS_API_URL", "ALTIMATE_INTEGRATIONS_TENANT", "ALTIMATE_INTEGRATIONS_TOKEN"]) delete process.env[k]
    try {
      expect((await creds.loadCatalog("github", true))[0].fields.map((f) => f.name)).toContain("github_token")
      await connected("github", null, { synced: false })
      expect(await core.disconnect("github")).toMatchObject({ removedLocal: true, removedRemote: 0, detached: true })
      await connected("linear", null, { synced: true, connectionId: 3 })
      await expect(core.disconnect("linear")).rejects.toThrow("Could not read your Altimate login")
      const st = await core.statusRemote()
      expect(st.workspaceUnchecked).toContain("Could not read your Altimate login")
      expect(st.providers.find((p) => p.id === "linear")?.state).toBe("connected")
      expect(core.loadStore().providers.linear?.registered).toBe(true)
    } finally {
      login.mockRestore()
    }
  })
})

describe("failure descriptions", () => {
  test("validation lists, string details and codes", () => {
    expect(backend.describeFailure(422, { detail: [{ loc: ["body", "name"], msg: "Name can't be blank", type: "blank_field" }, { loc: ["body", "config"], msg: "Settings can't be empty", type: "empty_field" }] })).toBe(
      "Name can't be blank; Settings can't be empty (blank_field)",
    )
    expect(backend.describeFailure(400, { detail: "Fill in the required connection fields: Domain" })).toBe("Fill in the required connection fields: Domain")
    expect(backend.describeFailure(409, { detail: { code: "stored_secret_changed" } })).toBe("The saved credential changed, reload and try again (stored_secret_changed)")
    expect(backend.describeFailure(404, { detail: { code: "gone", message: "Connection not found" } })).toBe("Connection not found (gone)")
    expect(backend.describeFailure(500, null)).toBe("status 500")
  })

  test("a 404 does not claim a connection was missing, as it can come from a workspace or the catalog", () => {
    expect(backend.describeFailure(404, null)).toBe("The requested resource was not found")
  })

  test("a success whose body is not JSON is an error, not an empty list", async () => {
    const odd = Bun.serve({ port: 0, fetch: () => new Response("<html>gateway</html>", { status: 200 }) })
    try {
      const cfg = { apiUrl: `http://127.0.0.1:${odd.port}`, tenant: "acme", token: "t" }
      await expect(backend.listOwnConnections(cfg)).rejects.toThrow(/not JSON/)
      await expect(backend.listVisibleConnections(cfg)).rejects.toThrow(/not JSON/)
    } finally {
      odd.stop(true)
    }
  })
})

describe("backend answers that are not what they should be", () => {
  const answer = async (body: unknown, run: (cfg: backend.BackendConfig) => Promise<unknown>, status = 200) => {
    const odd = Bun.serve({ port: 0, fetch: () => (body === null ? new Response("", { status }) : Response.json(body, { status })) })
    try {
      return await run({ apiUrl: `http://127.0.0.1:${odd.port}`, tenant: "acme", token: "t" })
    } finally {
      odd.stop(true)
    }
  }

  test("an empty answer or one without a connections list is an error, not no connections", async () => {
    for (const body of [null, {}, { connections: null }]) {
      await expect(answer(body, backend.listOwnConnections)).rejects.toThrow("without a list of connections")
      await expect(answer(body, backend.listVisibleConnections)).rejects.toThrow("without a list of connections")
    }
    expect(await answer({ connections: [] }, backend.listOwnConnections)).toEqual([])
  })

  test("a workspace answer that is not a record, or has no integrations list, is an error", async () => {
    await expect(answer(null, (cfg) => backend.getDatamate(cfg, "7"))).rejects.toThrow("without the workspace record")
    await expect(answer({ ok: true }, (cfg) => backend.getDatamate(cfg, "7"))).rejects.toThrow("without the workspace record")
    await expect(answer({ id: 7, integrations: null }, (cfg) => backend.getDatamate(cfg, "7"))).rejects.toThrow("not a list")
    await expect(answer({ datamate: { id: 7, name: "W" } }, (cfg) => backend.getDatamate(cfg, "7"))).rejects.toThrow("not a list")
    expect(await answer({ id: 7, name: "W", integrations: [] }, (cfg) => backend.getDatamate(cfg, "7"))).toMatchObject({ id: "7", name: "W", integrations: [] })
    for (const integrations of [{ unexpected: true }, "github", 3])
      await expect(answer({ datamate: { id: 7, name: "W", integrations } }, (cfg) => backend.getDatamate(cfg, "7"))).rejects.toThrow("not a list")
  })

  test("a backend without the summary route is read from the workspace list, and only when the list carries the integrations", async () => {
    const routes = (list: unknown) =>
      Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/datamates/" ? Response.json(list) : Response.json({ detail: "nope" }, { status: 404 })) })
    for (const [list, expected] of [
      [[{ id: 7, name: "W", integrations: [{ id: "github", tools: [] }] }], { id: "7", integrations: [{ id: "github", tools: [] }] }],
      [[{ id: 7, name: "W" }], null],
      [[{ id: 8, name: "Other", integrations: [] }], null],
    ] as const) {
      const srv = routes(list)
      try {
        const run = backend.getDatamate({ apiUrl: `http://127.0.0.1:${srv.port}`, tenant: "acme", token: "t" }, "7")
        if (expected) expect(await run).toMatchObject(expected)
        else await expect(run).rejects.toThrow()
      } finally {
        srv.stop(true)
      }
    }
  })
})

describe("jira domain and cli flags", () => {
  test("normaliseJiraDomain sends the subdomain only", () => {
    for (const v of ["acme.atlassian.net", "https://acme.atlassian.net", "https://acme.atlassian.net/jira/", " acme.atlassian.net ", "acme", "https://acme.atlassian.net:443/", "acme.atlassian.net:8443"])
      expect(core.normaliseJiraDomain(v)).toBe("acme")
  })

  test("the browser sign-in flags are gone and the token command is removed", () => {
    const cli = path.join(import.meta.dir, "../../src/index.ts")
    const run = (...args: string[]) =>
      Bun.spawnSync(["bun", "run", cli, "integrations", ...args], { env: { ...process.env, ALTIMATE_INTEGRATIONS_DIR: tmp, ALTIMATE_INTEGRATIONS_MOCK: "1" }, stdout: "pipe", stderr: "pipe" })
    const all = (r: ReturnType<typeof run>) => r.stderr.toString() + r.stdout.toString()
    expect(all(run("--help"))).not.toContain("token <provider>")
    const help = all(run("connect", "--help"))
    for (const flag of ["--oauth", "--reauth", "--no-frontend", "--port"]) expect(help).not.toContain(flag)
    expect(help).toContain("--local-only")
  }, 60_000)
})

describe("credentials flow", () => {
  const calls: { method: string; path: string; query: string; auth: string | null; body: any }[] = []
  let server: ReturnType<typeof Bun.serve>
  const api = connectionsStub()
  let catalog: unknown = []
  let onUser: (() => void) | null = null
  const saved = { ...process.env }
  const home = osTmp("integ-home-")
  const bin = osTmp("integ-bin-")
  const basic = (u: string, t: string) => `Basic ${Buffer.from(`${u}:${t}`).toString("base64")}`
  const GOOD = "good_token_a1b2"
  // The detectors spawn these binaries with short timeouts, and a freshly written executable can be
  // slow on its first run (macOS scans it). Each stub is written and run once; a test only swaps the
  // body it sources and links the stub in or out of PATH.
  const stubs = osTmp("integ-stubs-")
  for (const name of ["gh", "git"]) {
    const stub = path.join(stubs, name)
    fs.writeFileSync(stub, `#!/bin/sh\n[ -f "${stub}.body" ] && . "${stub}.body"\n`, { mode: 0o755 })
    Bun.spawnSync([stub])
  }
  const fake = (name: string, body: string | null) => {
    const file = path.join(bin, name)
    const stub = path.join(stubs, name)
    fs.rmSync(file, { force: true })
    if (body === null) return fs.rmSync(`${stub}.body`, { force: true })
    fs.writeFileSync(`${stub}.body`, `${body}\n`)
    fs.symlinkSync(stub, file)
  }
  const real = () => {
    delete process.env.ALTIMATE_INTEGRATIONS_MOCK
    process.env.ALTIMATE_INTEGRATIONS_API_URL = `http://127.0.0.1:${server.port}`
    process.env.ALTIMATE_INTEGRATIONS_TOKEN = "bearer-1"
    process.env.ALTIMATE_INTEGRATIONS_TENANT = "acme"
  }
  const mock = () => {
    process.env.ALTIMATE_INTEGRATIONS_MOCK = "1"
    for (const k of ["ALTIMATE_INTEGRATIONS_API_URL", "ALTIMATE_INTEGRATIONS_TOKEN", "ALTIMATE_INTEGRATIONS_TENANT"]) delete process.env[k]
  }
  const clip = (text: string | undefined) => ({ clipboard: () => text })
  const token = async (id: core.ProviderId, field: string, value = GOOD) => creds.setSecretDraft(id, field, { kind: "clipboard" }, clip(value))
  const synced = () => calls.filter((c) => c.method !== "GET" && c.path.startsWith("/connections"))

  beforeEach(async () => {
    calls.length = 0
    api.state.rows.length = 0
    api.state.next = 21
    api.state.valid = true
    api.state.fail = null
    api.state.listFails = false
    catalog = []
    onUser = null
    fs.rmSync(home, { recursive: true, force: true })
    fs.mkdirSync(home)
    fake("gh", null)
    fake("git", null)
    mock()
    process.env.ALTIMATE_INTEGRATIONS_HOME = home
    process.env.PATH = bin
    for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "JIRA_API_TOKEN", "JIRA_USER", "JIRA_DOMAIN", "LINEAR_API_KEY", "ATLASSIAN_API_TOKEN"]) delete process.env[k]
  })
  const base = () => `http://127.0.0.1:${server.port}`
  const startServer = () => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const auth = req.headers.get("authorization")
        const body = req.method === "POST" || req.method === "PATCH" ? await req.json().catch(() => null) : null
        calls.push({ method: req.method, path: url.pathname, query: url.search, auth, body })
        const deny = () => Response.json({ message: "Bad credentials" }, { status: 401 })
        if (url.pathname === "/user") onUser?.()
        if (url.pathname === "/user")
          return auth === `Bearer ${GOOD}` ? Response.json({ login: "octo" }, { headers: { "github-authentication-token-expiration": "2031-01-02 03:04:05 UTC" } }) : deny()
        if (url.pathname === "/rest/api/3/myself") return auth === basic("me@acme.com", GOOD) ? Response.json({ emailAddress: "me@acme.com" }) : deny()
        if (url.pathname === "/rest/api/2/myself") return auth === `Bearer ${GOOD}` ? Response.json({ displayName: "Server Me" }) : deny()
        if (url.pathname === "/graphql") return auth === GOOD ? Response.json({ data: { viewer: { email: "lin@acme.com", name: "Lin" } } }) : Response.json({ errors: [{ extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 401 })
        if (url.pathname === "/datamate_integrations/") return Response.json(catalog)
        const mine = api.handle(req, url, body)
        if (mine) return mine
        return new Response("no", { status: 404 })
      },
    })
    process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = base()
    process.env.ALTIMATE_INTEGRATIONS_JIRA_API = base()
    process.env.ALTIMATE_INTEGRATIONS_LINEAR_API = `${base()}/graphql`
  }
  startServer()
  afterAll(() => {
    server.stop(true)
    process.env.PATH = saved.PATH
    delete process.env.ALTIMATE_INTEGRATIONS_HOME
    for (const k of ["ALTIMATE_INTEGRATIONS_GITHUB_API", "ALTIMATE_INTEGRATIONS_JIRA_API", "ALTIMATE_INTEGRATIONS_LINEAR_API"]) delete process.env[k]
    mock()
  })

  describe("fields", () => {
    test("built-in table when nothing else is known", async () => {
      const gh = await creds.describeFields("github")
      expect(gh).toEqual({
        provider: "github",
        variant: "token",
        variants: ["token"],
        fields: [{ name: "github_token", label: "Personal access token", secret: true, required: true, value: null, hasValue: false, masked: null }],
        tokenUrl: "https://github.com/settings/tokens/new?scopes=repo,read:user&description=Altimate",
      })
      const jira = await creds.describeFields("jira")
      expect([jira.variant, jira.variants, jira.fields.map((f) => f.name), jira.tokenUrl]).toEqual(["cloud", ["cloud", "server"], ["jiraDomain", "jiraEmail", "jiraApiToken"], "https://id.atlassian.com/manage-profile/security/api-tokens"])
      expect((await creds.describeFields("jira", "server")).tokenUrl).toBeNull()
      const lin = await creds.describeFields("linear")
      expect([lin.variant, lin.fields.map((f) => [f.name, f.secret]), lin.tokenUrl]).toEqual(["key", [["linearApiKey", true]], "https://linear.app/settings/account/security"])
    })

    test("jira variant follows the site and the form is pre-filled", async () => {
      const cfg = path.join(home, ".config/.jira")
      fs.mkdirSync(cfg, { recursive: true })
      fs.writeFileSync(path.join(cfg, ".config.yml"), "server: https://acme.atlassian.net\nlogin: me@acme.com\n")
      const cloud = await creds.describeFields("jira")
      expect(cloud.variant).toBe("cloud")
      expect(cloud.fields.map((f) => [f.name, f.value])).toEqual([["jiraDomain", "acme"], ["jiraEmail", "me@acme.com"], ["jiraApiToken", null]])

      fs.writeFileSync(path.join(cfg, ".config.yml"), "server: https://jira.corp.example/\nlogin: me@corp.example\n")
      const server = await creds.describeFields("jira")
      expect(server.variant).toBe("server")
      expect(server.fields.map((f) => [f.name, f.value])).toEqual([["jiraBaseUrl", "https://jira.corp.example"], ["jiraPatToken", null]])

      fs.writeFileSync(path.join(cfg, ".config.yml"), "server: https://acme.atlassian.net\n")
      fake("git", 'echo git@example.com')
      expect((await creds.describeFields("jira")).fields[1].value).toBe("git@example.com")
      await creds.setDraft("jira", "jiraEmail", "draft@example.com")
      expect((await creds.describeFields("jira")).fields[1].value).toBe("draft@example.com")
    })

    test("secrets report only a masked tail", async () => {
      fake("gh", '[ "$2" = token ] && echo ghp_secretvalue_a1b2')
      const f = (await creds.describeFields("github")).fields[0]
      expect([f.value, f.hasValue, f.masked]).toEqual([null, true, "••••a1b2"])
      expect(JSON.stringify(await creds.describeFields("github"))).not.toContain("secretvalue")
    })

    test("jiraVariantFor", () => {
      expect([undefined, "", "acme", "https://a.atlassian.net/x", "https://jira.corp.example"].map(creds.jiraVariantFor)).toEqual(["cloud", "cloud", "cloud", "cloud", "server"])
      expect(["localhost", "http://localhost:8080", "jira-internal:8443", "http://jira-internal", "https://acme.atlassian.net:443"].map(creds.jiraVariantFor)).toEqual(["server", "server", "server", "server", "cloud"])
    })

    test("workspace catalog is read, cached and used when offline", async () => {
      catalog = [
        {
          id: "github",
          config: [
            { name: "Token", key: "github_token", type: "password", required: true, encrypted: true },
            { name: "Organization", key: "github_org", type: "text", required: false, encrypted: false },
            { name: "Auth type", key: "auth_type", type: "text", required: false, encrypted: false },
          ],
        },
        {
          id: "jira",
          config: [
            { name: "Site", key: "jiraDomain", type: "text", required: true, encrypted: false },
            { name: "Token", key: "jiraApiToken", type: "password", required: true, encrypted: true },
          ],
          additionalConfigVariants: [{ id: "server", name: "Server", config: [{ name: "URL", key: "jiraBaseUrl", type: "text", required: true, encrypted: false }] }],
        },
        { id: "other", config: [] },
      ]
      real()
      const gh = await creds.describeFields("github")
      expect(gh.fields.map((f) => [f.name, f.label, f.secret, f.required])).toEqual([["github_token", "Token", true, true], ["github_org", "Organization", false, false]])
      const jira = await creds.describeFields("jira", "server")
      expect([jira.variant, jira.variants, jira.fields.map((f) => [f.name, f.label])]).toEqual(["server", ["cloud", "server"], [["jiraBaseUrl", "URL"]]])
      expect(calls.some((c) => c.path === "/datamate_integrations/" && c.auth === "Bearer bearer-1")).toBe(true)

      expect(fs.readdirSync(tmp).filter((f) => f.startsWith("integrations-catalog-"))).toHaveLength(1)
      // Another tenant on the same backend does not see this cache.
      process.env.ALTIMATE_INTEGRATIONS_TENANT = "other"
      catalog = []
      expect((await creds.describeFields("github")).fields.map((f) => f.name)).toEqual(["github_token"])
      real()
      mock()
      expect((await creds.describeFields("github")).fields.map((f) => f.name)).toEqual(["github_token"])
      // An empty catalog while signed in falls back to the cache too.
      real()
      catalog = []
      expect((await creds.describeFields("github")).fields.map((f) => f.name)).toEqual(["github_token", "github_org"])
    })

    test("parseCatalog reads a wrapped list and a variants map", () => {
      const parsed = creds.parseCatalog({ items: [{ id: "linear", config: [{ name: "linearApiKey", encrypted: true, required: true }] }, { id: "jira", variants: { server: { config: { jiraBaseUrl: { required: true } } } } }] })
      expect(parsed.linear![0].fields).toEqual([{ name: "linearApiKey", label: "Linear Api Key", secret: true, required: true }])
      expect(parsed.jira![0]).toMatchObject({ id: "server", fields: [{ name: "jiraBaseUrl", secret: false, required: true }] })
    })
  })

  describe("set and set-secret", () => {
    test("a typed Jira site is reduced to the subdomain before it is stored", async () => {
      for (const typed of ["https://acme.atlassian.net", "acme.atlassian.net/", " http://Acme.atlassian.net/jira?x=1 "]) {
        await creds.setDraft("jira", "jiraDomain", typed)
        expect(core.loadStore().providers.jira?.drafts?.jiraDomain).toBe(typed.includes("Acme") ? "Acme" : "acme")
        expect((await creds.resolve("jira")).values.jiraDomain).toBe(typed.includes("Acme") ? "Acme" : "acme")
      }
    })

    test("set stores a non-secret draft and rejects secrets and unknown fields", async () => {
      await creds.setDraft("jira", "jiraDomain", " acme ")
      expect(core.loadStore().providers.jira?.drafts).toEqual({ jiraDomain: "acme" })
      await expect(creds.setDraft("jira", "jiraApiToken", "x")).rejects.toThrow("is a secret")
      await expect(creds.setDraft("jira", "nope", "x")).rejects.toThrow('no field "nope"')
      // A scan does not drop a draft.
      await core.recordDetections([])
      expect(core.loadStore().providers.jira?.drafts).toEqual({ jiraDomain: "acme" })
    })

    test("set-secret reads the injected clipboard and returns only the masked tail", async () => {
      const r = await creds.setSecretDraft("github", "github_token", { kind: "clipboard" }, clip(`  ghp_abcdefgh_${GOOD}\n`))
      expect(r).toEqual({ provider: "github", field: "github_token", masked: "••••a1b2" })
      expect(JSON.stringify(r)).not.toContain("abcdefgh")
      expect(await core.readSecret(core.secretKey("draft", "github", "github_token"))).toBe(`ghp_abcdefgh_${GOOD}`)
      expect(fs.existsSync(path.join(tmp, "integrations.json")) ? fs.readFileSync(path.join(tmp, "integrations.json"), "utf8") : "").not.toContain("abcdefgh")
    })

    test("clipboard content that is not a token is refused", async () => {
      for (const bad of [undefined, "", "   \n", "two words", "line1\nline2", "short"])
        await expect(creds.setSecretDraft("github", "github_token", { kind: "clipboard" }, clip(bad))).rejects.toThrow("Clipboard doesn't contain a token")
      await expect(creds.setSecretDraft("github", "github_token", { kind: "clipboard" }, clip("a b")).catch((e) => e.message)).resolves.not.toContain("a b")
      expect(await core.readSecret(core.secretKey("draft", "github", "github_token"))).toBeUndefined()
      await expect(creds.setSecretDraft("jira", "jiraEmail", { kind: "clipboard" }, clip("x"))).rejects.toThrow("not a secret")
    })

    test("secrets can come from an environment variable or stdin", async () => {
      process.env.OPT2_TEST_TOKEN = "env_token_zzzz"
      expect(await creds.setSecretDraft("linear", "linearApiKey", { kind: "env", name: "OPT2_TEST_TOKEN" })).toEqual({ provider: "linear", field: "linearApiKey", masked: "••••zzzz" })
      await expect(creds.setSecretDraft("linear", "linearApiKey", { kind: "env", name: "OPT2_MISSING" })).rejects.toThrow("is empty")
      expect((await creds.setSecretDraft("linear", "linearApiKey", { kind: "stdin" }, { stdin: async () => "stdin_token_9999\n" })).masked).toBe("••••9999")
      delete process.env.OPT2_TEST_TOKEN
    })
  })

  describe("where Jira values may come from", () => {
    const JIRA_ENV = ["JIRA_PAT_TOKEN", "JIRA_PERSONAL_TOKEN", "JIRA_PAT", "JIRA_BASE_URL", "JIRA_URL", "JIRA_API_TOKEN", "ATLASSIAN_API_TOKEN"]
    const project = osTmp("integ-project-")
    let cwd: ReturnType<typeof spyOn> | undefined
    const plant = (env: Record<string, string>) => {
      fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { jira: { command: "npx", args: ["mcp-jira"], env } } }))
      cwd = spyOn(process, "cwd").mockReturnValue(project)
    }
    const userMcp = (env: Record<string, string>) => fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { jira: { command: "npx", args: ["mcp-jira"], env } } }))
    const jiraCli = () => {
      fs.mkdirSync(path.join(home, ".config/.jira"), { recursive: true })
      fs.writeFileSync(path.join(home, ".config/.jira/.config.yml"), `server: ${base()}\nlogin: me@corp.example\n`)
    }
    afterEach(() => {
      cwd?.mockRestore()
      cwd = undefined
      fs.rmSync(path.join(project, ".mcp.json"), { force: true })
      for (const k of JIRA_ENV) delete process.env[k]
    })

    test("a planted project file cannot point the user's token at another host", async () => {
      plant({ JIRA_URL: base() })
      process.env.JIRA_PAT_TOKEN = GOOD
      expect((await creds.describeFields("jira", "server")).fields.map((f) => [f.name, f.value, f.hasValue])).toEqual([["jiraBaseUrl", null, false], ["jiraPatToken", null, true]])
      expect(await creds.detectedConfig("jira")).toEqual({ reason: "Missing: Site, Email, API token" })
      const r = await creds.connectCredentials({ id: "jira", variant: "server", localOnly: true })
      expect(r.status).toBe("missing_fields")
      expect(calls.filter((c) => c.path.includes("myself"))).toEqual([])
    })

    test("a token planted in a project file is not used", async () => {
      plant({ JIRA_PAT_TOKEN: GOOD })
      process.env.JIRA_BASE_URL = base()
      expect((await creds.detectedConfig("jira"))).toEqual({ reason: "Missing: Personal access token" })
      expect(calls).toEqual([])
    })

    test("a project file still counts as present, without being syncable", () => {
      plant({ JIRA_PAT_TOKEN: GOOD })
      const found = core.detectFromClaudeConfigs(home, project).find((d) => d.id === "jira")!
      expect([found.source.kind, found.syncable]).toEqual(["mcp-remote", false])
    })

    test("a site from one source is not paired with a token from another", async () => {
      jiraCli()
      userMcp({ JIRA_PAT_TOKEN: GOOD })
      expect(await creds.detectedConfig("jira")).toEqual({ reason: expect.stringContaining("Missing: Personal access token") })
      const connect = await creds.connectCredentials({ id: "jira", variant: "server", localOnly: true })
      expect([connect.status, connect.message]).toEqual(["missing_fields", expect.stringContaining("the token was not filled in")])
      fs.rmSync(path.join(home, ".config"), { recursive: true, force: true })
      userMcp({ JIRA_URL: base() })
      process.env.JIRA_PAT_TOKEN = GOOD
      expect(await creds.detectedConfig("jira")).toEqual({ reason: expect.stringContaining("Missing: Personal access token") })
    })

    test("same-named servers in the user and project scopes are separate sources", async () => {
      fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
        mcpServers: { jira: { command: "npx", args: ["mcp-jira"], env: { JIRA_PAT_TOKEN: GOOD } } },
        projects: { [project]: { mcpServers: { jira: { command: "npx", args: ["mcp-jira"], env: { JIRA_URL: base() } } } } },
      }))
      cwd = spyOn(process, "cwd").mockReturnValue(project)
      expect(await creds.detectedConfig("jira")).toEqual({ reason: expect.stringContaining("Missing: Personal access token") })
      expect(calls.filter((c) => c.path.includes("myself"))).toEqual([])
      const f = await creds.describeFields("jira", "server")
      expect(f.fields.find((x) => x.name === "jiraPatToken")?.note).toContain("Claude MCP (jira, user)")
    })

    test("a site and a token from the same source are used together", async () => {
      process.env.JIRA_BASE_URL = base()
      process.env.JIRA_PAT_TOKEN = GOOD
      expect(await creds.detectedConfig("jira")).toMatchObject({ config: { jiraBaseUrl: base(), jiraPatToken: GOOD } })
      delete process.env.JIRA_BASE_URL
      delete process.env.JIRA_PAT_TOKEN
      userMcp({ JIRA_URL: base(), JIRA_PAT_TOKEN: GOOD })
      expect(await creds.detectedConfig("jira")).toMatchObject({ config: { jiraBaseUrl: base(), jiraPatToken: GOOD } })
    })

    test("a site the user typed pairs with a detected token", async () => {
      process.env.JIRA_PAT_TOKEN = GOOD
      await creds.setDraft("jira", "jiraBaseUrl", base())
      const f = await creds.describeFields("jira", "server")
      expect(f.fields.map((x) => [x.name, x.value, x.hasValue])).toEqual([["jiraBaseUrl", base(), true], ["jiraPatToken", null, true]])
    })
  })

  describe("validators", () => {
    const cases: [core.ProviderId, string, Record<string, string>, Record<string, string>, string][] = [
      ["github", "token", { github_token: GOOD }, { github_token: "bad" }, "octo"],
      ["jira", "cloud", { jiraDomain: "acme", jiraEmail: "me@acme.com", jiraApiToken: GOOD }, { jiraDomain: "acme", jiraEmail: "me@acme.com", jiraApiToken: "bad" }, "me@acme.com"],
      ["jira", "server", { jiraBaseUrl: base(), jiraPatToken: GOOD }, { jiraBaseUrl: base(), jiraPatToken: "bad" }, "Server Me"],
      ["linear", "key", { linearApiKey: GOOD }, { linearApiKey: "bad" }, "lin@acme.com"],
    ]
    for (const [id, variant, good, bad, account] of cases) {
      test(`${id} ${variant}: accepted and rejected`, async () => {
        const ok = await creds.validate(id, variant, good)
        expect([ok.ok, ok.account]).toEqual([true, account])
        const no = await creds.validate(id, variant, bad)
        expect([no.ok, no.rejected]).toEqual([false, true])
        expect(no.message).toMatch(/rejected/)
      })
    }
    test("github reports the token expiry and an unreachable provider is not a rejection", async () => {
      expect((await creds.validate("github", "token", { github_token: GOOD })).expiresAt).toBe("2031-01-02T03:04:05.000Z")
      process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = "http://127.0.0.1:1"
      const r = await creds.validate("github", "token", { github_token: GOOD })
      expect([r.ok, r.rejected]).toEqual([false, false])
      process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = base()
    })
    test("a GitHub rate-limit 403 is not a rejected token and keeps the typed draft", async () => {
      const limited = Bun.serve({ port: 0, fetch: () => Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }) })
      const retry = Bun.serve({ port: 0, fetch: () => Response.json({ message: "slow down" }, { status: 403, headers: { "retry-after": "30" } }) })
      try {
        for (const s of [limited, retry]) {
          process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = `http://127.0.0.1:${s.port}`
          const r = await creds.validate("github", "token", { github_token: GOOD })
          expect([r.ok, r.rejected, r.unavailable]).toEqual([false, false, true])
        }
        process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = `http://127.0.0.1:${limited.port}`
        await token("github", "github_token")
        const c = await creds.connectCredentials({ id: "github" })
        expect(c.status).toBe("failed")
        expect(await core.readSecret(core.secretKey("draft", "github", "github_token"))).toBe(GOOD)
      } finally {
        process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = base()
        limited.stop(true)
        retry.stop(true)
      }
    })
    test("a 403 without rate-limit signs is still a rejected token", async () => {
      const denied = Bun.serve({ port: 0, fetch: () => Response.json({ message: "Resource not accessible" }, { status: 403 }) })
      try {
        process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = `http://127.0.0.1:${denied.port}`
        expect((await creds.validate("github", "token", { github_token: GOOD })).rejected).toBe(true)
      } finally {
        process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = base()
        denied.stop(true)
      }
    })
    test("a variant that matches nothing is an error, not the first variant", async () => {
      await expect(creds.connectCredentials({ id: "jira", variant: "srevre" })).rejects.toThrow(/no variant "srevre".*cloud, server/)
      await expect(creds.describeFields("jira", "srevre")).rejects.toThrow(/no variant/)
      expect((await creds.describeFields("jira", "server")).variant).toBe("server")
      expect((await creds.describeFields("jira")).variant).toBe("cloud")
    })
    test("a plain-http Jira server URL is refused", async () => {
      expect((await creds.validate("jira", "server", { jiraBaseUrl: "http://jira.corp.example", jiraPatToken: GOOD })).message).toContain("https")
    })
  })

  describe("connect and update", () => {
    test("missing fields are listed", async () => {
      const r = await creds.connectCredentials({ id: "jira" })
      expect([r.status, r.code, r.missing]).toEqual(["missing_fields", "missing_fields", ["jiraDomain", "jiraEmail", "jiraApiToken"]])
      expect(r.message).toBe("Missing: Site, Email, API token")
    })

    test("local-only validates, stores locally and calls no backend", async () => {
      real()
      await token("github", "github_token")
      const before = calls.length
      const r = await creds.connectCredentials({ id: "github", localOnly: true })
      expect(r).toMatchObject({ provider: "github", status: "connected", sync: "local", account: "octo", expiresAt: "2031-01-02T03:04:05.000Z" })
      expect(calls.slice(before).map((c) => c.path)).toEqual(["/user", "/connections/"])
      expect(synced()).toEqual([])
      expect(await core.readSecret(core.secretKey("cred", "github", "github_token"))).toBe(GOOD)
      expect(await core.readSecret("github")).toBe(GOOD)
      expect(await core.readSecret(core.secretKey("draft", "github", "github_token"))).toBeUndefined()
      const rec = core.loadStore().providers.github!
      expect([rec.registered, rec.synced, rec.rejected, rec.account, typeof rec.validatedAt]).toEqual([true, false, false, "octo", "string"])
      expect(JSON.stringify(rec)).not.toContain(GOOD)
      const p = core.status().providers[0]
      expect([p.state, p.sync, p.account, p.expiresAt]).toEqual(["connected", "blocked", "octo", "2031-01-02T03:04:05.000Z"])
      expect(await core.readSecret("github")).toBeTruthy()
    })

    test("a 2xx without an account is not accepted as a valid credential", async () => {
      const blank = Bun.serve({ port: 0, fetch: () => Response.json({}) })
      process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = `http://127.0.0.1:${blank.port}`
      process.env.ALTIMATE_INTEGRATIONS_JIRA_API = `http://127.0.0.1:${blank.port}`
      try {
        const gh = await creds.validate("github", "token", { github_token: GOOD })
        expect([gh.ok, gh.rejected]).toEqual([false, false])
        const jira = await creds.validate("jira", "cloud", { jiraDomain: "acme", jiraEmail: "me@acme.com", jiraApiToken: GOOD })
        expect([jira.ok, jira.rejected]).toEqual([false, false])
      } finally {
        blank.stop(true)
        process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = base()
        process.env.ALTIMATE_INTEGRATIONS_JIRA_API = base()
      }
    })

    test("a catalog id naming the server variant gets the server type and token page", () => {
      expect(core.withVariant("jira", "jira_server", { a: 1 })).toEqual({ a: 1, type: "server" })
      expect(core.withVariant("jira", "cloud", { a: 1 })).toEqual({ a: 1 })
      expect(creds.tokenUrl("jira", "jira_server")).toBeNull()
    })

    test("state writes are atomic and private", () => {
      const file = path.join(tmp, "atomic.json")
      core.writeJson(file, { a: 1 }, 0o600)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.readdirSync(tmp).filter((f) => f.endsWith(".tmp"))).toEqual([])
    })

    test("sync reads a detected Jira credential through the connect path", async () => {
      real()
      const cfg = path.join(home, ".config/.jira")
      fs.mkdirSync(cfg, { recursive: true })
      fs.writeFileSync(path.join(cfg, ".config.yml"), "server: https://acme.atlassian.net\nlogin: me@acme.com\n")
      process.env.ATLASSIAN_API_TOKEN = GOOD
      try {
        expect(await core.collectConfig("jira", undefined)).toEqual({ config: { jiraDomain: "acme", jiraEmail: "me@acme.com", jiraApiToken: GOOD } })
        delete process.env.ATLASSIAN_API_TOKEN
        expect(await core.collectConfig("jira", undefined)).toEqual({ reason: "Missing: API token" })
      } finally {
        delete process.env.ATLASSIAN_API_TOKEN
      }
    })

    test("detected credentials are used without typing", async () => {
      fake("gh", '[ "$2" = token ] && echo ' + GOOD)
      const r = await creds.connectCredentials({ id: "github", localOnly: true })
      expect([r.status, r.account]).toEqual(["connected", "octo"])
      expect(core.loadStore().providers.github?.source).toEqual({ kind: "cli", label: "gh CLI" })
    })

    test("a rejected token stores nothing", async () => {
      await token("github", "github_token", "bad_token_0000")
      const r = await creds.connectCredentials({ id: "github", localOnly: true })
      expect([r.status, r.sync]).toEqual(["rejected", "local"])
      expect(r.message).toContain("GitHub rejected the token (401)")
      expect(core.loadStore().providers.github?.registered).toBeUndefined()
      expect(await core.readSecret("github")).toBeUndefined()
      expect(await core.readSecret(core.secretKey("draft", "github", "github_token"))).toBeUndefined()
      expect(core.status().providers[0].state).toBe("not_found")
    })

    test("a rejected token does not linger to override what is detected", async () => {
      await token("github", "github_token", "bad_token_0000")
      expect((await creds.connectCredentials({ id: "github", localOnly: true })).status).toBe("rejected")
      fake("gh", '[ "$2" = token ] && echo ' + GOOD)
      const r = await creds.connectCredentials({ id: "github", localOnly: true })
      expect([r.status, r.account]).toEqual(["connected", "octo"])
    })

    test("keep local on a connection that exists only in the workspace removes that copy and holds sync", async () => {
      real()
      api.seed({ name: `GitHub (from ${os.hostname()})`, integration_id: "github", is_valid: false })
      await token("github", "github_token")
      const r = await creds.connectCredentials({ id: "github", localOnly: true })
      expect([r.status, r.sync]).toEqual(["connected", "local"])
      expect(api.state.rows.filter((x) => !x.deleted)).toHaveLength(0)
      const p = (await core.statusRemote()).providers[0]
      expect([p.state, p.sync]).toEqual(["connected", "blocked"])
    })

    test("update with local-only keeps a synced connection local instead of uploading", async () => {
      real()
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github" })
      await token("github", "github_token")
      const r = await creds.connectCredentials({ id: "github", update: true, localOnly: true })
      expect([r.status, r.sync]).toEqual(["connected", "local"])
      expect(synced().map((c) => c.method)).toEqual(["POST", "DELETE"])
      expect(core.isBlocked("github")).toBe(true)
    })

    test("sync is held before the workspace copy is removed, and stays held when the removal fails", async () => {
      real()
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github" })
      let heldAtDelete = null as boolean | null
      const original = backend.deleteConnection
      const spy = spyOn(backend, "deleteConnection").mockImplementation(async (cfg, id) => {
        heldAtDelete = core.isBlocked("github")
        return original(cfg, id)
      })
      try {
        await token("github", "github_token")
        expect((await creds.connectCredentials({ id: "github", localOnly: true })).status).toBe("connected")
        expect(heldAtDelete).toBe(true)
      } finally {
        spy.mockRestore()
      }
      await core.setBlocked(["github"], false)
      const failing = spyOn(backend, "deleteConnection").mockRejectedValue(new Error("boom"))
      try {
        await creds.connectCredentials({ id: "github" })
        await token("github", "github_token")
        const r = await creds.connectCredentials({ id: "github", localOnly: true })
        expect([r.status, r.sync, core.isBlocked("github")]).toEqual(["failed", "synced", true])
        expect(r.message).toContain("could not be removed from the workspace")
        expect(await core.readSecret("github")).toBeTruthy()
      } finally {
        failing.mockRestore()
      }
    })

    test("a draft that cannot be cleared on Keep local still removes the workspace copy, and says so", async () => {
      real()
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github" })
      await token("github", "github_token")
      const original = core.deleteSecret
      const spy = spyOn(core, "deleteSecret").mockImplementation(async (key: string) => {
        if (key.startsWith("draft")) throw new Error("exit 51")
        return original(key)
      })
      try {
        const r = await creds.connectCredentials({ id: "github", localOnly: true })
        expect([r.status, r.sync, core.loadStore().providers.github?.synced]).toEqual(["connected", "local", false])
        expect(r.message).toContain("What was entered could not be cleared from this machine: exit 51")
        expect(api.state.rows.filter((row: any) => !row.deleted)).toEqual([])
      } finally {
        spy.mockRestore()
      }
    })

    test("a record that cannot be written after the upload says the workspace has the connection, and connecting again updates it", async () => {
      real()
      await token("github", "github_token")
      const rename = fs.renameSync
      const spy = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
        if (String(to).endsWith("integrations.json")) throw new Error("disk full")
        return rename(from, to)
      }) as any)
      try {
        const r = await creds.connectCredentials({ id: "github" })
        expect([r.status, r.sync]).toEqual(["failed", "synced"])
        expect(r.message).toContain("Saved to your workspace, but the record on this machine could not be written (disk full)")
        expect(r.message).toContain("Connect again")
      } finally {
        spy.mockRestore()
      }
      const create = spyOn(backend, "createConnection")
      try {
        await token("github", "github_token")
        const r = await creds.connectCredentials({ id: "github" })
        expect([r.status, r.sync]).toEqual(["connected", "synced"])
        expect(create).not.toHaveBeenCalled()
      } finally {
        create.mockRestore()
      }
    })

    test("an MCP env value that is only an unresolved reference does not count as a token", () => {
      expect(creds.mcpEnvHasToken("github", { GITHUB_TOKEN: "${MISSING_TOKEN}" })).toBe(false)
      expect(creds.mcpEnvHasToken("github", { GITHUB_TOKEN: " $MISSING_TOKEN " })).toBe(false)
      expect(creds.mcpEnvHasToken("github", { GITHUB_TOKEN: "ghp_real" })).toBe(true)
    })

    test("a local cleanup that fails after the upload is a warning on a connected result, and the record says synced", async () => {
      real()
      await core.storeSecret("github", "leftover_token")
      await token("github", "github_token")
      const rename = fs.renameSync
      const spy = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
        if (String(to).endsWith("integrations-secrets.json")) throw new Error("disk full")
        return rename(from, to)
      }) as any)
      try {
        const r = await creds.connectCredentials({ id: "github" })
        expect([r.status, r.sync]).toEqual(["connected", "synced"])
        expect(r.message).toContain("local copy of the credential could not be removed: disk full")
      } finally {
        spy.mockRestore()
      }
      expect(core.isSynced("github")).toBe(true)
    })

    test("Keep local removes nothing from the workspace when the local copy cannot be stored", async () => {
      real()
      api.seed({ name: `GitHub (from ${os.hostname()})`, integration_id: "github" })
      await token("github", "github_token")
      const del = spyOn(backend, "deleteConnection")
      const store = spyOn(core, "storeSecret").mockRejectedValue(new Error("keychain locked"))
      try {
        const r = await creds.connectCredentials({ id: "github", localOnly: true })
        expect([r.status, r.message]).toEqual(["failed", "keychain locked"])
        expect(del).not.toHaveBeenCalled()
        expect(api.state.rows.filter((x) => !x.deleted)).toHaveLength(1)
        expect(core.isBlocked("github")).toBe(false)
        expect(core.loadStore().providers.github?.registered).toBeUndefined()
      } finally {
        store.mockRestore()
        del.mockRestore()
      }
    })

    test("a local connect that fails part way restores the secrets it wrote", async () => {
      await core.storeSecret(core.secretKey("cred", "jira", "jiraApiToken"), "old-token")
      await creds.setDraft("jira", "jiraDomain", "acme")
      await creds.setDraft("jira", "jiraEmail", "me@acme.com")
      await token("jira", "jiraApiToken")
      const original = core.storeSecret
      let calls = 0
      const store = spyOn(core, "storeSecret").mockImplementation(async (id: string, secret: string) => {
        if (++calls === 2) throw new Error("keychain locked")
        return original(id, secret)
      })
      try {
        const r = await creds.connectCredentials({ id: "jira", localOnly: true })
        expect(r.status).toBe("failed")
      } finally {
        store.mockRestore()
      }
      expect(await core.readSecret(core.secretKey("cred", "jira", "jiraApiToken"))).toBe("old-token")
    })

    test("a catalog that omits the secret flags still treats the built-in secret fields as secret", () => {
      const parsed = creds.parseCatalog([{ id: "github", config: [{ name: "github_token", required: true }, { name: "note" }] }])
      expect(parsed.github![0].fields.map((f) => [f.name, f.secret])).toEqual([["github_token", true], ["note", false]])
    })

    test("a Jira variant naming the server is validated as the server", async () => {
      const v = await creds.validate("jira", "jira_server", { jiraBaseUrl: base(), jiraPatToken: GOOD })
      expect([v.ok, v.account]).toEqual([true, "Server Me"])
    })

    test("a refused replacement of a non-secret field leaves the working connection alone", async () => {
      await creds.setDraft("jira", "jiraDomain", "acme")
      await creds.setDraft("jira", "jiraEmail", "me@acme.com")
      await token("jira", "jiraApiToken")
      expect((await creds.connectCredentials({ id: "jira", localOnly: true })).status).toBe("connected")
      await creds.setDraft("jira", "jiraEmail", "other@acme.com")
      expect((await creds.connectCredentials({ id: "jira", update: true })).status).toBe("rejected")
      const p = core.status().providers[1]
      expect([p.state, core.loadStore().providers.jira?.rejected]).toEqual(["connected", false])
      expect(core.loadStore().providers.jira?.values?.jiraEmail).toBe("me@acme.com")
    })

    test("keep local stores a credential unverified when the provider is unreachable; connect stores nothing", async () => {
      const down = Bun.serve({ port: 0, fetch: () => new Response("down", { status: 503 }) })
      process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = `http://127.0.0.1:${down.port}`
      try {
        real()
        await token("github", "github_token")
        const failed = await creds.connectCredentials({ id: "github" })
        expect([failed.status, failed.message]).toEqual(["failed", "GitHub answered 503"])
        expect([core.loadStore().providers.github?.registered, synced()]).toEqual([undefined, []])
        const r = await creds.connectCredentials({ id: "github", localOnly: true })
        expect([r.status, r.sync, r.account]).toEqual(["connected", "local", null])
        expect(r.message).toContain("not verified yet")
        const p = core.status().providers[0]
        expect([p.state, p.note]).toEqual(["connected", "not verified yet, the provider could not be reached"])
        expect(await core.readSecret("github")).toBeTruthy()
      } finally {
        down.stop(true)
        process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = base()
      }
      await token("github", "github_token")
      expect((await creds.connectCredentials({ id: "github", update: true })).status).toBe("connected")
      expect(core.loadStore().providers.github?.unverified).toBe(false)
    })

    test("a connect whose record changed while the credential was being checked stores nothing", async () => {
      real()
      for (const localOnly of [true, false]) {
        await token("github", "github_token")
        onUser = () => core.saveStore({ blocked: {}, providers: { github: { registered: true, synced: false, variant: "token", validatedAt: "2030-01-01T00:00:00Z" } } })
        const before = calls.length
        const r = await creds.connectCredentials({ id: "github", localOnly })
        expect([r.status, r.message]).toEqual(["failed", "The connection changed while it was being checked, run it again."])
        expect(synced()).toEqual([])
        expect(await core.readSecret(core.secretKey("cred", "github", "github_token"))).toBeUndefined()
        expect(calls.slice(before).some((c) => c.method !== "GET" && c.path.startsWith("/connections"))).toBe(false)
        onUser = null
        core.saveStore({ blocked: {}, providers: {} })
        await creds.discardDrafts("github")
      }
    })

    test("a connect prepared from an earlier credential is refused when the credential was saved again meanwhile", async () => {
      real()
      await token("github", "github_token")
      expect((await creds.connectCredentials({ id: "github", localOnly: true })).status).toBe("connected")
      const first = core.loadStore().providers.github!
      await token("github", "github_token")
      onUser = () => core.updateStore((st) => void (st.providers.github = { ...st.providers.github, credentialStamp: "saved-elsewhere" }))
      const r = await creds.connectCredentials({ id: "github", localOnly: true })
      onUser = null
      expect(r.status).toBe("failed")
      expect(r.message).toBe("The connection changed while it was being checked, run it again.")
      expect(core.loadStore().providers.github!.credentialStamp).toBe("saved-elsewhere")
      expect(first.credentialStamp).toBeDefined()
      core.saveStore({ blocked: {}, providers: {} })
      await creds.discardDrafts("github")
    })

    test("a local save whose old secrets cannot be purged is still saved, and says what is left", async () => {
      real()
      await token("github", "github_token")
      const purge = spyOn(core, "purgeCredentialSecrets").mockRejectedValue(new Error("keychain locked"))
      try {
        const r = await creds.connectCredentials({ id: "github", localOnly: true })
        expect([r.status, r.sync]).toEqual(["connected", "local"])
        expect(r.message).toContain("The previous credential could not be removed from this machine: keychain locked")
        expect(core.loadStore().providers.github?.registered).toBe(true)
        expect(await core.readSecret(core.secretKey("cred", "github", "github_token"))).toBe(GOOD)
      } finally {
        purge.mockRestore()
      }
    })

    test("an offline re-save of the same stored token keeps its known expiry; a new token does not inherit it", async () => {
      real()
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github", localOnly: true })
      const known = "2031-01-02T03:04:05.000Z"
      expect(core.loadStore().providers.github?.expiresAt).toBe(known)
      const down = Bun.serve({ port: 0, fetch: () => new Response("down", { status: 503 }) })
      process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = `http://127.0.0.1:${down.port}`
      try {
        const same = await creds.connectCredentials({ id: "github", localOnly: true })
        expect(same.message).toContain("not verified yet")
        expect(same.expiresAt).toBe(known)
        expect(core.loadStore().providers.github?.expiresAt).toBe(known)
        await token("github", "github_token", "another_token_c3d4")
        await creds.connectCredentials({ id: "github", localOnly: true })
        expect(core.loadStore().providers.github?.expiresAt ?? null).toBeNull()
      } finally {
        down.stop(true)
        process.env.ALTIMATE_INTEGRATIONS_GITHUB_API = base()
      }
    })

    test("a variant asked for by its exact id wins over one whose name contains it", async () => {
      catalog = [
        {
          id: "jira",
          config: [{ name: "jiraDomain", label: "Site", required: true }],
          additionalConfigVariants: [
            { id: "server-oauth-less", label: "Server extra", config: [{ name: "jiraBaseUrl", label: "URL", required: true }] },
            { id: "server", label: "Server", config: [{ name: "jiraBaseUrl", label: "URL", required: true }, { name: "jiraPatToken", label: "PAT", encrypted: true, required: true }] },
          ],
        },
      ]
      real()
      expect((await creds.resolve("jira", "server")).def.id).toBe("server")
    })

    test("a rejected input is not stored unverified", async () => {
      await creds.setDraft("jira", "jiraDomain", "acme")
      await creds.setDraft("jira", "jiraEmail", "me@acme.com")
      await token("jira", "jiraApiToken", "bad_token_0000")
      expect((await creds.connectCredentials({ id: "jira", localOnly: true })).status).toBe("rejected")
      await creds.setDraft("jira", "jiraDomain", "not a site!")
      await token("jira", "jiraApiToken")
      expect((await creds.connectCredentials({ id: "jira", localOnly: true })).status).toBe("failed")
      expect(core.loadStore().providers.jira?.registered).toBeUndefined()
    })

    test("a failed state write leaves no temp file behind", () => {
      const target = path.join(tmp, "is-a-directory")
      fs.mkdirSync(target)
      expect(() => core.writeJson(target, { a: 1 }, 0o600)).toThrow()
      expect(fs.readdirSync(tmp).filter((f) => f.endsWith(".tmp"))).toEqual([])
    })

    test("two processes updating the same state never lose an update", async () => {
      const counter = path.join(tmp, "counter.json")
      const src = path.join(import.meta.dir, "../../src/altimate/integrations/core.ts")
      const script = `const core = await import(${JSON.stringify(src)});
        for (let i = 0; i < 40; i++) await core.withLock(async () => { const n = core.readJson(${JSON.stringify(counter)}, { n: 0 }).n; await new Promise((r) => setTimeout(r, 2)); core.writeJson(${JSON.stringify(counter)}, { n: n + 1 }) })`
      const run = () => Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, ALTIMATE_INTEGRATIONS_DIR: tmp }, cwd: path.join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" })
      const procs = [run(), run()]
      const codes = await Promise.all(procs.map((p) => p.exited))
      expect(codes).toEqual([0, 0])
      expect(core.readJson(counter, { n: 0 }).n).toBe(80)
    }, 60_000)

    test("discard clears typed fields and pasted secrets", async () => {
      await token("github", "github_token")
      await creds.setDraft("jira", "jiraDomain", "acme")
      await token("jira", "jiraApiToken")
      real()
      catalog = [{ id: "jira", config: [{ name: "Site", key: "jiraDomain", type: "text", required: true }], additionalConfigVariants: [{ id: "extra", name: "Custom", config: [{ name: "Secret", key: "customSecret", type: "password", required: true }] }] }]
      await creds.loadCatalog("jira")
      await core.storeSecret(core.secretKey("draft", "jira", "customSecret"), "pasted_for_custom_field")
      await creds.discardDrafts("github")
      await creds.discardDrafts("jira")
      expect(await core.readSecret(core.secretKey("draft", "jira", "customSecret"))).toBeUndefined()
      expect(await core.readSecret(core.secretKey("draft", "github", "github_token"))).toBeUndefined()
      expect(await core.readSecret(core.secretKey("draft", "jira", "jiraApiToken"))).toBeUndefined()
      expect(core.loadStore().providers.jira?.drafts).toBeUndefined()
    })

    test("sync creates the managed connection with the catalog field names and keeps no secret locally", async () => {
      real()
      await creds.setDraft("jira", "jiraDomain", "acme")
      await creds.setDraft("jira", "jiraEmail", "me@acme.com")
      await token("jira", "jiraApiToken")
      const r = await creds.connectCredentials({ id: "jira" })
      expect([r.status, r.sync, r.account]).toEqual(["connected", "synced", "me@acme.com"])
      const sent = synced()
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ method: "POST", path: "/connections/" })
      expect(sent[0].body).toEqual({ name: `Jira (from ${os.hostname()})`, integration_id: "jira", config: { jiraDomain: "acme", jiraEmail: "me@acme.com", jiraApiToken: GOOD } })
      expect(await core.readSecret("jira")).toBeUndefined()
      expect(core.loadStore().providers.jira).toMatchObject({ registered: true, synced: true, connectionId: 21 })
    })

    test("jira server sends the variant type with its catalog fields", async () => {
      real()
      await creds.setDraft("jira", "jiraBaseUrl", base())
      await token("jira", "jiraPatToken")
      const r = await creds.connectCredentials({ id: "jira", variant: "server" })
      expect([r.status, r.sync]).toEqual(["connected", "synced"])
      expect(synced()[0].body.config).toEqual({ jiraBaseUrl: base(), jiraPatToken: GOOD, type: "server" })
    })

    test("a new connection the workspace marks invalid is removed and nothing is stored", async () => {
      real()
      api.state.valid = false
      await token("linear", "linearApiKey")
      const r = await creds.connectCredentials({ id: "linear" })
      expect([r.status, r.sync]).toEqual(["rejected", "local"])
      expect(r.message).toContain("refused")
      expect(synced().map((c) => c.method)).toEqual(["POST", "DELETE"])
      expect(api.state.rows.filter((x) => !x.deleted)).toHaveLength(0)
      expect(core.loadStore().providers.linear?.registered).toBeUndefined()
      expect(await core.readSecret(core.secretKey("draft", "linear", "linearApiKey"))).toBeUndefined()
      expect(await core.readSecret(core.secretKey("cred", "linear", "linearApiKey"))).toBeUndefined()
      expect(core.status().providers[2].state).not.toBe("connected")
    })

    test("a replacement the workspace marks invalid leaves the connection marked rejected until update fixes it", async () => {
      real()
      await token("linear", "linearApiKey")
      expect((await creds.connectCredentials({ id: "linear" })).status).toBe("connected")
      api.state.valid = false
      await token("linear", "linearApiKey")
      const bad = await creds.connectCredentials({ id: "linear", update: true })
      expect([bad.status, bad.sync]).toEqual(["rejected", "synced"])
      expect(bad.message).toContain("marked it invalid")
      expect(api.state.rows.filter((x) => !x.deleted)).toHaveLength(1)
      expect(await core.readSecret(core.secretKey("draft", "linear", "linearApiKey"))).toBeUndefined()
      expect(core.status().providers[2].state).toBe("rejected")
      api.state.valid = true
      await token("linear", "linearApiKey")
      expect((await creds.connectCredentials({ id: "linear", update: true })).status).toBe("connected")
      expect(synced().map((c) => c.method)).toEqual(["POST", "PATCH", "PATCH"])
      expect(core.status().providers[2].state).toBe("connected")
    })

    test("a backend refusal is reported as message (code)", async () => {
      real()
      api.state.fail = { status: 422, body: { detail: [{ loc: ["body", "config", "jiraEmail"], msg: "Email is not a valid email address", type: "value_error.format" }] } }
      await token("linear", "linearApiKey")
      const r = await creds.connectCredentials({ id: "linear" })
      expect([r.status, r.message]).toEqual(["failed", "Email is not a valid email address (value_error.format)"])
      expect(core.loadStore().providers.linear?.registered).toBeUndefined()
    })

    test("signed out, or blocked, behaves as local-only and says so", async () => {
      await token("github", "github_token")
      const r = await creds.connectCredentials({ id: "github" })
      expect([r.status, r.sync, r.message]).toEqual(["connected", "local", "Not signed in to Altimate, kept local."])
      await core.setBlocked(["linear"], true)
      real()
      await token("linear", "linearApiKey")
      const b = await creds.connectCredentials({ id: "linear" })
      expect([b.sync, synced().length]).toEqual(["local", 0])
    })

    test("update needs a connection and keeps a local connection local", async () => {
      real()
      expect((await creds.connectCredentials({ id: "github", update: true })).code).toBe("not_connected")
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github", localOnly: true })
      await token("github", "github_token")
      const r = await creds.connectCredentials({ id: "github", update: true })
      expect([r.status, r.sync, synced().length]).toEqual(["connected", "local", 0])
    })

    test("update of a synced connection updates the same connection in place", async () => {
      real()
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github" })
      await token("github", "github_token")
      const r = await creds.connectCredentials({ id: "github", update: true })
      expect([r.status, r.sync]).toEqual(["connected", "synced"])
      const [first, second] = synced()
      expect([first.method, first.path, second.method, second.path]).toEqual(["POST", "/connections/", "PATCH", "/connections/21"])
      expect(second.body).toEqual({ config: { github_token: GOOD, expires_at: "2031-01-02T03:04:05.000Z" } })
      expect(api.state.rows).toHaveLength(1)
    })

    test("a credential kept local is never uploaded until sync is allowed", async () => {
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github", localOnly: true })
      real()
      expect((await core.syncProvider("github")).result).toBe("kept_local")
      expect(synced()).toEqual([])
      await core.setBlocked(["github"], false)
      const o = await core.syncProvider("github")
      expect(o.result).toBe("synced")
      expect(synced()[0].body.config).toEqual({ github_token: GOOD, expires_at: "2031-01-02T03:04:05.000Z" })
    })

    test("signed out, sync does not pretend to reach the workspace", async () => {
      delete process.env.ALTIMATE_INTEGRATIONS_MOCK
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github" })
      const o = await core.syncProvider("github")
      expect([o.result, o.reason]).toEqual(["skipped", core.NOT_SIGNED_IN])
      expect(core.status().providers[0].sync).toBe("local")
      expect(fs.existsSync(path.join(tmp, "integrations-remote-mock.json"))).toBe(false)
    })

    test("keeping a synced connection local removes the workspace copy and holds sync", async () => {
      real()
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github" })
      expect(api.state.rows.filter((r) => !r.deleted)).toHaveLength(1)
      await token("github", "github_token")
      const r = await creds.connectCredentials({ id: "github", localOnly: true })
      expect([r.status, r.sync]).toEqual(["connected", "local"])
      expect(api.state.rows.filter((x) => !x.deleted)).toHaveLength(0)
      expect(await core.readSecret(core.secretKey("cred", "github", "github_token"))).toBe(GOOD)
      const s = await core.statusRemote()
      expect([s.providers[0].state, s.providers[0].sync]).toEqual(["connected", "blocked"])
      expect(await core.readSecret("github")).toBeTruthy()
    })

    test("keeping a synced connection local while signed out changes nothing", async () => {
      real()
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github" })
      mock()
      delete process.env.ALTIMATE_INTEGRATIONS_MOCK
      await token("github", "github_token")
      const r = await creds.connectCredentials({ id: "github", localOnly: true })
      expect(r.status).toBe("failed")
      expect(core.loadStore().providers.github?.synced).toBe(true)
      expect(core.isBlocked("github")).toBe(false)
    })

    test("a synced connection cannot be blocked: there is no local copy to keep", async () => {
      real()
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github" })
      expect(core.isSynced("github")).toBe(true)
      expect(core.isSynced("jira")).toBe(false)
    })

    test("a remote-only managed connection can be updated", async () => {
      real()
      api.seed({ name: `GitHub (from ${os.hostname()})`, integration_id: "github", is_valid: false })
      await token("github", "github_token")
      const r = await creds.connectCredentials({ id: "github", update: true })
      expect([r.status, r.sync]).toEqual(["connected", "synced"])
      expect(synced().map((c) => c.method)).toEqual(["PATCH"])
      expect(api.state.rows).toHaveLength(1)
    })

    test("Keep local on a connection only the workspace holds refuses when the workspace cannot be read", async () => {
      real()
      api.seed({ name: `GitHub (from ${os.hostname()})`, integration_id: "github" })
      api.state.listFails = true
      await token("github", "github_token")
      const r = await creds.connectCredentials({ id: "github", localOnly: true })
      expect(r.status).toBe("failed")
      expect(r.message).toContain("Could not check your workspace")
      expect(core.loadStore().providers.github?.registered).toBeUndefined()
      expect(core.isBlocked("github")).toBe(false)
      expect(api.state.rows.filter((x) => !x.deleted)).toHaveLength(1)
    })

    test("Keep local on a connection only the workspace holds removes it and keeps the secret here", async () => {
      real()
      api.seed({ name: `GitHub (from ${os.hostname()})`, integration_id: "github" })
      await token("github", "github_token")
      const r = await creds.connectCredentials({ id: "github", localOnly: true })
      expect([r.status, r.sync]).toEqual(["connected", "local"])
      expect(api.state.rows.filter((x) => !x.deleted)).toHaveLength(0)
      expect(core.isBlocked("github")).toBe(true)
      expect(await core.readSecret("github")).toBeTruthy()
    })

    test("Keep local on a local record finds a workspace copy uploaded after it was recorded", async () => {
      real()
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github", localOnly: true })
      await core.setBlocked(["github"], false)
      api.seed({ name: `GitHub (from ${os.hostname()})`, integration_id: "github" })
      await token("github", "github_token")
      const r = await creds.connectCredentials({ id: "github", localOnly: true })
      expect([r.status, r.sync]).toEqual(["connected", "local"])
      expect(api.state.rows.filter((x) => !x.deleted)).toHaveLength(0)
      expect(core.isBlocked("github")).toBe(true)
    })

    test("a workspace refusal keeps typed non-secret values and drops secret drafts", async () => {
      real()
      api.state.valid = false
      await creds.setDraft("jira", "jiraDomain", "acme")
      await creds.setDraft("jira", "jiraEmail", "me@acme.com")
      await token("jira", "jiraApiToken")
      const r = await creds.connectCredentials({ id: "jira" })
      expect(r.status).toBe("rejected")
      expect(core.loadStore().providers.jira?.drafts).toEqual({ jiraDomain: "acme", jiraEmail: "me@acme.com" })
      expect(await core.readSecret(core.secretKey("draft", "jira", "jiraApiToken"))).toBeUndefined()
    })

    test("a clipboard URL is not taken as a token", async () => {
      await expect(creds.setSecretDraft("github", "github_token", { kind: "clipboard" }, clip("https://github.com/settings/tokens"))).rejects.toThrow("Clipboard doesn't contain a token")
    })

    test("a failed upload keeps the local secret", async () => {
      real()
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github", localOnly: true })
      await core.setBlocked(["github"], false)
      api.state.fail = { status: 500, body: { detail: "boom" } }
      const o = await core.syncProvider("github")
      expect(o.result).toBe("failed")
      expect(await core.readSecret("github")).toBeTruthy()
    })

    test("a failed update of a credential the workspace holds says it is still synced", async () => {
      real()
      await token("github", "github_token")
      expect((await creds.connectCredentials({ id: "github" })).sync).toBe("synced")
      await token("github", "github_token")
      api.state.fail = { status: 500, body: { detail: "boom" } }
      const r = await creds.connectCredentials({ id: "github", update: true })
      expect([r.status, r.sync, core.loadStore().providers.github?.synced]).toEqual(["failed", "synced", true])
    })

    test("connect to a shared workspace attaches only with --share, and an update of an attached connection says it is shared", async () => {
      real()
      const getDatamate = spyOn(backend, "getDatamate").mockResolvedValue({ id: "5", name: "WS", is_owner: true, privacy: "public", integrations: [] } as any)
      const spies = [
        spyOn(workspaceState, "resolveBindingOutcome").mockResolvedValue({ status: "bound", binding: { datamateId: 5, datamateName: "WS" } } as any),
        spyOn(backend, "integrationsCatalog").mockResolvedValue([{ id: "github", tools: [] }] as any),
        getDatamate,
      ]
      const update = spyOn(backend, "updateDatamateIntegrations").mockResolvedValue(undefined as any)
      try {
        await token("github", "github_token")
        const refused = await creds.connectCredentials({ id: "github" })
        expect([refused.status, refused.sync, refused.shared, refused.message]).toEqual(["connected", "synced", undefined, core.ATTACH_FAILED_PREFIX + core.SHARED_WORKSPACE_REFUSAL("WS", "github")])
        expect(update).not.toHaveBeenCalled()
        // The command the refusal names attaches the connection already saved to the account.
        const viaSync = await core.syncProvider("github", undefined, 0, true, true)
        expect([viaSync.result, viaSync.shared]).toEqual(["synced", true])
        expect(update).toHaveBeenCalledTimes(1)
        await token("github", "github_token")
        const shared = await creds.connectCredentials({ id: "github", update: true, share: true })
        expect([shared.status, shared.shared]).toEqual(["connected", true])
        expect(shared.message).toContain("its members can use this connection")
        expect(update).toHaveBeenCalledTimes(2)
        // Attaching widened the connection, as the backend does: its new credential reaches the members too, so an update needs --share again.
        const id = core.loadStore().providers.github!.connectionId
        api.state.rows.find((r) => r.id === id)!.privacy = "public"
        getDatamate.mockResolvedValue({ id: "5", name: "WS", is_owner: true, privacy: "public", integrations: [{ id: "github", tools: [], connection_id: String(id) }] } as any)
        await token("github", "github_token")
        const config = api.state.rows.find((r) => r.id === id)!.config
        const refusedUpdate = await creds.connectCredentials({ id: "github", update: true })
        expect([refusedUpdate.status, refusedUpdate.sync, refusedUpdate.message]).toEqual(["failed", "synced", core.SHARED_CONNECTION_REFUSAL("github", "update")])
        expect(api.state.rows.find((r) => r.id === id)!.config).toBe(config)
        const again = await creds.connectCredentials({ id: "github", update: true, share: true })
        expect([again.status, again.shared]).toEqual(["connected", true])
        expect(again.message).toContain("its members can use this connection")
      } finally {
        for (const sp of [...spies, update]) sp.mockRestore()
      }
    })

    test("a connection shared outside any workspace is not rewritten without --share, and with it says so", async () => {
      real()
      await token("github", "github_token")
      expect((await creds.connectCredentials({ id: "github" })).shared).toBeUndefined()
      const row = api.state.rows.find((r) => !r.deleted)!
      // Missing privacy counts as shared, as it does for workspaces.
      for (const privacy of ["public", "restricted", undefined]) {
        row.privacy = privacy
        const config = row.config
        await token("github", "github_token")
        const r = await creds.connectCredentials({ id: "github", update: true })
        expect([r.status, r.sync, r.shared, r.message]).toEqual(["failed", "synced", undefined, core.SHARED_CONNECTION_REFUSAL("github", "update")])
        expect(row.config).toBe(config)
        // Nothing to upload: the attach-only sync changes nothing, but no longer calls the connection private.
        const s = await core.syncProvider("github", undefined, 0, true)
        expect([s.result, s.shared]).toEqual(["synced", true])
        expect(row.config).toBe(config)
      }
      row.privacy = "public"
      api.state.valid = false
      await token("github", "github_token")
      const invalid = await creds.connectCredentials({ id: "github", update: true, share: true })
      expect([invalid.status, invalid.shared]).toEqual(["rejected", true])
      expect(invalid.message).toContain(core.SHARED_REWRITE_NOTE)
      api.state.valid = true
      const rename = fs.renameSync
      const disk = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
        if (String(to).endsWith("integrations.json")) throw new Error("disk full")
        return rename(from, to)
      }) as any)
      try {
        await token("github", "github_token")
        const unrecorded = await creds.connectCredentials({ id: "github", update: true, share: true })
        expect([unrecorded.status, unrecorded.shared]).toEqual(["failed", true])
        expect(unrecorded.message).toContain(core.SHARED_REWRITE_NOTE)
        // Rejected and then unrecorded: the failure still says who has the new credential.
        api.state.valid = false
        await token("github", "github_token")
        const both = await creds.connectCredentials({ id: "github", update: true, share: true })
        expect([both.status, both.shared]).toEqual(["failed", true])
        expect(both.message).toContain(core.SHARED_REWRITE_NOTE)
        api.state.valid = true
      } finally {
        disk.mockRestore()
      }
      await token("github", "github_token")
      const shared = await creds.connectCredentials({ id: "github", update: true, share: true })
      expect([shared.status, shared.shared]).toEqual(["connected", true])
      expect(shared.message).toContain(core.SHARED_CONNECTION_AUDIENCE)
    })

    test("a hand-made connection cannot be updated from here", async () => {
      real()
      api.seed({ name: "Hand made", integration_id: "github", is_valid: false })
      await token("github", "github_token")
      expect((await creds.connectCredentials({ id: "github", update: true })).code).toBe("not_connected")
    })

    test("a workspace connection removed elsewhere stops reading as synced", async () => {
      real()
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github" })
      api.state.rows.forEach((r) => (r.deleted = true))
      const p = (await core.statusRemote()).providers[0]
      expect([p.state, p.sync]).toEqual(["not_found", "local"])
    })

    test("disconnect while signed out refuses when the credential is saved in the workspace", async () => {
      real()
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github" })
      delete process.env.ALTIMATE_INTEGRATIONS_TOKEN
      await expect(core.disconnect("github")).rejects.toThrow("Sign in to Altimate")
      expect(core.loadStore().providers.github?.registered).toBe(true)
    })

    test("disconnect removes the credential secrets", async () => {
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github", localOnly: true })
      await core.disconnect("github")
      expect(await core.readSecret(core.secretKey("cred", "github", "github_token"))).toBeUndefined()
      expect(await core.readSecret("github")).toBeUndefined()
    })
  })

  describe("rejected status", () => {
    test("a refused replacement leaves the working connection alone", async () => {
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github", localOnly: true })
      await token("github", "github_token", "bad_token_0000")
      expect((await creds.connectCredentials({ id: "github", update: true })).status).toBe("rejected")
      expect(core.status().providers[0].state).toBe("connected")
      expect(await core.readSecret("github")).toBeTruthy()
      expect(await core.readSecret(core.secretKey("draft", "github", "github_token"))).toBeUndefined()
    })

    test("a stored credential the provider now refuses is rejected until it is updated", async () => {
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github", localOnly: true })
      await core.storeSecret(core.secretKey("cred", "github", "github_token"), "bad_token_0000")
      expect((await creds.connectCredentials({ id: "github", update: true })).status).toBe("rejected")
      const p = core.status().providers[0]
      expect([p.state, p.note, p.account]).toEqual(["rejected", "Token rejected, update it", "octo"])
      await token("github", "github_token")
      expect((await creds.connectCredentials({ id: "github", update: true })).status).toBe("connected")
      expect(core.status().providers[0].state).toBe("connected")
    })

    test("a workspace connection marked invalid is rejected", async () => {
      real()
      api.seed({ name: `GitHub (from ${os.hostname()})`, integration_id: "github", is_valid: false })
      api.seed({ name: "Hand made", integration_id: "jira", last_validated_at: "2030-01-01T00:00:00Z" })
      api.seed({ name: "Teammate", integration_id: "linear", is_owner: false })
      const s = await core.statusRemote()
      expect(s.providers.map((p) => [p.id, p.state, p.note])).toEqual([
        ["github", "rejected", "Token rejected, update it"],
        ["jira", "connected", null],
        ["linear", "not_found", null],
      ])
      expect(calls.find((c) => c.path === "/connections/")?.query).toBe("?include_shared=false")
    })
  })

  test("the CLI shows the credential commands and no browser flow", () => {
    const cli = path.join(import.meta.dir, "../../src/index.ts")
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, "run", cli, "integrations", ...args], { env: { ...process.env, PATH: saved.PATH, ALTIMATE_INTEGRATIONS_DIR: tmp, ALTIMATE_INTEGRATIONS_MOCK: "1", ALTIMATE_INTEGRATIONS_HOME: home }, stdout: "pipe", stderr: "pipe" })
    const fields = run("fields", "linear", "--json")
    expect(JSON.parse(fields.stdout.toString()).variant).toBe("key")
    expect(JSON.parse(run("status", "--json").stdout.toString()).workspace.signedIn).toBe(true)
    expect(run("expire", "github").exitCode).not.toBe(0)
    const help = run("connect", "--help")
    const text = help.stderr.toString() + help.stdout.toString()
    expect(text).toContain("--local-only")
    for (const flag of ["--oauth", "--reauth", "--frontend"]) expect(text).not.toContain(flag)
    expect(JSON.parse(run("block", "--json").stdout.toString())).toMatchObject({ status: "failed" })
    const bad = run("set", "linear", "linearApiKey", "x", "--json")
    expect(JSON.parse(bad.stdout.toString())).toMatchObject({ status: "failed" })
    expect(bad.stdout.toString()).toContain("is a secret")
    expect(run("open-token-page", "jira", "--variant", "server", "--no-open", "--json").stdout.toString()).toContain("no token page")
  }, 60_000)
})

describe("catalog fields a person fills in", () => {
  test("skips backend bookkeeping, repeated fields and browser sign-in variants", () => {
    const catalog = creds.parseCatalog([
      {
        id: "linear",
        config: [
          { key: "linearApiKey", name: "Linear API Key", encrypted: true },
          { key: "expires_at", name: "Expires at" },
          { key: "auth_type", name: "Auth type" },
          { key: "expires_at", name: "Expires at" },
        ],
      },
      {
        id: "jira",
        config: [
          { key: "jiraDomain", name: "Domain:" },
          { key: "jiraEmail", name: "Email" },
          { key: "jiraApiToken", name: "Api Key", encrypted: true },
        ],
        additionalConfigVariants: [
          { id: "oauth", type: "oauth", config: [{ key: "jiraOAuthAccessToken", encrypted: true }] },
          { id: "server", config: [{ key: "jiraBaseUrl", name: "Base URL" }, { key: "jiraPatToken", encrypted: true }] },
        ],
      },
    ])
    expect(catalog.linear?.[0]?.fields.map((f) => f.name)).toEqual(["linearApiKey"])
    expect(catalog.jira?.map((v) => v.id)).toEqual(["cloud", "server"])
    expect(catalog.jira?.[0]?.fields.find((f) => f.name === "jiraDomain")?.label).toEqual("Domain")
  })
})

describe("attachToIntegrations", () => {
  const keys = ["get_file", "list_issues", "search_code", "delete_file", "create_repository"]
  test("adds a missing entry with read-only tools only", () => {
    const out = core.attachToIntegrations([{ id: "jira", tools: [{ key: "x" }], connection_id: null }], "github", 7, keys)
    expect(out[0]).toEqual({ id: "jira", tools: [{ key: "x" }], connection_id: null })
    expect(out[1]).toEqual({ id: "github", tools: [{ key: "get_file" }, { key: "list_issues" }, { key: "search_code" }], connection_id: "7" })
  })
  test("sets the connection on an existing entry and extends a connection list", () => {
    const other = { id: "linear", tools: [], connection_id: "1", connection_ids: null, extra: true }
    const out = core.attachToIntegrations([{ id: "jira", tools: [{ key: "t" }], connection_id: null, connection_ids: ["3"] }, other], "jira", 9, keys)
    expect(out[0]).toEqual({ id: "jira", tools: [{ key: "t" }], connection_id: "9", connection_ids: ["3", "9"] })
    expect(out[1]).toBe(other)
  })
})

describe("attach keeps another connection", () => {
  test("an entry on another connection keeps it, an empty one or this one is set", () => {
    const keys: string[] = []
    const other = core.attachToIntegrations([{ id: "jira", tools: [], connection_id: "3" }], "jira", 9, keys)
    expect(other[0].connection_id).toBe("3")
    expect(core.attachToIntegrations([{ id: "jira", tools: [], connection_id: null }], "jira", 9, keys)[0].connection_id).toBe("9")
    expect(core.attachToIntegrations([{ id: "jira", tools: [], connection_id: "9" }], "jira", 9, keys)[0].connection_id).toBe("9")
    const shared = core.attachToIntegrations([{ id: "jira", tools: [], connection_id: "3", connection_ids: ["3"] }], "jira", 9, keys)[0]
    expect([shared.connection_id, shared.connection_ids]).toEqual(["3", ["3", "9"]])
  })
  test("an entry on a connection that no longer exists takes this one", () => {
    const gone = core.attachToIntegrations([{ id: "jira", tools: [], connection_id: "3" }], "jira", 9, [], [9, 4])
    expect(gone[0].connection_id).toBe("9")
    const live = core.attachToIntegrations([{ id: "jira", tools: [], connection_id: "3" }], "jira", 9, [], [9, 3])
    expect(live[0].connection_id).toBe("3")
  })
  test("an entry on a connection shared by another member is kept; a deleted one is taken over, with its id dropped from the list", async () => {
    const entry = { id: "jira", tools: [], connection_id: "3", connection_ids: ["3", "4"] }
    const updates: any[] = []
    const spies = [
      spyOn(workspaceState, "resolveBindingOutcome").mockResolvedValue({ status: "bound", binding: { datamateId: 5, datamateName: "WS" } } as any),
      spyOn(backend, "getDatamate").mockResolvedValue({ id: "5", name: "WS", is_owner: true, privacy: "private", integrations: [entry] } as any),
      spyOn(backend, "updateDatamateIntegrations").mockImplementation((async (_c: any, _id: any, list: any) => void updates.push(list)) as any),
    ]
    const listing = (ids: Array<[number, boolean]>) => spyOn(backend, "listVisibleConnections").mockResolvedValue(ids.map(([id, own]) => ({ id, is_owner: own })) as any)
    try {
      const cfg = { url: "http://x", tenant: "t", token: "k" } as any
      let list = listing([[3, false], [4, true], [9, true]])
      expect(await core.attachToBoundWorkspace(cfg, "jira", 9)).toMatchObject({ kept: true })
      expect(updates[0][0].connection_id).toBe("3")
      list.mockRestore()
      list = listing([[4, true], [9, true]])
      expect(await core.attachToBoundWorkspace(cfg, "jira", 9)).not.toHaveProperty("kept")
      expect([updates[1][0].connection_id, updates[1][0].connection_ids]).toEqual(["9", ["4", "9"]])
      list.mockRestore()
    } finally {
      for (const sp of spies) sp.mockRestore()
    }
  })
  test("attach is an error when the workspace catalog has no entry for the provider", async () => {
    const spies = [
      spyOn(workspaceState, "resolveBindingOutcome").mockResolvedValue({ status: "bound", binding: { datamateId: 5, datamateName: "WS" } } as any),
      spyOn(backend, "getDatamate").mockResolvedValue({ id: "5", name: "WS", is_owner: true, privacy: "private", integrations: [] } as any),
      spyOn(backend, "integrationsCatalog").mockResolvedValue([{ id: "somethingelse", tools: [] }] as any),
      spyOn(backend, "listVisibleConnections").mockResolvedValue([] as any),
    ]
    const update = spyOn(backend, "updateDatamateIntegrations").mockResolvedValue(undefined as any)
    try {
      const cfg = { url: "http://x", tenant: "t", token: "k" } as any
      expect(await core.attachToBoundWorkspace(cfg, "jira", 9)).toEqual({ error: expect.stringContaining("no entry for Jira") })
      expect(update).not.toHaveBeenCalled()
    } finally {
      for (const sp of [...spies, update]) sp.mockRestore()
    }
  })
  test("attach reports when the workspace kept its own connection", async () => {
    const spies = [
      spyOn(workspaceState, "resolveBindingOutcome").mockResolvedValue({ status: "bound", binding: { datamateId: 5, datamateName: "WS" } } as any),
      spyOn(backend, "getDatamate").mockResolvedValue({ id: "5", name: "WS", is_owner: true, privacy: "private", integrations: [{ id: "jira", tools: [], connection_id: "3" }] } as any),
      spyOn(backend, "updateDatamateIntegrations").mockResolvedValue(undefined as any),
    ]
    try {
      const cfg = { url: "http://x", tenant: "t", token: "k" } as any
      expect(await core.attachToBoundWorkspace(cfg, "jira", 9, [9, 3])).toEqual({ attached: "WS", workspaceId: "5", kept: true })
      expect(await core.attachToBoundWorkspace(cfg, "jira", 9, [9])).toEqual({ attached: "WS", workspaceId: "5" })
    } finally {
      for (const sp of spies) sp.mockRestore()
    }
  })
  test("a workspace that is not private gets the connection only with --share, and says its members can use it", async () => {
    const getDatamate = spyOn(backend, "getDatamate")
    const spies = [
      spyOn(workspaceState, "resolveBindingOutcome").mockResolvedValue({ status: "bound", binding: { datamateId: 5, datamateName: "WS" } } as any),
      spyOn(backend, "listVisibleConnections").mockResolvedValue([] as any),
      getDatamate,
    ]
    const update = spyOn(backend, "updateDatamateIntegrations").mockResolvedValue(undefined as any)
    try {
      const cfg = { url: "http://x", tenant: "t", token: "k" } as any
      // A missing privacy is treated as shared: nothing is widened on a guess.
      for (const privacy of ["public", "restricted", undefined]) {
        getDatamate.mockResolvedValue({ id: "5", name: "WS", is_owner: true, privacy, integrations: [{ id: "jira", tools: [], connection_id: null }] } as any)
        expect(await core.attachToBoundWorkspace(cfg, "jira", 9)).toEqual({ error: core.SHARED_WORKSPACE_REFUSAL("WS", "jira") })
        expect(update).not.toHaveBeenCalled()
      }
      getDatamate.mockResolvedValue({ id: "5", name: "WS", is_owner: true, privacy: "public", integrations: [{ id: "jira", tools: [], connection_id: null }] } as any)
      expect(await core.attachToBoundWorkspace(cfg, "jira", 9, undefined, true)).toEqual({ attached: "WS", workspaceId: "5", shared: true })
      // An entry that keeps another live connection does not take this one, so this one is not shared.
      getDatamate.mockResolvedValue({ id: "5", name: "WS", is_owner: true, privacy: "public", integrations: [{ id: "jira", tools: [], connection_id: "3" }] } as any)
      expect(await core.attachToBoundWorkspace(cfg, "jira", 9, [9, 3], true)).toEqual({ attached: "WS", workspaceId: "5", kept: true })
      expect(update).toHaveBeenCalledTimes(2)
      // Without --share that kept entry is not refused either: the write changes nothing members can use.
      expect(await core.attachToBoundWorkspace(cfg, "jira", 9, [9, 3])).toEqual({ attached: "WS", workspaceId: "5", kept: true })
      expect(update).toHaveBeenCalledTimes(3)
      // A secondary connection already in the entry is not exposed again, but becoming the default (the stored one is gone) needs --share.
      getDatamate.mockResolvedValue({ id: "5", name: "WS", is_owner: true, privacy: "public", integrations: [{ id: "jira", tools: [], connection_id: "3", connection_ids: ["3", "9"] }] } as any)
      expect(await core.attachToBoundWorkspace(cfg, "jira", 9, [9, 3])).toEqual({ attached: "WS", workspaceId: "5", kept: true, shared: true })
      expect(await core.attachToBoundWorkspace(cfg, "jira", 9, [9])).toEqual({ error: core.SHARED_WORKSPACE_REFUSAL("WS", "jira") })
      expect(update).toHaveBeenCalledTimes(4)
      getDatamate.mockResolvedValue({ id: "5", name: "WS", is_owner: true, privacy: "private", integrations: [{ id: "jira", tools: [], connection_id: null }] } as any)
      expect(await core.attachToBoundWorkspace(cfg, "jira", 9)).toEqual({ attached: "WS", workspaceId: "5" })
      update.mockClear()
      // A workspace made shared between the first read and the one right before writing gets nothing.
      getDatamate.mockResolvedValueOnce({ id: "5", name: "WS", is_owner: true, privacy: "private", integrations: [{ id: "jira", tools: [], connection_id: null }] } as any)
      getDatamate.mockResolvedValueOnce({ id: "5", name: "WS", is_owner: true, privacy: "public", integrations: [{ id: "jira", tools: [], connection_id: null }] } as any)
      expect(await core.attachToBoundWorkspace(cfg, "jira", 9)).toEqual({ error: core.SHARED_WORKSPACE_REFUSAL("WS", "jira") })
      expect(update).not.toHaveBeenCalled()
    } finally {
      for (const sp of [...spies, update]) sp.mockRestore()
    }
  })
  test("detach leaves an entry on another connection alone", () => {
    const out = core.detachFromIntegrations([{ id: "jira", tools: [], connection_id: "3" }], 9)
    expect(out[0].connection_id).toBe("3")
  })
})

describe("collectConfig", () => {
  test("an optional secret with no stored value is left out; a required one is needed", async () => {
    const catalog = spyOn(creds, "loadCatalog").mockResolvedValue([
      { id: "v", label: "V", fields: [{ name: "plain", label: "P", secret: false, required: true }, { name: "must", label: "M", secret: true, required: true }, { name: "extra", label: "E", secret: true, required: false }] },
    ] as any)
    try {
      const rec = { registered: true, variant: "v", values: { plain: "p" }, secretFields: ["must", "extra"] } as any
      await core.storeSecret(core.secretKey("cred", "github", "must"), "m1")
      expect(await core.collectConfig("github", rec)).toEqual({ config: { plain: "p", must: "m1" }, saved: true })
      await core.deleteSecret(core.secretKey("cred", "github", "must"))
      expect(await core.collectConfig("github", rec)).toEqual({ reason: "no local credential to upload" })
    } finally {
      catalog.mockRestore()
    }
  })
})

describe("detachFromIntegrations", () => {
  test("clears only this connection and leaves other entries alone", () => {
    const other = { id: "linear", tools: [], connection_id: "5" }
    const out = core.detachFromIntegrations([{ id: "jira", tools: [{ key: "t" }], connection_id: "9", connection_ids: ["3", "9"] }, other], 9)
    expect(out).toEqual([{ id: "jira", tools: [{ key: "t" }], connection_id: null, connection_ids: ["3"] }, other])
  })
})

describe("the CLI passes --share through and reports shared", () => {
  test("connect --share --json and sync --share", async () => {
    const logs: string[] = []
    const log = spyOn(console, "log").mockImplementation((t?: unknown) => void logs.push(String(t)))
    const connect = spyOn(creds, "connectCredentials").mockResolvedValue({ provider: "github", status: "connected", sync: "synced", account: null, expiresAt: null, message: null, shared: true } as any)
    const sync = spyOn(core, "syncProvider").mockResolvedValue({ id: "github", result: "synced", steps: [], shared: true })
    const info = spyOn(core, "liveWorkspaceInfo").mockResolvedValue({} as any)
    try {
      await (ConnectCommand.handler as any)({ provider: "github", share: true, json: true })
      expect(connect.mock.calls[0][0].share).toBe(true)
      expect(JSON.parse(logs.join("\n")).shared).toBe(true)
      await (SyncCommand.handler as any)({ provider: "github", share: true, json: true })
      expect(sync.mock.calls[0][4]).toBe(true)
      expect(JSON.parse(logs[logs.length - 1]).results[0].shared).toBe(true)
    } finally {
      for (const sp of [log, connect, sync, info]) sp.mockRestore()
      process.exitCode = 0
    }
  })
})

describe("printed text and catalog shape", () => {
  test("clean removes escape sequences, control and bidi characters", () => {
    expect(clean("a\u001b[31mred\u001b[0m\nb\r\u0007c\u202ed")).toBe("ared b c d")
    expect(clean("\u001b]0;title\u0007ok")).toBe("ok")
    expect(clean(null)).toBe("")
  })

  test("the masked tail is dropped when it holds a control or direction character", () => {
    expect(creds.maskTail("abcdefghij1234")).toBe("••••1234")
    expect(creds.maskTail("abc")).toBe("••••")
    for (const tail of ["12\u001b[3", "12\u202e34", "1\u00852\u0007", "12\u200f4", "12\u20283"]) expect(creds.maskTail(`abcdefghij${tail}`)).toBe("••••")
  })

  test("catalogEntries unwraps a list, items, integrations and data alike", () => {
    const entry = { id: "github", tools: [{ key: "read_repo" }] }
    for (const body of [[entry], { items: [entry] }, { integrations: [entry] }, { data: [entry] }]) {
      expect(backend.catalogEntries(body)).toEqual([entry])
      expect(Object.keys(creds.parseCatalog(body))).toEqual(Object.keys(creds.parseCatalog([entry])))
    }
    expect(backend.catalogEntries({ items: "x" })).toEqual([])
    expect(backend.catalogEntries(null)).toEqual([])
  })
})

describe("saved login", () => {
  const saved = { url: process.env.ALTIMATE_INTEGRATIONS_API_URL, tenant: process.env.ALTIMATE_INTEGRATIONS_TENANT, token: process.env.ALTIMATE_INTEGRATIONS_TOKEN }
  beforeEach(() => {
    delete process.env.ALTIMATE_INTEGRATIONS_API_URL
    delete process.env.ALTIMATE_INTEGRATIONS_TENANT
    delete process.env.ALTIMATE_INTEGRATIONS_TOKEN
  })
  afterEach(() => {
    for (const [k, v] of [["ALTIMATE_INTEGRATIONS_API_URL", saved.url], ["ALTIMATE_INTEGRATIONS_TENANT", saved.tenant], ["ALTIMATE_INTEGRATIONS_TOKEN", saved.token]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test("a missing credentials file is signed out, an unreadable one is an error", async () => {
    const missing = spyOn(AltimateApi, "getCredentials").mockRejectedValue(new Error("Altimate credentials not found at /x/altimate.json"))
    try {
      expect(await backend.backendConfig()).toBeNull()
    } finally {
      missing.mockRestore()
    }
    const corrupt = spyOn(AltimateApi, "getCredentials").mockRejectedValue(new SyntaxError("Unexpected token } in JSON"))
    try {
      await expect(backend.backendConfig()).rejects.toThrow("Could not read your Altimate login (Unexpected token } in JSON)")
    } finally {
      corrupt.mockRestore()
    }
  })
})
