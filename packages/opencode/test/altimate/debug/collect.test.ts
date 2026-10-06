// altimate_change start — debug bundle collection: credential classification and network probes
import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { configFiles, connectionFact, credentialFieldsFor, mcpFacts, pidAlive, probe } from "../../../src/altimate/debug/collect"
import { detectProblems } from "../../../src/altimate/debug/report"

describe("connection facts", () => {
  // Saved configs have their secrets moved to the credential store; `resolved` is what the driver gets back.
  const secret = ["s3", "cr", "et"].join("")
  test("a token or key held in the credential store counts as a sign-in", () => {
    for (const [type, field] of [
      ["databricks", "access_token"],
      ["snowflake", "private_key"],
      ["bigquery", "credentials_json"],
      ["postgres", "connection_string"],
    ] as const) {
      const saved = { type, host: "h" }
      const fact = connectionFact("c", saved, { ...saved, [field]: secret })
      expect(fact.passwordAvailable === false).toBe(false)
      expect(fact.fields).toContain(`${field} (secret, in credential store)`)
    }
  })

  test("a password connection whose password is in neither place is still flagged", () => {
    const saved = { type: "snowflake", account: "a", user: "u", password: undefined, authenticator: undefined }
    const fact = connectionFact("sf", saved, { type: "snowflake", account: "a", user: "u" })
    expect(fact.passwordAvailable).toBe(false)
    const findings = detectProblems({ connections: [fact], network: [], telemetry: { enabled: true }, proxy: {} } as never)
    expect(findings.some((f) => f.title.startsWith("Connection 'sf' has no password"))).toBe(true)
  })

  test("an unreadable credential store is not mistaken for a working sign-in", () => {
    const fact = connectionFact("sf", { type: "snowflake", account: "a", user: "u" }, undefined)
    expect(fact.passwordAvailable).toBe(false)
  })
})

describe("network probe", () => {
  const never = () => new Promise<never>(() => {})
  test("one deadline covers the DNS lookup too", async () => {
    const started = Date.now()
    const r = await probe("API", "api.example.test", { timeoutMs: 50 }, { lookup: never, fetch: never })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(r.ok).toBe(false)
    expect(r.detail).toBe("DNS lookup: no response within 0.05 s")
  })

  test("behind a proxy the DNS lookup is skipped: the proxy resolves the name", async () => {
    let looked = false
    const r = await probe("API", "api.example.test", { proxy: true }, {
      lookup: async () => {
        looked = true
        throw Object.assign(new Error("no dns"), { code: "ENOTFOUND" })
      },
      fetch: async () => ({ status: 200 }),
    })
    expect(looked).toBe(false)
    expect(r).toMatchObject({ ok: true, detail: "HTTP 200" })
  })

  test("a request that never answers fails at the deadline", async () => {
    const r = await probe("API", "api.example.test", { timeoutMs: 50 }, { lookup: async () => ({}), fetch: never })
    expect(r).toMatchObject({ ok: false, detail: "no response within 0.05 s" })
  })
})

describe("MCP servers", () => {
  test("read from the config files without starting a project: global, then project overrides; JSONC allowed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-mcp-"))
    try {
      const global = path.join(root, "g")
      const project = path.join(root, "p")
      fs.mkdirSync(global)
      fs.mkdirSync(path.join(project, ".altimate-code"), { recursive: true })
      fs.writeFileSync(path.join(global, "altimate-code.json"), JSON.stringify({ mcp: { dbt: { type: "local" }, gh: { type: "remote" } } }))
      fs.writeFileSync(path.join(project, ".altimate-code", "altimate-code.jsonc"), '{ // comment\n "mcp": { "gh": { "type": "remote", "enabled": false } } }')
      const home = path.join(root, "home")
      expect(mcpFacts({ global, cwd: project, home })).toEqual([
        { name: "dbt", type: "local", enabled: true },
        { name: "gh", type: "remote", enabled: false },
      ])
      expect(mcpFacts({ global: path.join(root, "none"), cwd: path.join(root, "none"), home })).toBeUndefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("MCP sources the loader uses", () => {
  test("a partial override merges with the earlier entry; mcpServers, ancestors, extra file and inline content count", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-mcp2-"))
    try {
      const global = path.join(root, "g")
      const repo = path.join(root, "repo")
      const nested = path.join(repo, "a", "b")
      fs.mkdirSync(global, { recursive: true })
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
      fs.mkdirSync(nested, { recursive: true })
      fs.writeFileSync(path.join(global, "opencode.json"), JSON.stringify({ mcp: { dbt: { type: "local", enabled: false } } }))
      // At the repo root, run from a nested folder: still found.
      fs.writeFileSync(path.join(repo, "opencode.json"), JSON.stringify({ mcpServers: { gh: { type: "remote" } } }))
      // Only `enabled` overridden: the type from the global file is kept.
      fs.writeFileSync(path.join(nested, "opencode.json"), JSON.stringify({ mcp: { dbt: { enabled: true } } }))
      const extra = path.join(root, "extra.json")
      fs.writeFileSync(extra, JSON.stringify({ mcp: { lint: { type: "local" } } }))
      const facts = mcpFacts({ global, cwd: nested, home: path.join(root, "h"), file: extra, content: '{"mcp":{"inline":{"type":"remote"}}}' })
      expect(facts).toEqual([
        { name: "dbt", type: "local", enabled: true },
        { name: "gh", type: "remote", enabled: true },
        { name: "inline", type: "remote", enabled: true },
        { name: "lint", type: "local", enabled: true },
      ])
      // .opencode is read after .altimate-code, as the loader does.
      const files = configFiles({ global, cwd: nested, home: path.join(root, "h") })
      expect(files.indexOf(path.join(nested, ".opencode", "opencode.json"))).toBeGreaterThan(files.indexOf(path.join(nested, ".altimate-code", "opencode.json")))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("credentials per warehouse type", () => {
  test("a field the warehouse's driver does not read does not count as a sign-in", () => {
    const secret = ["s3", "cr", "et"].join("")
    const pg = connectionFact("pg", { type: "postgres", host: "h", user: "u" }, { type: "postgres", host: "h", user: "u", credentials_path: "/k.json" })
    expect(pg.passwordAvailable).toBe(false)
    const bq = connectionFact("bq", { type: "bigquery" }, { type: "bigquery", credentials_json: secret })
    expect(bq.passwordAvailable === false).toBe(false)
    expect(credentialFieldsFor("postgres")).toEqual(["password", "connection_string"])
  })
})

describe("process liveness", () => {
  test("this process is alive; an unused pid is not", () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(2 ** 22 + 12345)).toBe(false)
  })
})
// altimate_change end
