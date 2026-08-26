import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import path from "path"
import os from "os"
import fsp from "fs/promises"

import { AltimateApi } from "../../src/altimate/api/client"
import { slugify, isPinnedToOtherWorkspace } from "../../src/altimate/tools/datamate"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpRoot = path.join(os.tmpdir(), "datamate-test-" + process.pid + "-" + Math.random().toString(36).slice(2))

// ---------------------------------------------------------------------------
// buildMcpConfig
// ---------------------------------------------------------------------------

describe("buildMcpConfig", () => {
  const creds = {
    altimateUrl: "https://api.getaltimate.com",
    altimateInstanceName: "megatenant",
    altimateApiKey: "test-api-key-123",
  }

  test("returns correct shape with 4 headers", () => {
    const config = AltimateApi.buildMcpConfig(creds, "42")
    expect(config.type).toBe("remote")
    expect(config.headers).toBeDefined()
    expect(Object.keys(config.headers)).toHaveLength(4)
    expect(config.headers["Authorization"]).toBe("Bearer test-api-key-123")
    expect(config.headers["x-datamate-id"]).toBe("42")
    expect(config.headers["x-tenant"]).toBe("megatenant")
    expect(config.headers["x-altimate-url"]).toBe("https://api.getaltimate.com")
  })

  test("uses default MCP URL when mcpServerUrl not set", () => {
    const config = AltimateApi.buildMcpConfig(creds, "1")
    expect(config.url).toBe("https://mcpserver.getaltimate.com/sse")
  })

  test("uses override MCP URL when mcpServerUrl set", () => {
    const credsWithUrl = { ...creds, mcpServerUrl: "https://custom.example.com/sse" }
    const config = AltimateApi.buildMcpConfig(credsWithUrl, "1")
    expect(config.url).toBe("https://custom.example.com/sse")
  })

  test("sets oauth to false", () => {
    const config = AltimateApi.buildMcpConfig(creds, "1")
    expect(config.oauth).toBe(false)
  })

  test("coerces datamate ID to string", () => {
    const config = AltimateApi.buildMcpConfig(creds, "123")
    expect(config.headers["x-datamate-id"]).toBe("123")
    expect(typeof config.headers["x-datamate-id"]).toBe("string")
  })
})

// ---------------------------------------------------------------------------
// credentialsPath
// ---------------------------------------------------------------------------

