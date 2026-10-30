import { afterAll, describe, expect, test, beforeEach } from "bun:test"
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

describe("credentials flow", () => {
  const calls: { method: string; path: string; auth: string | null; body: any }[] = []
  let server: ReturnType<typeof Bun.serve>
  let remoteStatus: any[] = []
  let catalog: unknown = []
  let syncValid = true
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
  const synced = () => calls.filter((c) => c.path === "/integrations/connections/sync")

  beforeEach(() => {
    calls.length = 0
    remoteStatus = []
    catalog = []
    syncValid = true
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
        const body = req.method === "POST" ? await req.json().catch(() => null) : null
        calls.push({ method: req.method, path: url.pathname, auth, body })
        const deny = () => Response.json({ message: "Bad credentials" }, { status: 401 })
        if (url.pathname === "/user")
          return auth === `Bearer ${GOOD}` ? Response.json({ login: "octo" }, { headers: { "github-authentication-token-expiration": "2031-01-02 03:04:05 UTC" } }) : deny()
        if (url.pathname === "/rest/api/3/myself") return auth === basic("me@acme.com", GOOD) ? Response.json({ emailAddress: "me@acme.com" }) : deny()
        if (url.pathname === "/rest/api/2/myself") return auth === `Bearer ${GOOD}` ? Response.json({ displayName: "Server Me" }) : deny()
        if (url.pathname === "/graphql") return auth === GOOD ? Response.json({ data: { viewer: { email: "lin@acme.com", name: "Lin" } } }) : Response.json({ errors: [{ extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 401 })
        if (url.pathname === "/datamate_integrations/") return Response.json(catalog)
        if (url.pathname === "/integrations/connections/sync") return Response.json({ connection_id: 21, created: true, is_valid: syncValid, message: syncValid ? null : "workspace test failed" })
        if (url.pathname === "/integrations/connections/status") return Response.json({ providers: remoteStatus })
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

    test("sync sends the catalog field names to the sync endpoint and keeps no secret locally", async () => {
      real()
      await creds.setDraft("jira", "jiraDomain", "acme")
      await creds.setDraft("jira", "jiraEmail", "me@acme.com")
      await token("jira", "jiraApiToken")
      const r = await creds.connectCredentials({ id: "jira" })
      expect([r.status, r.sync, r.account]).toEqual(["connected", "synced", "me@acme.com"])
      const sent = synced()
      expect(sent).toHaveLength(1)
      expect(sent[0].body.integration_id).toBe("jira")
      expect(sent[0].body.config).toEqual({ auth_type: "token", jiraDomain: "acme", jiraEmail: "me@acme.com", jiraApiToken: GOOD })
      expect(sent[0].body.source).toEqual({ kind: "cli", label: "Claude Code", machine: os.hostname() })
      expect(core.readSecret("jira")).toBeUndefined()
      expect(core.loadStore().providers.jira).toMatchObject({ registered: true, synced: true, connectionId: 21 })
    })

    test("a credential the workspace refuses is rejected and not stored", async () => {
      real()
      syncValid = false
      await token("linear", "linearApiKey")
      const r = await creds.connectCredentials({ id: "linear" })
      expect([r.status, r.message]).toEqual(["rejected", "workspace test failed"])
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

    test("update of a synced connection syncs again from the same source", async () => {
      real()
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github" })
      await token("github", "github_token")
      const r = await creds.connectCredentials({ id: "github", update: true })
      expect([r.status, r.sync]).toEqual(["connected", "synced"])
      const [first, second] = synced()
      expect(second.body.source).toEqual(first.body.source)
    })

    test("a manual sync of a locally connected credential uploads it", async () => {
      await token("github", "github_token")
      await creds.connectCredentials({ id: "github", localOnly: true })
      real()
      const o = await core.syncProvider("github")
      expect(o.result).toBe("synced")
      expect(synced()[0].body.config).toEqual({ github_token: GOOD, auth_type: "token" })
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

    test("a workspace connection the provider refuses is rejected; expired wins", async () => {
      real()
      remoteStatus = [
        { integration_id: "github", connection_id: 1, name: "GitHub", account: "octo", auth_type: "token", source: null, expires_at: null, expired: false, is_valid: false },
        { integration_id: "linear", connection_id: 2, name: "Linear", account: "lin", auth_type: "token", source: null, expires_at: "2020-01-01T00:00:00Z", expired: true, is_valid: false },
        { integration_id: "jira", connection_id: 3, name: "Jira", account: "me", auth_type: "token", source: null, expires_at: null, expired: false, is_valid: true },
      ]
      const s = await core.statusRemote()
      expect(s.providers.map((p) => [p.id, p.state, p.note])).toEqual([
        ["github", "rejected", "Token rejected, update it"],
        ["jira", "connected", null],
        ["linear", "expired", "access expired, reconnect to continue"],
      ])
    })
  })

  test("the CLI shows the credential commands and keeps the browser flow behind --oauth", () => {
    const cli = path.join(import.meta.dir, "../../src/index.ts")
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, "run", cli, "integrations", ...args], { env: { ...process.env, PATH: saved.PATH, ALTIMATE_INTEGRATIONS_DIR: tmp, ALTIMATE_INTEGRATIONS_MOCK: "1", ALTIMATE_INTEGRATIONS_HOME: home }, stdout: "pipe", stderr: "pipe" })
    const fields = run("fields", "linear", "--json")
    expect(JSON.parse(fields.stdout.toString()).variant).toBe("key")
    const help = run("connect", "--help")
    const text = help.stderr.toString() + help.stdout.toString()
    for (const flag of ["--oauth", "--reauth", "--frontend", "--local-only"]) expect(text).toContain(flag)
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
