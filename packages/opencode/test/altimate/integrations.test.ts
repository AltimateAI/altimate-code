import { afterAll, afterEach, describe, expect, test, beforeEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as core from "../../src/altimate/integrations/core"
import * as backend from "../../src/altimate/integrations/backend"
import * as creds from "../../src/altimate/integrations/credentials"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "integrations-test-"))
process.env.ALTIMATE_INTEGRATIONS_DIR = tmp
process.env.ALTIMATE_INTEGRATIONS_MOCK = "1"

beforeEach(() => {
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true })
  delete process.env.ALTIMATE_INTEGRATIONS_DEMO
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
    expect(core.status().providers[0].account).toBe("harish-altimate")
  })

  test("not_found without detections", () => {
    expect(core.status().providers.every((p) => p.state === "not_found")).toBe(true)
  })
})

describe("block policy and sync", () => {
  test("blocked providers stay local, unblocked sync", async () => {
    process.env.ALTIMATE_INTEGRATIONS_DEMO = "1"
    core.recordDetections(core.scan())
    core.setBlocked(["github"], true)
    expect(core.status().providers[0].sync).toBe("blocked")
    expect((await core.syncProvider("github")).result).toBe("kept_local")
    core.setBlocked(["github"], false)
    const o = await core.syncProvider("github")
    expect(o.result).toBe("synced")
    expect(o.request?.body.name).toStartWith("GitHub (from ")
    expect(o.request?.privacy).toBe("private")
    const p = core.status().providers[0]
    expect([p.state, p.sync]).toEqual(["connected", "synced"])
    expect((await core.syncProvider("linear")).result).toBe("skipped")
    core.disconnect("github")
    expect(core.status().providers[0].state).toBe("detected")
  })
})

const connected = (id: core.ProviderId, expiresAt: string | null, extra: Partial<core.StoredProvider> = {}, secret: string | null = "tok_" + id) => {
  if (secret) core.storeSecret(id, secret)
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
  }
  const seed = (row: Record<string, unknown>) => {
    const full = { id: state.next++, user_id: 1, is_valid: true, is_owner: true, config: {}, last_validated_at: null, created_at: "2030-01-01T00:00:00Z", ...row }
    state.rows.push(full)
    return full
  }
  const handle = (req: Request, url: URL, body: any): Response | undefined => {
    if (!url.pathname.startsWith("/connections")) return
    if (state.fail && req.method !== "GET") return Response.json(state.fail.body, { status: state.fail.status })
    const id = Number(url.pathname.split("/")[2])
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

  test("status reports expired and expiresAt", () => {
    connected("github", new Date(Date.now() + 3_600_000).toISOString())
    let p = core.status().providers[0]
    expect([p.state, p.expiresAt === null]).toEqual(["connected", false])
    expect(core.expireProvider("github")).toBe(true)
    p = core.status().providers[0]
    expect(p.state).toBe("expired")
    expect(core.expireProvider("linear")).toBe(false)
  })

})

describe("token", () => {
  const fixHint = (m: string, id: string) => {
    expect(m).toContain(`altimate integrations update ${id}`)
    expect(m).toContain(`connect ${id} --local-only`)
  }

  test("not connected, and no stored credential, say how to fix it", async () => {
    const none = await core.getToken("github")
    expect(none.status).toBe("not_connected")
    connected("github", null, { synced: true, connectionId: 7 }, null)
    const r = await core.getToken("github")
    expect(r.status).toBe("unavailable")
    fixHint((r as { message: string }).message, "github")
  })

  test("returns the stored token while fresh", async () => {
    connected("linear", new Date(Date.now() + 3_600_000).toISOString())
    expect(await core.getToken("linear")).toMatchObject({ status: "ok", token: "tok_linear" })
  })

  test("a rejected credential is reported with the fix", async () => {
    connected("jira", null, { rejected: true })
    const r = await core.getToken("jira")
    expect(r.status).toBe("failed")
    fixHint((r as { message: string }).message, "jira")
  })

  test("an expired token, or one inside the 60 second margin, is reported", async () => {
    connected("jira", new Date(Date.now() - 1000).toISOString())
    expect((await core.getToken("jira")).status).toBe("failed")
    connected("github", new Date(Date.now() + 30_000).toISOString())
    const r = await core.getToken("github")
    expect(r.status).toBe("failed")
    fixHint((r as { message: string }).message, "github")
  })
})

