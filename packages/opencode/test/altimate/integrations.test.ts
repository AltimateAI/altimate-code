import { describe, expect, test, beforeEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as core from "../../src/altimate/integrations/core"
import * as backend from "../../src/altimate/integrations/backend"

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

describe("loopback callback", () => {
  test("validates state and returns the credential", async () => {
    const pending = core.runConnect({
      id: "github",
      account: "octo",
      onListening: async (url) => {
        const u = new URL(url)
        const page = await (await fetch(url)).text()
        expect(page).toContain("Altimate Code wants to connect GitHub")
        expect((await fetch(`${u.origin}/connect/github?state=bad`)).status).toBe(403)
        const bad = await fetch(`${u.origin}/callback`, { method: "POST", body: JSON.stringify({ state: "nope", choice: "allow" }) })
        expect(bad.status).toBe(403)
        const ok = await fetch(`${u.origin}/callback`, {
          method: "POST",
          body: JSON.stringify({ state: u.searchParams.get("state"), choice: "allow", sync: true }),
        })
        expect(await ok.text()).toContain("return to your terminal")
      },
    })
    const r = await pending
    expect(r.status).toBe("connected")
    expect(r.sync).toBe("synced")
    expect(r.credential).toStartWith("ghu_demo_")
    expect(core.maskSecret(r.credential!)).toMatch(/^ghu_••••.{4}$/)
  })

  test("cancel and local-only", async () => {
    const cancel = await core.runConnect({
      id: "linear",
      onListening: async (url) => {
        const u = new URL(url)
        await fetch(`${u.origin}/callback`, { method: "POST", body: JSON.stringify({ state: u.searchParams.get("state"), choice: "cancel" }) })
      },
    })
    expect(cancel.status).toBe("cancelled")
    const local = await core.runConnect({
      id: "jira",
      localOnly: true,
      onListening: async (url) => {
        const u = new URL(url)
        expect(await (await fetch(url)).text()).toContain("disabled")
        await fetch(`${u.origin}/callback`, { method: "POST", body: JSON.stringify({ state: u.searchParams.get("state"), choice: "allow", sync: true }) })
      },
    })
    expect([local.status, local.sync]).toEqual(["connected", "local"])
  })
})

const connected = (id: core.ProviderId, expiresAt: string | null, extra: Partial<core.ConnectResult> = {}) =>
  core.registerConnection({ provider: id, status: "connected", sync: "local", account: "octo", url: "", credential: "tok_" + id, expiresAt, ...extra })

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

  test("mock credential honours the TTL setting", async () => {
    process.env.ALTIMATE_INTEGRATIONS_MOCK_TTL_SECONDS = "120"
    try {
      const before = Date.now()
      const r = await core.runConnect({
        id: "github",
        onListening: async (url) => {
          const u = new URL(url)
          await fetch(`${u.origin}/callback`, { method: "POST", body: JSON.stringify({ state: u.searchParams.get("state"), choice: "allow" }) })
        },
      })
      const ttl = Date.parse(r.expiresAt!) - before
      expect(ttl).toBeGreaterThan(110_000)
      expect(ttl).toBeLessThan(130_000)
    } finally {
      delete process.env.ALTIMATE_INTEGRATIONS_MOCK_TTL_SECONDS
    }
  })

  test("mock consent page variants", async () => {
    const r = core.consentPage("jira", "s", { account: null, syncDisabled: false, reauth: true })
    expect(r).toContain("Your Jira access expired. Reconnect to continue.")
    expect(core.errorPage("Invalid or expired state. Start again from your terminal.")).toContain("Invalid or expired state")
    await core.runConnect({
      id: "github",
      reauth: true,
      timeoutMs: 1500,
      onListening: async (url) => {
        expect(await (await fetch(url)).text()).toContain("access expired")
        const u = new URL(url)
        const bad = await fetch(`${u.origin}/connect/github?state=bad`)
        expect(bad.status).toBe(403)
        expect(await bad.text()).toContain("Invalid or expired state")
      },
    })
  })
})