describe("credentialsPath", () => {
  test("returns path under home directory", () => {
    const p = AltimateApi.credentialsPath()
    expect(p).toContain(".altimate")
    expect(p).toContain("altimate.json")
    expect(p.endsWith(path.join(".altimate", "altimate.json"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getCredentials
// ---------------------------------------------------------------------------

describe("getCredentials", () => {
  const testHome = path.join(tmpRoot, "creds-test")

  beforeEach(async () => {
    process.env.OPENCODE_TEST_HOME = testHome
    await fsp.mkdir(testHome, { recursive: true })
  })

  afterEach(async () => {
    delete process.env.OPENCODE_TEST_HOME
    await fsp.rm(testHome, { recursive: true, force: true }).catch(() => {})
  })

  test("throws when file missing", async () => {
    await expect(AltimateApi.getCredentials()).rejects.toThrow("credentials not found")
  })

  test("parses valid file", async () => {
    const altDir = path.join(testHome, ".altimate")
    await fsp.mkdir(altDir, { recursive: true })
    await fsp.writeFile(
      path.join(altDir, "altimate.json"),
      JSON.stringify({
        altimateUrl: "https://api.test.com",
        altimateInstanceName: "testco",
        altimateApiKey: "key123",
      }),
    )
    const creds = await AltimateApi.getCredentials()
    expect(creds.altimateUrl).toBe("https://api.test.com")
    expect(creds.altimateInstanceName).toBe("testco")
    expect(creds.altimateApiKey).toBe("key123")
  })

  test("throws on malformed JSON", async () => {
    const altDir = path.join(testHome, ".altimate")
    await fsp.mkdir(altDir, { recursive: true })
    await fsp.writeFile(path.join(altDir, "altimate.json"), "not json")
    await expect(AltimateApi.getCredentials()).rejects.toThrow()
  })

  test("throws on missing required fields", async () => {
    const altDir = path.join(testHome, ".altimate")
    await fsp.mkdir(altDir, { recursive: true })
    await fsp.writeFile(
      path.join(altDir, "altimate.json"),
      JSON.stringify({ altimateUrl: "https://api.test.com" }),
    )
    await expect(AltimateApi.getCredentials()).rejects.toThrow()
  })

  test("resolves ${env:VAR} substitution in all fields", async () => {
    const altDir = path.join(testHome, ".altimate")
    await fsp.mkdir(altDir, { recursive: true })
    await fsp.writeFile(
      path.join(altDir, "altimate.json"),
      JSON.stringify({
        altimateUrl: "${env:TEST_ALT_URL}",
        altimateInstanceName: "${env:TEST_ALT_INSTANCE}",
        altimateApiKey: "${env:TEST_ALT_KEY}",
      }),
    )
    process.env.TEST_ALT_URL = "https://api.envtest.com"
    process.env.TEST_ALT_INSTANCE = "envtenant"
    process.env.TEST_ALT_KEY = "envkey456"
    try {
      const creds = await AltimateApi.getCredentials()
      expect(creds.altimateUrl).toBe("https://api.envtest.com")
      expect(creds.altimateInstanceName).toBe("envtenant")
      expect(creds.altimateApiKey).toBe("envkey456")
    } finally {
      delete process.env.TEST_ALT_URL
      delete process.env.TEST_ALT_INSTANCE
      delete process.env.TEST_ALT_KEY
    }
  })

  test("resolves ${env:VAR} mixed with literal text", async () => {
    const altDir = path.join(testHome, ".altimate")
    await fsp.mkdir(altDir, { recursive: true })
    await fsp.writeFile(
      path.join(altDir, "altimate.json"),
      JSON.stringify({
        altimateUrl: "https://api.myaltimate.com",
        altimateInstanceName: "${env:TEST_ALT_INSTANCE_MIX}",
        altimateApiKey: "prefix-${env:TEST_ALT_KEY_MIX}-suffix",
      }),
    )
    process.env.TEST_ALT_INSTANCE_MIX = "mixedtenant"
    process.env.TEST_ALT_KEY_MIX = "secret"
    try {
      const creds = await AltimateApi.getCredentials()
      expect(creds.altimateInstanceName).toBe("mixedtenant")
      expect(creds.altimateApiKey).toBe("prefix-secret-suffix")
    } finally {
      delete process.env.TEST_ALT_INSTANCE_MIX
      delete process.env.TEST_ALT_KEY_MIX
    }
  })

  test("throws when referenced env var is not set", async () => {
    const altDir = path.join(testHome, ".altimate")
    await fsp.mkdir(altDir, { recursive: true })
    await fsp.writeFile(
      path.join(altDir, "altimate.json"),
      JSON.stringify({
        altimateUrl: "https://api.myaltimate.com",
        altimateInstanceName: "tenant",
        altimateApiKey: "${env:THIS_VAR_DOES_NOT_EXIST_12345}",
      }),
    )
    delete process.env.THIS_VAR_DOES_NOT_EXIST_12345
    await expect(AltimateApi.getCredentials()).rejects.toThrow(
      "Environment variable THIS_VAR_DOES_NOT_EXIST_12345 not found",
    )
  })

  test("resolves empty-string env var without throwing", async () => {
    const altDir = path.join(testHome, ".altimate")
    await fsp.mkdir(altDir, { recursive: true })
    await fsp.writeFile(
      path.join(altDir, "altimate.json"),
      JSON.stringify({
        altimateUrl: "https://api.myaltimate.com",
        altimateInstanceName: "${env:TEST_EMPTY_VAR}",
        altimateApiKey: "key",
      }),
    )
    process.env.TEST_EMPTY_VAR = ""
    try {
      const creds = await AltimateApi.getCredentials()
      expect(creds.altimateInstanceName).toBe("")
    } finally {
      delete process.env.TEST_EMPTY_VAR
    }
  })

  test("leaves literal values unchanged when no substitution syntax present", async () => {
    const altDir = path.join(testHome, ".altimate")
    await fsp.mkdir(altDir, { recursive: true })
    await fsp.writeFile(
      path.join(altDir, "altimate.json"),
      JSON.stringify({
        altimateUrl: "https://api.myaltimate.com",
        altimateInstanceName: "plaintenant",
        altimateApiKey: "plain-key-no-substitution",
      }),
    )
    const creds = await AltimateApi.getCredentials()
    expect(creds.altimateApiKey).toBe("plain-key-no-substitution")
  })

  test("resolves optional mcpServerUrl field via env var", async () => {
    const altDir = path.join(testHome, ".altimate")
    await fsp.mkdir(altDir, { recursive: true })
    await fsp.writeFile(
      path.join(altDir, "altimate.json"),
      JSON.stringify({
        altimateUrl: "https://api.myaltimate.com",
        altimateInstanceName: "tenant",
        altimateApiKey: "key",
        mcpServerUrl: "${env:TEST_MCP_URL}",
      }),
    )
    process.env.TEST_MCP_URL = "https://custom.mcp.example.com/sse"
    try {
      const creds = await AltimateApi.getCredentials()
      expect(creds.mcpServerUrl).toBe("https://custom.mcp.example.com/sse")
    } finally {
      delete process.env.TEST_MCP_URL
    }
  })
})

// ---------------------------------------------------------------------------
// parseAltimateKey
// ---------------------------------------------------------------------------

describe("parseAltimateKey", () => {
  test("parses valid 3-part input", () => {
    const r = AltimateApi.parseAltimateKey("https://api.getaltimate.com::mycompany::abc123")
    expect(r).toEqual({ altimateUrl: "https://api.getaltimate.com", altimateInstanceName: "mycompany", altimateApiKey: "abc123" })
  })

  test("trims whitespace", () => {
    const r = AltimateApi.parseAltimateKey("  https://api.getaltimate.com :: mycompany :: abc123  ")
    expect(r?.altimateUrl).toBe("https://api.getaltimate.com")
    expect(r?.altimateInstanceName).toBe("mycompany")
    expect(r?.altimateApiKey).toBe("abc123")
  })

  test("allows :: in the api key (joins remaining parts)", () => {
    const r = AltimateApi.parseAltimateKey("https://api.getaltimate.com::mycompany::key::extra")
    expect(r?.altimateApiKey).toBe("key::extra")
  })

  test("returns null for a single part (no separator)", () => {
    expect(AltimateApi.parseAltimateKey("justonevalue")).toBeNull()
  })

  // altimate_change start — default URL for 2-part input
  test("parses 2-part input with default URL (https://api.myaltimate.com)", () => {
    const r = AltimateApi.parseAltimateKey("mycompany::abc123")
    expect(r).toEqual({
      altimateUrl: "https://api.myaltimate.com",
      altimateInstanceName: "mycompany",
      altimateApiKey: "abc123",
    })
  })

  test("trims whitespace for 2-part input", () => {
    const r = AltimateApi.parseAltimateKey("  mycompany :: abc123  ")
    expect(r?.altimateUrl).toBe("https://api.myaltimate.com")
    expect(r?.altimateInstanceName).toBe("mycompany")
    expect(r?.altimateApiKey).toBe("abc123")
  })

  test("returns null for empty instance name in 2-part input", () => {
    expect(AltimateApi.parseAltimateKey("::abc123")).toBeNull()
  })

  test("returns null for empty api key in 2-part input", () => {
    expect(AltimateApi.parseAltimateKey("mycompany::")).toBeNull()
  })

  test("3+ parts always treat first segment as URL — non-http rejected", () => {
    // `mycompany::key::extra` → 3 parts → url=mycompany (fails http(s) check)
    expect(AltimateApi.parseAltimateKey("mycompany::key::extra")).toBeNull()
  })
  // altimate_change end

  test("returns null for empty url", () => {
    expect(AltimateApi.parseAltimateKey("::mycompany::key")).toBeNull()
  })

  test("returns null for empty instance", () => {
    expect(AltimateApi.parseAltimateKey("https://api.getaltimate.com::::key")).toBeNull()
  })

  test("returns null for non-http url", () => {
    expect(AltimateApi.parseAltimateKey("ftp://api.getaltimate.com::mycompany::key")).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(AltimateApi.parseAltimateKey("")).toBeNull()
  })

  test("supports http:// for local dev", () => {
    const r = AltimateApi.parseAltimateKey("http://localhost:8000::dev::localkey")
    expect(r?.altimateUrl).toBe("http://localhost:8000")
    expect(r?.altimateInstanceName).toBe("dev")
    expect(r?.altimateApiKey).toBe("localkey")
  })
})

// ---------------------------------------------------------------------------
// saveCredentials
// ---------------------------------------------------------------------------

describe("saveCredentials", () => {
  const testHome = path.join(tmpRoot, "save-test")

  beforeEach(async () => {
    process.env.OPENCODE_TEST_HOME = testHome
    await fsp.mkdir(testHome, { recursive: true })
  })

  afterEach(async () => {
    delete process.env.OPENCODE_TEST_HOME
    await fsp.rm(testHome, { recursive: true, force: true }).catch(() => {})
  })

  test("writes all fields to altimate.json", async () => {
    await AltimateApi.saveCredentials({
      altimateUrl: "https://api.save-test.com",
      altimateInstanceName: "savetenant",
      altimateApiKey: "savekey",
    })
    const written = JSON.parse(await fsp.readFile(AltimateApi.credentialsPath(), "utf-8"))
    expect(written.altimateUrl).toBe("https://api.save-test.com")
    expect(written.altimateInstanceName).toBe("savetenant")
    expect(written.altimateApiKey).toBe("savekey")
  })

  test("creates parent directory if missing", async () => {
    const dirPath = path.join(testHome, ".altimate")
    await fsp.rm(dirPath, { recursive: true, force: true }).catch(() => {})
    await AltimateApi.saveCredentials({
      altimateUrl: "https://api.save-test.com",
      altimateInstanceName: "savetenant",
      altimateApiKey: "savekey",
    })
    expect(await fsp.access(AltimateApi.credentialsPath()).then(() => true).catch(() => false)).toBe(true)
  })

  test("sets file permissions to 0o600", async () => {
    await AltimateApi.saveCredentials({
      altimateUrl: "https://api.save-test.com",
      altimateInstanceName: "savetenant",
      altimateApiKey: "savekey",
    })
    const stat = await fsp.stat(AltimateApi.credentialsPath())
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test("writes optional mcpServerUrl when provided", async () => {
    await AltimateApi.saveCredentials({
      altimateUrl: "https://api.save-test.com",
      altimateInstanceName: "savetenant",
      altimateApiKey: "savekey",
      mcpServerUrl: "https://custom.mcp.example.com/sse",
    })
    const written = JSON.parse(await fsp.readFile(AltimateApi.credentialsPath(), "utf-8"))
    expect(written.mcpServerUrl).toBe("https://custom.mcp.example.com/sse")
  })

  test("omits mcpServerUrl field when not provided", async () => {
    await AltimateApi.saveCredentials({
      altimateUrl: "https://api.save-test.com",
      altimateInstanceName: "savetenant",
      altimateApiKey: "savekey",
    })
    const written = JSON.parse(await fsp.readFile(AltimateApi.credentialsPath(), "utf-8"))
    expect(written.mcpServerUrl).toBeUndefined()
  })
})


// ---------------------------------------------------------------------------
// TUI credential round-trip: parseAltimateKey → saveCredentials → getCredentials
// ---------------------------------------------------------------------------

describe("TUI credential round-trip", () => {
  const testHome = path.join(tmpRoot, "roundtrip-test")

  beforeEach(async () => {
    process.env.OPENCODE_TEST_HOME = testHome
    await fsp.mkdir(testHome, { recursive: true })
  })

  afterEach(async () => {
    delete process.env.OPENCODE_TEST_HOME
    await fsp.rm(testHome, { recursive: true, force: true }).catch(() => {})
  })

  test("parse → save → getCredentials returns same values", async () => {
    const parsed = AltimateApi.parseAltimateKey(
      "https://api.getaltimate.com::megatenant::e7ad942d0e64c873074f762f409989a4",
    )
    expect(parsed).not.toBeNull()
    await AltimateApi.saveCredentials(parsed!)
    const creds = await AltimateApi.getCredentials()
    expect(creds.altimateUrl).toBe("https://api.getaltimate.com")
    expect(creds.altimateInstanceName).toBe("megatenant")
    expect(creds.altimateApiKey).toBe("e7ad942d0e64c873074f762f409989a4")
  })

  test("trailing slash in url is stripped through round-trip", async () => {
    const parsed = AltimateApi.parseAltimateKey("https://api.getaltimate.com/::tenant::key")
    expect(parsed).not.toBeNull()
    await AltimateApi.saveCredentials(parsed!)
    const creds = await AltimateApi.getCredentials()
    expect(creds.altimateUrl).toBe("https://api.getaltimate.com")
  })

  test("api key containing :: survives round-trip", async () => {
    const parsed = AltimateApi.parseAltimateKey("https://api.getaltimate.com::tenant::part1::part2")
    expect(parsed).not.toBeNull()
    await AltimateApi.saveCredentials(parsed!)
    const creds = await AltimateApi.getCredentials()
    expect(creds.altimateApiKey).toBe("part1::part2")
  })
})

// ---------------------------------------------------------------------------
// validateCredentials — mirrors AltimateSettingsHelper.validateSettings
// ---------------------------------------------------------------------------

describe("validateCredentials", () => {
  const validCreds = {
    altimateUrl: "https://api.getaltimate.com",
    altimateInstanceName: "mycompany",
    altimateApiKey: "abc123",
  }

  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("returns ok:true on 200 response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
    const result = await AltimateApi.validateCredentials(validCreds)
    expect(result).toEqual({ ok: true })
  })

  test("returns ok:false with 'Invalid API key' message on 401", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "Invalid API key" }), {
        status: 401,
        statusText: "Unauthorized",
      })) as unknown as typeof fetch
    const result = await AltimateApi.validateCredentials(validCreds)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("Invalid API key")
  })

  test("returns ok:false with 'Invalid instance name' message on 403", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "Invalid instance name" }), {
        status: 403,
        statusText: "Forbidden",
      })) as unknown as typeof fetch
    const result = await AltimateApi.validateCredentials(validCreds)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("Invalid instance name")
  })

  test("returns ok:false with status code on other HTTP errors", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 500, statusText: "Internal Server Error" })) as unknown as typeof fetch
    const result = await AltimateApi.validateCredentials(validCreds)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("500")
  })

  test("returns ok:false when network fetch throws", async () => {
    globalThis.fetch = (async () => { throw new Error("Network error") }) as unknown as typeof fetch
    const result = await AltimateApi.validateCredentials(validCreds)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("Could not reach Altimate API")
  })

  test("returns ok:false for instance name with uppercase letters", async () => {
    const result = await AltimateApi.validateCredentials({ ...validCreds, altimateInstanceName: "MyCompany" })
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("Invalid instance name")
  })

  test("returns ok:false for instance name starting with a number", async () => {
    const result = await AltimateApi.validateCredentials({ ...validCreds, altimateInstanceName: "1company" })
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("Invalid instance name")
  })

  test("returns ok:false for instance name with spaces", async () => {
    const result = await AltimateApi.validateCredentials({ ...validCreds, altimateInstanceName: "my company" })
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("Invalid instance name")
  })

  test("accepts valid instance names with hyphens and underscores", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
    for (const name of ["test-instance", "test_instance", "_test", "a", "test123_name-here"]) {
      const result = await AltimateApi.validateCredentials({ ...validCreds, altimateInstanceName: name })
      expect(result.ok).toBe(true)
    }
  })

  test("calls the correct endpoint URL with correct headers", async () => {
    let capturedUrl = ""
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedHeaders = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries())
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    await AltimateApi.validateCredentials(validCreds)
    expect(capturedUrl).toBe("https://api.getaltimate.com/dbt/v3/validate-credentials")
    expect(capturedHeaders["x-tenant"]).toBe("mycompany")
    expect(capturedHeaders["authorization"]).toBe("Bearer abc123")
  })

  test("strips trailing slash from url before calling endpoint", async () => {
    let capturedUrl = ""
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    await AltimateApi.validateCredentials({ ...validCreds, altimateUrl: "https://api.getaltimate.com/" })
    expect(capturedUrl).toBe("https://api.getaltimate.com/dbt/v3/validate-credentials")
  })
})

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  test("converts spaces and special chars to hyphens", () => {
    expect(slugify("My SQL Expert!")).toBe("my-sql-expert")
  })

  test("lowercases", () => {
    expect(slugify("TestName")).toBe("testname")
  })

  test("strips leading/trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello")
  })

  test("collapses multiple special chars", () => {
    expect(slugify("a   b...c")).toBe("a-b-c")
  })
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe("isPinnedToOtherWorkspace", () => {
  // The workspace attach persists the shared gateway key pinned to one
  // workspace, so "already configured and connected" stopped implying "serving
  // the datamate you asked for". Reporting success in that case would tell the
  // user their datamate is connected while another workspace's tools — and
  // credentials — were the ones actually exposed.
  test("a pin for another workspace is not the gateway you asked for", () => {
    const entry = { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] }
    expect(isPinnedToOtherWorkspace(entry, "99")).toBe(true)
    expect(isPinnedToOtherWorkspace(entry, 99)).toBe(true)
  })

  test("a pin for the requested workspace is", () => {
    const entry = { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] }
    expect(isPinnedToOtherWorkspace(entry, "42")).toBe(false)
    expect(isPinnedToOtherWorkspace(entry, 42)).toBe(false)
  })

  test("an UNPINNED entry is the generic gateway and answers for any datamate", () => {
    // This is the pre-existing extension-written shape; it must keep working.
    expect(isPinnedToOtherWorkspace({ type: "local", command: ["datamate", "start-stdio"] }, "99")).toBe(false)
    expect(isPinnedToOtherWorkspace({ command: "datamate", args: ["start-stdio"] }, "99")).toBe(false)
  })

  test("a missing entry is not treated as a foreign pin", () => {
    expect(isPinnedToOtherWorkspace(undefined, "99")).toBe(false)
    expect(isPinnedToOtherWorkspace(null, "99")).toBe(false)
  })
})
