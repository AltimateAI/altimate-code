// altimate_change start — tests for MCP env-var interpolation (closes #656, addresses PR #666 review)
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { ConfigPaths } from "../../src/config/paths"
import { tmpdir } from "../fixture/fixture"

// -------------------------------------------------------------------------
// resolveEnvVarsInString — shared raw-string resolver in ConfigPaths
// -------------------------------------------------------------------------
// This is the single source of truth for env-var interpolation on already-parsed
// string values. `ConfigPaths.substitute()` uses the same regex grammar but
// JSON-escapes its output (because it runs on raw JSON text before parsing).

describe("ConfigPaths.resolveEnvVarsInString", () => {
  const KEYS_TO_CLEAR = [
    "TEST_TOKEN",
    "TEST_HOST",
    "UNSET_VAR",
    "COMPLETELY_UNSET_VAR_XYZ",
    "UNSET_VAR_ABC",
  ]

  beforeEach(() => {
    process.env["TEST_TOKEN"] = "secret-123"
    process.env["TEST_HOST"] = "gitlab.example.com"
    delete process.env["UNSET_VAR"]
    delete process.env["COMPLETELY_UNSET_VAR_XYZ"]
    delete process.env["UNSET_VAR_ABC"]
  })

  afterEach(() => {
    for (const k of KEYS_TO_CLEAR) delete process.env[k]
  })

  test("resolves ${VAR} syntax", () => {
    expect(ConfigPaths.resolveEnvVarsInString("${TEST_TOKEN}")).toBe("secret-123")
    expect(ConfigPaths.resolveEnvVarsInString("${TEST_HOST}")).toBe("gitlab.example.com")
  })

  test("resolves {env:VAR} syntax", () => {
    expect(ConfigPaths.resolveEnvVarsInString("{env:TEST_TOKEN}")).toBe("secret-123")
  })

  test("resolves ${VAR:-default} with fallback when unset", () => {
    expect(ConfigPaths.resolveEnvVarsInString("${UNSET_VAR:-production}")).toBe("production")
  })

  test("resolves ${VAR:-default} to env value when set", () => {
    expect(ConfigPaths.resolveEnvVarsInString("${TEST_TOKEN:-fallback}")).toBe("secret-123")
  })

  test("preserves $${VAR} as literal ${VAR}", () => {
    expect(ConfigPaths.resolveEnvVarsInString("$${TEST_TOKEN}")).toBe("${TEST_TOKEN}")
  })

  test("resolves unset variable with no default to empty string", () => {
    expect(ConfigPaths.resolveEnvVarsInString("${COMPLETELY_UNSET_VAR_XYZ}")).toBe("")
  })

  test("passes through plain values without modification", () => {
    expect(ConfigPaths.resolveEnvVarsInString("just-a-string")).toBe("just-a-string")
    expect(ConfigPaths.resolveEnvVarsInString("https://gitlab.com/api/v4")).toBe("https://gitlab.com/api/v4")
  })

  test("resolves multiple variables in a single value", () => {
    expect(ConfigPaths.resolveEnvVarsInString("https://${TEST_HOST}/api?token=${TEST_TOKEN}")).toBe(
      "https://gitlab.example.com/api?token=secret-123",
    )
  })

  test("does not interpolate bare $VAR without braces", () => {
    expect(ConfigPaths.resolveEnvVarsInString("$TEST_TOKEN")).toBe("$TEST_TOKEN")
  })

  test("records unresolved variable names in stats", () => {
    const stats = ConfigPaths.newEnvSubstitutionStats()
    ConfigPaths.resolveEnvVarsInString("${COMPLETELY_UNSET_VAR_XYZ}", stats)
    expect(stats.dollarUnresolved).toBe(1)
    expect(stats.unresolvedNames).toContain("COMPLETELY_UNSET_VAR_XYZ")
  })

  test("does NOT double-expand a resolved ${VAR} value that itself contains ${OTHER}", () => {
    // Single-pass: a value like `prefix ${FOO}` resolves to the env value of FOO,
    // and even if that value is itself a `${...}` string, it is NOT re-resolved.
    // This is the CRITICAL regression from PR #666 — no chain injection.
    process.env["EVIL"] = "${TEST_TOKEN}"
    try {
      expect(ConfigPaths.resolveEnvVarsInString("${EVIL}")).toBe("${TEST_TOKEN}")
    } finally {
      delete process.env["EVIL"]
    }
  })
})