describe("token", () => {
  test("not connected and saved-only messages", async () => {
    expect((await core.getToken("github")).status).toBe("not_connected")
    connected("github", null, { credential: undefined, saved: true, connectionId: 7 })
    const r = await core.getToken("github")
    expect(r.status).toBe("unavailable")
  })

  test("returns the stored token while fresh", async () => {
    connected("linear", new Date(Date.now() + 3_600_000).toISOString())
    let called = 0
    const r = await core.getToken("linear", { connect: async () => (called++, { result: {} as any, sync: "local" }) })
    expect(r).toMatchObject({ status: "ok", token: "tok_linear", reauthed: false })
    expect(called).toBe(0)
  })

  test("expired access re-runs connect with reauth", async () => {
    connected("jira", new Date(Date.now() - 1000).toISOString())
    const seen: core.ConnectOptions[] = []
    const r = await core.getToken("jira", {
      connect: async (o) => {
        seen.push(o)
        const result: core.ConnectResult = { provider: "jira", status: "connected", sync: "local", account: "a", url: "", credential: "fresh", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
        core.registerConnection(result)
        return { result, sync: "local" }
      },
    })
    expect(seen.map((o) => [o.id, o.reauth, o.localOnly])).toEqual([["jira", true, true]])
    expect(r).toMatchObject({ status: "ok", token: "fresh", reauthed: true })
    expect(core.status().providers[1].state).toBe("connected")
  })

  test("failed renewal is reported", async () => {
    connected("jira", new Date(Date.now() - 1000).toISOString())
    const r = await core.getToken("jira", { connect: async () => ({ result: { provider: "jira", status: "cancelled", sync: "local", account: null, url: "" }, sync: "local" }) })
    expect(r.status).toBe("failed")
  })
})

describe("real mode client", () => {
  const calls: { method: string; path: string; auth: string | null; tenant: string | null; body: any }[] = []
  let server: ReturnType<typeof Bun.serve>
  let exchangeResponse: Record<string, unknown>
  const saveEnv = { ...process.env }

  beforeEach(() => {
    calls.length = 0
    exchangeResponse = { provider: "github", account: "octo", site_url: null, expires_at: null, saved: true, connection_id: 11, access_token: null }
  })

  const start = () => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const body = req.method === "POST" ? await req.json().catch(() => null) : null
        calls.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), tenant: req.headers.get("x-tenant"), body })
        if (url.pathname.endsWith("/start")) return Response.json({ authorize_url: "https://provider.example/authorize?x=1", state_expires_in: 600 })
        if (url.pathname === "/integrations/oauth/exchange")
          return body?.code === "used" ? Response.json({ detail: { code: "handoff_code_invalid" } }, { status: 410 }) : Response.json(exchangeResponse)
        if (url.pathname === "/integrations/connections/sync")
          return Response.json({ connection_id: 5, created: true, is_valid: true, message: null })
        if (url.pathname === "/integrations/connections/status")
          return Response.json({ providers: [{ integration_id: "jira", connection_id: 9, name: "Jira", account: "me", auth_type: "oauth", source: null, expires_at: "2020-01-01T00:00:00Z", expired: true, is_valid: false }] })
        return new Response("no", { status: 404 })
      },
    })
    delete process.env.ALTIMATE_INTEGRATIONS_MOCK
    process.env.ALTIMATE_API_URL = `http://127.0.0.1:${server.port}`
    process.env.ALTIMATE_TOKEN = "bearer-1"
    process.env.ALTIMATE_TENANT = "acme"
    process.env.ALTIMATE_FRONTEND_URL = "http://app.example"
  }
  const stop = () => {
    server.stop(true)
    process.env.ALTIMATE_INTEGRATIONS_MOCK = "1"
    for (const k of ["ALTIMATE_API_URL", "ALTIMATE_TOKEN", "ALTIMATE_TENANT", "ALTIMATE_FRONTEND_URL"]) delete process.env[k]
    expect(process.env.ALTIMATE_INTEGRATIONS_DIR).toBe(saveEnv.ALTIMATE_INTEGRATIONS_DIR ?? tmp)
  }
  const callback = async (url: string, query: (state: string) => string) => {
    const u = new URL(url)
    const redirect = new URL(u.searchParams.get("redirect") ?? u.origin)
    return fetch(`${redirect.origin}/callback?${query(u.searchParams.get("state")!)}`)
  }

  test("saved connect: consent url, exchange, no secret kept", async () => {
    start()
    try {
      let consent = ""
      let page: Promise<string> = Promise.resolve("")
      const { result, sync } = await core.connectProvider({
        id: "github",
        onListening: (url) => {
          consent = url
          page = callback(url, (s) => `code=abc&state=${s}`).then((r) => r.text())
        },
      })
      expect(await page).toContain("GitHub connected")
      const q = new URL(consent)
      expect(q.origin + q.pathname).toBe("http://app.example/cli/integrations/connect")
      expect([q.searchParams.get("provider"), q.searchParams.get("save"), q.searchParams.get("connection_id")]).toEqual(["github", "1", null])
      expect(result.status).toBe("connected")
      expect(sync).toBe("synced")
      expect(core.readSecret("github")).toBeUndefined()
      const p = core.status().providers[0]
      expect([p.state, p.sync]).toEqual(["connected", "synced"])
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ path: "/integrations/oauth/exchange", auth: "Bearer bearer-1", tenant: "acme", body: { code: "abc" } })
    } finally {
      stop()
    }
  })

  test("local-only keeps the token and expiry locally", async () => {
    start()
    try {
      exchangeResponse = { ...exchangeResponse, saved: false, connection_id: null, access_token: "gho_real", expires_at: "2031-01-01T00:00:00Z" }
      const { result } = await core.connectProvider({
        id: "github",
        localOnly: true,
        onListening: async (url) => {
          expect(new URL(url).searchParams.get("save")).toBe("0")
          await callback(url, (s) => `code=abc&state=${s}`)
        },
      })
      expect(result.status).toBe("connected")
      expect(core.readSecret("github")).toBe("gho_real")
      const p = core.status().providers[0]
      expect([p.sync, p.expiresAt]).toEqual(["local", "2031-01-01T00:00:00Z"])
      expect((await core.getToken("github")).status).toBe("ok")
    } finally {
      stop()
    }
  })

  test("--no-frontend starts at the backend and reauth sends the connection id", async () => {
    start()
    try {
      core.registerConnection({ provider: "github", status: "connected", sync: "synced", account: "o", url: "", saved: true, connectionId: 11 })
      let url = ""
      await core.connectProvider({
        id: "github",
        noFrontend: true,
        reauth: true,
        timeoutMs: 800,
        onListening: (u) => (url = u),
      })
      expect(url).toBe("https://provider.example/authorize?x=1")
      expect(calls[0].path).toBe("/integrations/oauth/github/start")
      expect(calls[0].body).toMatchObject({ save_to_workspace: true, connection_id: 11 })
      expect(calls[0].body.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
      let consent = ""
      await core.connectProvider({ id: "github", reauth: true, timeoutMs: 500, onListening: (u) => (consent = u) })
      expect(new URL(consent).searchParams.get("connection_id")).toBe("11")
    } finally {
      stop()
    }
  })

  test("cancel and error callbacks", async () => {
    start()
    try {
      let page = ""
      let pending: Promise<unknown> = Promise.resolve()
      const cancelled = await core.connectProvider({
        id: "linear",
        onListening: (url) => {
          pending = callback(url, (s) => `error=access_denied&state=${s}`).then(async (r) => (page = await r.text()))
        },
      })
      await pending
      expect(cancelled.result.status).toBe("cancelled")
      expect(page).toContain("Cancelled")
      const failed = await core.connectProvider({
        id: "linear",
        onListening: (url) => {
          pending = callback(url, (s) => `error=provider_error&state=${s}`).then(async (r) => (page = await r.text()))
        },
      })
      await pending
      expect(failed.result.status).toBe("error")
      expect(page).toContain("Could not connect")
      const badState = await core.connectProvider({
        id: "linear",
        timeoutMs: 600,
        onListening: async (url) => {
          const r = await callback(url, () => "code=abc&state=wrong")
          expect(r.status).toBe(403)
          expect(await r.text()).toContain("Invalid or expired state")
        },
      })
      expect(badState.result.status).toBe("timeout")
      const used = await core.connectProvider({
        id: "linear",
        onListening: (url) => {
          pending = callback(url, (s) => `code=used&state=${s}`).then(async (r) => (page = await r.text()))
        },
      })
      await pending
      expect(used.result.status).toBe("error")
      expect(page).toContain("already used")
      expect(core.status().providers[2].state).toBe("not_found")
    } finally {
      stop()
    }
  })

  test("sync posts the config and status merges the workspace view", async () => {
    start()
    const gh = process.env.GITHUB_TOKEN
    try {
      process.env.GITHUB_TOKEN = "gh_env_token"
      process.env.ALTIMATE_INTEGRATIONS_HOME = fs.mkdtempSync(path.join(tmp, "empty-"))
      core.recordDetections([{ id: "github", source: { kind: "env", label: "GITHUB_TOKEN" }, account: null, syncable: true, note: null }])
      const o = await core.syncProvider("github")
      expect(o.result).toBe("synced")
      const sent = calls.find((c) => c.path === "/integrations/connections/sync")!
      expect(sent.body).toMatchObject({ integration_id: "github", config: { github_token: "gh_env_token" }, source: { kind: "env", label: "GITHUB_TOKEN" } })
      expect(sent.body.source.machine).toBeString()
      const merged = await core.statusRemote()
      expect(merged.providers[0]).toMatchObject({ id: "github", state: "connected", sync: "synced" })
      expect(merged.providers[1]).toMatchObject({ id: "jira", state: "expired", expiresAt: "2020-01-01T00:00:00Z" })
    } finally {
      if (gh === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = gh
      delete process.env.ALTIMATE_INTEGRATIONS_HOME
      stop()
    }
  })
  test("token falls back to the authorize url when there is no frontend address", async () => {
    start()
    delete process.env.ALTIMATE_FRONTEND_URL
    process.env.ALTIMATE_API_URL = "http://localhost:" + server.port
    try {
      const cfg = (await backend.backendConfig())!
      expect(cfg.frontendUrl).toBeNull()
      let url = ""
      const r = await core.runRealConnect(cfg, { id: "linear", localOnly: true, reauth: true, timeoutMs: 300, onListening: (u) => (url = u) })
      expect(r.status).toBe("timeout")
      expect(url).toBe("https://provider.example/authorize?x=1")
      expect(calls[0].path).toBe("/integrations/oauth/linear/start")
    } finally {
      stop()
    }
  })

  test("status keeps a fresh local connection and reports the expired workspace copy in the note", () => {
    const now = Date.parse("2030-01-01T00:00:00Z")
    const remote = [{ integration_id: "linear", connection_id: 3, name: "Linear", account: "me", auth_type: "oauth" as const, source: null, expires_at: "2029-12-31T00:00:00Z", expired: true, is_valid: false }]
    const local = (expiresAt: string) => {
      core.registerConnection({ provider: "linear", status: "connected", sync: "local", account: "me", url: "", credential: "tok", expiresAt })
      return core.buildStatus(core.loadStore(), [], now)
    }
    const fresh = core.mergeRemote(local("2030-01-01T01:00:00Z"), remote, now).providers.find((p) => p.id === "linear")!
    expect(fresh.state).toBe("connected")
    expect(fresh.expiresAt).toBe("2030-01-01T01:00:00Z")
    expect(fresh.note).toBe("workspace copy expired, reconnect to update it")
    const stale = core.mergeRemote(local("2029-12-31T00:00:00Z"), remote, now).providers.find((p) => p.id === "linear")!
    expect(stale.state).toBe("expired")
    const live = [{ ...remote[0], expired: false, expires_at: "2030-01-01T02:00:00Z" }]
    const rescued = core.mergeRemote(local("2029-12-31T00:00:00Z"), live, now).providers.find((p) => p.id === "linear")!
    expect(rescued.state).toBe("connected")
    expect(rescued.note).toBe("local token expired, the workspace connection is still active")
  })

  test("backend failures carry the message and code", async () => {
    const failing = Bun.serve({
      port: 0,
      fetch: () => Response.json({ detail: { code: "connection_test_failed", message: "Linear rejected the API key" } }, { status: 422 }),
    })
    try {
      const cfg = { apiUrl: `http://127.0.0.1:${failing.port}`, tenant: "t", token: "x", frontendUrl: null }
      const e = await backend.syncConnection(cfg, { integration_id: "linear", config: {}, source: { kind: "env", label: "l", machine: "m" } }).catch((x) => x)
      expect(e).toBeInstanceOf(backend.BackendError)
      expect(e.status).toBe(422)
      expect(e.code).toBe("connection_test_failed")
      expect(e.message).toBe("Linear rejected the API key (connection_test_failed)")
    } finally {
      failing.stop(true)
    }
  })
})