describe("workspace connections", () => {
  const calls: { method: string; path: string; query: string; auth: string | null; tenant: string | null; body: any }[] = []
  const api = connectionsStub()
  let server: ReturnType<typeof Bun.serve>
  const saved = { ...process.env }

  beforeEach(() => {
    calls.length = 0
    api.state.rows.length = 0
    api.state.next = 21
    api.state.valid = true
    api.state.fail = null
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const body = req.method === "POST" || req.method === "PATCH" ? await req.json().catch(() => null) : null
        calls.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.get("authorization"), tenant: req.headers.get("x-tenant"), body })
        return api.handle(req, url, body) ?? new Response("no", { status: 404 })
      },
    })
    delete process.env.ALTIMATE_INTEGRATIONS_MOCK
    process.env.ALTIMATE_API_URL = `http://127.0.0.1:${server.port}`
    process.env.ALTIMATE_TOKEN = "bearer-1"
    process.env.ALTIMATE_TENANT = "acme"
    process.env.ALTIMATE_INTEGRATIONS_HOME = fs.mkdtempSync(path.join(tmp, "empty-"))
    process.env.GITHUB_TOKEN = "gh_env_token"
    core.recordDetections([{ id: "github", source: { kind: "env", label: "GITHUB_TOKEN" }, account: null, syncable: true, note: null }])
  })
  afterEach(() => {
    server.stop(true)
    process.env.ALTIMATE_INTEGRATIONS_MOCK = "1"
    for (const k of ["ALTIMATE_API_URL", "ALTIMATE_TOKEN", "ALTIMATE_TENANT", "ALTIMATE_INTEGRATIONS_HOME"]) delete process.env[k]
    if (saved.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN
  })
  const writes = () => calls.filter((c) => c.method !== "GET")

  test("sync creates the managed connection, then updates it in place", async () => {
    const first = await core.syncProvider("github")
    expect(first.result).toBe("synced")
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({ method: "POST", path: "/connections/", auth: "Bearer bearer-1", tenant: "acme" })
    expect(writes()[0].body).toEqual({ name: `GitHub (from ${HOST})`, integration_id: "github", config: { github_token: "gh_env_token" } })
    expect(calls[0]).toMatchObject({ method: "GET", path: "/connections/", query: "?include_shared=false" })
    expect(core.loadStore().providers.github).toMatchObject({ registered: true, synced: true, connectionId: 21 })

    process.env.GITHUB_TOKEN = "gh_env_token_2"
    const second = await core.syncProvider("github")
    expect(second.result).toBe("synced")
    expect(second.steps).toEqual([{ label: "Updated connection", ok: true }])
    expect(writes()[1]).toMatchObject({ method: "PATCH", path: "/connections/21", auth: "Bearer bearer-1", tenant: "acme" })
    expect(writes()[1].body).toEqual({ config: { github_token: "gh_env_token_2" } })
    expect(api.state.rows).toHaveLength(1)
  })

  test("a saved but invalid connection is reported rejected and kept", async () => {
    api.state.valid = false
    const o = await core.syncProvider("github")
    expect(o.result).toBe("failed")
    expect(o.reason).toContain("marked it invalid")
    expect(api.state.rows).toHaveLength(1)
    expect(core.status().providers[0].state).toBe("rejected")
    api.state.valid = true
    expect((await core.syncProvider("github")).result).toBe("synced")
    expect(writes().map((c) => c.method)).toEqual(["POST", "PATCH"])
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
    expect(derived.map((d) => [d.integration_id, d.name, d.managed])).toEqual([
      ["github", `GitHub (from ${HOST})`, true],
      ["jira", "Hand made", false],
    ])
    const s = await core.statusRemote()
    expect(Object.keys(s.providers[0])).toEqual(["id", "name", "state", "source", "account", "syncable", "sync", "updatedAt", "expiresAt", "note"])
    expect(s.providers.map((p) => [p.id, p.state, p.sync, p.source?.label ?? null])).toEqual([
      ["github", "rejected", "synced", "Altimate workspace"],
      ["jira", "connected", "synced", "Altimate workspace"],
      ["linear", "not_found", "local", null],
    ])
  })

  test("a fresh local connection wins over the remote one", () => {
    const now = Date.parse("2030-01-01T00:00:00Z")
    const remote: core.RemoteProvider[] = [{ integration_id: "linear", connection_id: 3, name: "Linear", account: null, managed: true, source: null, expires_at: null, expired: false, is_valid: false }]
    connected("linear", "2030-01-01T01:00:00Z", { account: "me" })
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

  test("only the existing connections endpoints are called", async () => {
    await core.syncProvider("github")
    await core.statusRemote()
    await core.disconnectRemote("github")
    expect(calls.length).toBeGreaterThan(3)
    expect(calls.filter((c) => c.path.startsWith("/integrations/"))).toEqual([])
    expect(calls.every((c) => c.auth === "Bearer bearer-1" && c.tenant === "acme")).toBe(true)
    expect(calls.every((c) => c.path === "/connections/" || /^\/connections\/\d+$/.test(c.path))).toBe(true)
  })

  test("without a signed-in backend nothing is removed", async () => {
    expect(await core.disconnectRemote("linear", null)).toEqual(0)
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
})

describe("jira domain and cli flags", () => {
  test("normaliseJiraDomain sends the subdomain only", () => {
    for (const v of ["acme.atlassian.net", "https://acme.atlassian.net", "https://acme.atlassian.net/jira/", " acme.atlassian.net ", "acme"])
      expect(core.normaliseJiraDomain(v)).toBe("acme")
  })

  test("the browser sign-in flags are gone and token explains a missing connection", () => {
    const cli = path.join(import.meta.dir, "../../src/index.ts")
    const run = (...args: string[]) =>
      Bun.spawnSync(["bun", "run", cli, "integrations", ...args], { env: { ...process.env, ALTIMATE_INTEGRATIONS_DIR: tmp, ALTIMATE_INTEGRATIONS_MOCK: "1" }, stdout: "pipe", stderr: "pipe" })
    const all = (r: ReturnType<typeof run>) => r.stderr.toString() + r.stdout.toString()
    expect(all(run("token", "github"))).toContain("not connected")
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
  const saved = { ...process.env }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "integ-home-"))
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "integ-bin-"))
  const basic = (u: string, t: string) => `Basic ${Buffer.from(`${u}:${t}`).toString("base64")}`
  const GOOD = "good_token_a1b2"
  const fake = (name: string, body: string | null) => {
    const file = path.join(bin, name)
    if (body === null) return fs.rmSync(file, { force: true })
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }
  const real = () => {
    delete process.env.ALTIMATE_INTEGRATIONS_MOCK
    process.env.ALTIMATE_API_URL = `http://127.0.0.1:${server.port}`
    process.env.ALTIMATE_TOKEN = "bearer-1"
    process.env.ALTIMATE_TENANT = "acme"
  }
  const mock = () => {
    process.env.ALTIMATE_INTEGRATIONS_MOCK = "1"
    for (const k of ["ALTIMATE_API_URL", "ALTIMATE_TOKEN", "ALTIMATE_TENANT"]) delete process.env[k]
  }
  const clip = (text: string | undefined) => ({ clipboard: () => text })
  const token = async (id: core.ProviderId, field: string, value = GOOD) => creds.setSecretDraft(id, field, { kind: "clipboard" }, clip(value))
  const synced = () => calls.filter((c) => c.method !== "GET" && c.path.startsWith("/connections"))

  beforeEach(() => {
    calls.length = 0
    api.state.rows.length = 0
    api.state.next = 21
    api.state.valid = true
    api.state.fail = null
    catalog = []
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
      expect(fs.existsSync(path.join(tmp, "integrations-catalog.json"))).toBe(true)

      mock()
      expect((await creds.describeFields("github")).fields.map((f) => f.name)).toEqual(["github_token", "github_org"])
      // A catalog failure while signed in falls back to the cache too.
      real()
      process.env.ALTIMATE_API_URL = "http://127.0.0.1:1"
      expect((await creds.describeFields("github")).fields.map((f) => f.name)).toEqual(["github_token", "github_org"])
    })

    test("parseCatalog reads a wrapped list and a variants map", () => {
      const parsed = creds.parseCatalog({ items: [{ id: "linear", config: [{ name: "linearApiKey", encrypted: true, required: true }] }, { id: "jira", variants: { server: { config: { jiraBaseUrl: { required: true } } } } }] })
      expect(parsed.linear![0].fields).toEqual([{ name: "linearApiKey", label: "Linear Api Key", secret: true, required: true }])
      expect(parsed.jira![0]).toMatchObject({ id: "server", fields: [{ name: "jiraBaseUrl", secret: false, required: true }] })
    })
  })

  describe("set and set-secret", () => {
    test("set stores a non-secret draft and rejects secrets and unknown fields", async () => {
      await creds.setDraft("jira", "jiraDomain", " acme ")
      expect(core.loadStore().providers.jira?.drafts).toEqual({ jiraDomain: "acme" })
      await expect(creds.setDraft("jira", "jiraApiToken", "x")).rejects.toThrow("is a secret")
      await expect(creds.setDraft("jira", "nope", "x")).rejects.toThrow('no field "nope"')
      // A scan does not drop a draft.
      core.recordDetections([])
      expect(core.loadStore().providers.jira?.drafts).toEqual({ jiraDomain: "acme" })
    })

    test("set-secret reads the injected clipboard and returns only the masked tail", async () => {
      const r = await creds.setSecretDraft("github", "github_token", { kind: "clipboard" }, clip(`  ghp_abcdefgh_${GOOD}\n`))
      expect(r).toEqual({ provider: "github", field: "github_token", masked: "••••a1b2" })
      expect(JSON.stringify(r)).not.toContain("abcdefgh")
      expect(core.readSecret(core.secretKey("draft", "github", "github_token"))).toBe(`ghp_abcdefgh_${GOOD}`)
      expect(fs.existsSync(path.join(tmp, "integrations.json")) ? fs.readFileSync(path.join(tmp, "integrations.json"), "utf8") : "").not.toContain("abcdefgh")
    })

    test("clipboard content that is not a token is refused", async () => {
      for (const bad of [undefined, "", "   \n", "two words", "line1\nline2"])
        await expect(creds.setSecretDraft("github", "github_token", { kind: "clipboard" }, clip(bad))).rejects.toThrow("Clipboard doesn't contain a token")
      await expect(creds.setSecretDraft("github", "github_token", { kind: "clipboard" }, clip("a b")).catch((e) => e.message)).resolves.not.toContain("a b")
      expect(core.readSecret(core.secretKey("draft", "github", "github_token"))).toBeUndefined()
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
      const r = await creds.connectCredentials({ id: "github", localOnly: true })
      expect(r).toMatchObject({ provider: "github", status: "connected", sync: "local", account: "octo", expiresAt: "2031-01-02T03:04:05.000Z" })
      expect(calls.filter((c) => c.path.startsWith("/integrations"))).toEqual([])
      expect(core.readSecret(core.secretKey("cred", "github", "github_token"))).toBe(GOOD)
      expect(core.readSecret("github")).toBe(GOOD)
      expect(core.readSecret(core.secretKey("draft", "github", "github_token"))).toBeUndefined()
      const rec = core.loadStore().providers.github!
      expect([rec.registered, rec.synced, rec.rejected, rec.account, typeof rec.validatedAt]).toEqual([true, false, false, "octo", "string"])
      expect(JSON.stringify(rec)).not.toContain(GOOD)
      const p = core.status().providers[0]
      expect([p.state, p.sync, p.account, p.expiresAt]).toEqual(["connected", "local", "octo", "2031-01-02T03:04:05.000Z"])
      expect((await core.getToken("github")).status).toBe("ok")
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
      expect(core.readSecret("github")).toBeUndefined()
      expect(core.status().providers[0].state).toBe("not_found")
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
      expect(core.readSecret("jira")).toBeUndefined()
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

    test("a connection the workspace marks invalid is rejected, kept, and fixed by update", async () => {
      real()
      api.state.valid = false
      await token("linear", "linearApiKey")
      const r = await creds.connectCredentials({ id: "linear" })
      expect([r.status, r.sync]).toEqual(["rejected", "synced"])
      expect(r.message).toContain("marked it invalid")
      expect(api.state.rows).toHaveLength(1)
      expect(core.status().providers[2].state).toBe("rejected")
      api.state.valid = true
      await token("linear", "linearApiKey")
      const fixed = await creds.connectCredentials({ id: "linear", update: true })
      expect(fixed.status).toBe("connected")
      expect(synced().map((c) => c.method)).toEqual(["POST", "PATCH"])
      expect(api.state.rows).toHaveLength(1)
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
      core.setBlocked(["linear"], true)
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
      expect(second.body).toEqual({ config: { github_token: GOOD } })
      expect(api.state.rows).toHaveLength(1)
    })

    test("a manual sync of a locally connected credential uploads it", async () => {
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github", localOnly: true })
      real()
      const o = await core.syncProvider("github")
      expect(o.result).toBe("synced")
      expect(synced()[0].body.config).toEqual({ github_token: GOOD })
    })

    test("disconnect removes the credential secrets", async () => {
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github", localOnly: true })
      core.disconnect("github")
      expect(core.readSecret(core.secretKey("cred", "github", "github_token"))).toBeUndefined()
      expect(core.readSecret("github")).toBeUndefined()
    })
  })

  describe("rejected status", () => {
    test("a refused update marks a connection rejected until it is updated", async () => {
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github", localOnly: true })
      await token("github", "github_token", "bad_token_0000")
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
    const help = run("connect", "--help")
    const text = help.stderr.toString() + help.stdout.toString()
    expect(text).toContain("--local-only")
    for (const flag of ["--oauth", "--reauth", "--frontend"]) expect(text).not.toContain(flag)
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