// -------------------------------------------------------------------------
// Discovery integration — env vars in external MCP configs
// -------------------------------------------------------------------------

describe("discoverExternalMcp with env-var interpolation", () => {
  const KEYS_TO_CLEAR = [
    "TEST_MCP_TOKEN",
    "TEST_MCP_HOST",
    "UNSET_VAR_ABC",
    "EVIL_MCP_VAR",
    "TEST_MCP_SECRET",
  ]

  beforeEach(() => {
    process.env["TEST_MCP_TOKEN"] = "glpat-secret-token"
    process.env["TEST_MCP_HOST"] = "https://gitlab.internal.com"
    delete process.env["UNSET_VAR_ABC"]
  })

  afterEach(() => {
    for (const k of KEYS_TO_CLEAR) delete process.env[k]
  })

  test("resolves ${VAR} in discovered .vscode/mcp.json environment", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    await mkdir(path.join(dir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(dir, ".vscode/mcp.json"),
      JSON.stringify({
        servers: {
          gitlab: {
            command: "node",
            args: ["gitlab-server.js"],
            env: {
              GITLAB_TOKEN: "${TEST_MCP_TOKEN}",
              GITLAB_HOST: "${TEST_MCP_HOST}",
              STATIC_VALUE: "no-interpolation-needed",
            },
          },
        },
      }),
    )

    const { discoverExternalMcp } = await import("../../src/mcp/discover")
    const { servers } = await discoverExternalMcp(dir)

    expect(servers["gitlab"]).toBeDefined()
    expect(servers["gitlab"].type).toBe("local")
    const env = (servers["gitlab"] as any).environment
    expect(env.GITLAB_TOKEN).toBe("glpat-secret-token")
    expect(env.GITLAB_HOST).toBe("https://gitlab.internal.com")
    expect(env.STATIC_VALUE).toBe("no-interpolation-needed")
  })

  test("resolves {env:VAR} in discovered .cursor/mcp.json environment", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    await mkdir(path.join(dir, ".cursor"), { recursive: true })
    await writeFile(
      path.join(dir, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          "my-tool": {
            command: "npx",
            args: ["-y", "my-mcp-tool"],
            env: {
              API_KEY: "{env:TEST_MCP_TOKEN}",
            },
          },
        },
      }),
    )

    const { discoverExternalMcp } = await import("../../src/mcp/discover")
    const { servers } = await discoverExternalMcp(dir)

    expect(servers["my-tool"]).toBeDefined()
    const env = (servers["my-tool"] as any).environment
    expect(env.API_KEY).toBe("glpat-secret-token")
  })

  test("resolves ${VAR:-default} with fallback in discovered config", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    await mkdir(path.join(dir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(dir, ".vscode/mcp.json"),
      JSON.stringify({
        servers: {
          svc: {
            command: "node",
            args: ["svc.js"],
            env: {
              MODE: "${UNSET_VAR_ABC:-production}",
            },
          },
        },
      }),
    )

    const { discoverExternalMcp } = await import("../../src/mcp/discover")
    const { servers } = await discoverExternalMcp(dir)

    const env = (servers["svc"] as any).environment
    expect(env.MODE).toBe("production")
  })

  // ---------- regression tests from PR #666 review ----------

  test("regression: $${VAR} survives end-to-end as literal ${VAR}", async () => {
    // Pre-fix: Layer 1 (parseText in readJsonSafe) would turn `$${VAR}` into `${VAR}`,
    // then Layer 2 (resolveEnvVars at MCP launch) would re-resolve it to the env value.
    // After the fix: single resolution in transform() → `$${VAR}` → `${VAR}` and stays.
    await using tmp = await tmpdir()
    const dir = tmp.path
    await mkdir(path.join(dir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(dir, ".vscode/mcp.json"),
      JSON.stringify({
        servers: {
          svc: {
            command: "node",
            args: ["svc.js"],
            env: {
              TEMPLATE: "$${TEST_MCP_TOKEN}",
            },
          },
        },
      }),
    )

    const { discoverExternalMcp } = await import("../../src/mcp/discover")
    const { servers } = await discoverExternalMcp(dir)

    const env = (servers["svc"] as any).environment
    expect(env.TEMPLATE).toBe("${TEST_MCP_TOKEN}")
  })

  test("regression: chain-injection — env var whose value contains ${OTHER} is not re-resolved", async () => {
    // Pre-fix: EVIL_MCP_VAR="${TEST_MCP_SECRET}" in shell. Config references ${EVIL_MCP_VAR}.
    // Layer 1 resolved to `"${TEST_MCP_SECRET}"` literal, then Layer 2 resolved that literal
    // to the actual secret — exfiltrating TEST_MCP_SECRET even though the config only
    // referenced EVIL_MCP_VAR. After the fix: single pass, result is the literal string.
    process.env["EVIL_MCP_VAR"] = "${TEST_MCP_SECRET}"
    process.env["TEST_MCP_SECRET"] = "leaked-secret-value"

    await using tmp = await tmpdir()
    const dir = tmp.path
    await mkdir(path.join(dir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(dir, ".vscode/mcp.json"),
      JSON.stringify({
        servers: {
          svc: {
            command: "node",
            args: ["svc.js"],
            env: {
              X: "${EVIL_MCP_VAR}",
            },
          },
        },
      }),
    )

    const { discoverExternalMcp } = await import("../../src/mcp/discover")
    const { servers } = await discoverExternalMcp(dir)

    const env = (servers["svc"] as any).environment
    expect(env.X).toBe("${TEST_MCP_SECRET}")
    expect(env.X).not.toBe("leaked-secret-value")
  })

  test("regression: resolves ${VAR} in headers for remote MCP servers", async () => {
    // The original PR only fixed environment. Headers (Authorization, etc.)
    // commonly contain tokens and need the same resolution.
    await using tmp = await tmpdir()
    const dir = tmp.path
    await mkdir(path.join(dir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(dir, ".vscode/mcp.json"),
      JSON.stringify({
        servers: {
          "remote-svc": {
            url: "https://api.example.com/mcp",
            headers: {
              Authorization: "Bearer ${TEST_MCP_TOKEN}",
              "X-Host": "${TEST_MCP_HOST}",
              "X-Static": "fixed-value",
            },
          },
        },
      }),
    )

    const { discoverExternalMcp } = await import("../../src/mcp/discover")
    const { servers } = await discoverExternalMcp(dir)

    expect(servers["remote-svc"]).toBeDefined()
    expect(servers["remote-svc"].type).toBe("remote")
    const headers = (servers["remote-svc"] as any).headers
    expect(headers.Authorization).toBe("Bearer glpat-secret-token")
    expect(headers["X-Host"]).toBe("https://gitlab.internal.com")
    expect(headers["X-Static"]).toBe("fixed-value")
  })

  test("scopes resolution to env/headers — does not touch command args or URLs", async () => {
    // Regression guard for Major #5 from the PR review: env-var substitution must not
    // run over the whole JSON text. Only env and headers values should be resolved.
    await using tmp = await tmpdir()
    const dir = tmp.path
    await mkdir(path.join(dir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(dir, ".vscode/mcp.json"),
      JSON.stringify({
        servers: {
          // command args contain ${TEST_MCP_TOKEN} — must NOT be resolved
          svc: {
            command: "node",
            args: ["--token=${TEST_MCP_TOKEN}", "server.js"],
          },
          "remote-svc": {
            // URL contains ${TEST_MCP_HOST} — must NOT be resolved
            url: "https://${TEST_MCP_HOST}/mcp",
          },
        },
      }),
    )

    const { discoverExternalMcp } = await import("../../src/mcp/discover")
    const { servers } = await discoverExternalMcp(dir)

    const local = servers["svc"] as any
    expect(local.command).toEqual(["node", "--token=${TEST_MCP_TOKEN}", "server.js"])
    const remote = servers["remote-svc"] as any
    expect(remote.url).toBe("https://${TEST_MCP_HOST}/mcp")
  })
})
// altimate_change end