describe("failure descriptions", () => {
  test("409, 410, 503 and 400 use the code and a fallback text", () => {
    expect(backend.describeFailure(409, { detail: { code: "integration_token_expired", provider: "jira" } })).toBe("The saved access expired, reconnect to continue (integration_token_expired)")
    expect(backend.describeFailure(410, { detail: { code: "handoff_code_invalid" } })).toBe("This sign-in link was already used or expired (handoff_code_invalid)")
    expect(backend.describeFailure(503, { detail: { code: "provider_not_configured", message: "Jira is not configured" } })).toBe("Jira is not configured (provider_not_configured)")
    expect(backend.describeFailure(400, { detail: { code: "invalid_redirect_uri" } })).toBe("The request was rejected (invalid_redirect_uri)")
    expect(backend.describeFailure(500, null)).toBe("status 500")
  })
})

describe("jira domain and cli flags", () => {
  test("normaliseJiraDomain sends the subdomain only", () => {
    for (const v of ["acme.atlassian.net", "https://acme.atlassian.net", "https://acme.atlassian.net/jira/", " acme.atlassian.net ", "acme"])
      expect(core.normaliseJiraDomain(v)).toBe("acme")
  })

  test("a token inside the 60 second margin is treated as expired", async () => {
    core.registerConnection({ provider: "github", status: "connected", sync: "local", account: "a", url: "", credential: "old", expiresAt: new Date(Date.now() + 30_000).toISOString() })
    let ran = false
    const r = await core.getToken("github", {
      connect: async () => {
        ran = true
        return { result: { provider: "github", status: "cancelled", sync: "local", account: null, url: "" }, sync: "local" }
      },
    })
    expect(ran).toBe(true)
    expect(r.status).toBe("failed")
  })

  test("--no-frontend and --no-open are accepted by the CLI", () => {
    const cli = path.join(import.meta.dir, "../../src/index.ts")
    const run = Bun.spawnSync(["bun", "run", cli, "integrations", "token", "github", "--no-frontend", "--no-open"], {
      env: { ...process.env, ALTIMATE_INTEGRATIONS_DIR: tmp, ALTIMATE_INTEGRATIONS_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const text = run.stderr.toString() + run.stdout.toString()
    expect(text).not.toContain("Unknown argument")
    expect(text).toContain("not connected")
  }, 30_000)
})

describe("disconnect in real mode", () => {
  test("removes the workspace connections this tool made and keeps hand-made ones", async () => {
    const remaining = [
      { integration_id: "linear", connection_id: 7, auth_type: "oauth", source: null },
      { integration_id: "linear", connection_id: 6, auth_type: "token", source: { kind: "env" } },
      { integration_id: "linear", connection_id: 3, auth_type: "token", source: null },
    ]
    const deleted: number[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (req.method === "DELETE" && url.pathname.startsWith("/connections/")) {
          const id = Number(url.pathname.split("/").pop())
          deleted.push(id)
          remaining.splice(remaining.findIndex((c) => c.connection_id === id), 1)
          return Response.json({ ok: true })
        }
        if (url.pathname === "/integrations/connections/status") {
          const top = remaining[0]
          return Response.json({
            providers: [{ name: "Linear", account: null, expires_at: null, expired: false, is_valid: true, ...(top ?? { integration_id: "linear", connection_id: null, auth_type: null, source: null }) }],
          })
        }
        return new Response("no", { status: 404 })
      },
    })
    try {
      const cfg = { apiUrl: `http://127.0.0.1:${server.port}`, tenant: "t", token: "x", frontendUrl: null }
      const removed = await core.disconnectRemote("linear", cfg)
      expect(removed).toEqual(2)
      expect(deleted).toEqual([7, 6])
    } finally {
      server.stop(true)
    }
  })

  test("does nothing without a signed-in backend", async () => {
    expect(await core.disconnectRemote("linear", null)).toEqual(0)
  })
})
