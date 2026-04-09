// altimate_change start — tests for MCP env-var interpolation (closes #656)
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { resolveEnvVars } from "../../src/mcp"
import { tmpdir } from "../fixture/fixture"

// -------------------------------------------------------------------------
// resolveEnvVars — safety-net resolver at MCP launch site
// -------------------------------------------------------------------------

describe("resolveEnvVars", () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    process.env["TEST_TOKEN"] = "secret-123"
    process.env["TEST_HOST"] = "gitlab.example.com"
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  test("resolves ${VAR} syntax", () => {
    const result = resolveEnvVars({
      API_TOKEN: "${TEST_TOKEN}",
      HOST: "${TEST_HOST}",
    })
    expect(result.API_TOKEN).toBe("secret-123")
    expect(result.HOST).toBe("gitlab.example.com")
  })

  test("resolves {env:VAR} syntax", () => {
    const result = resolveEnvVars({
      API_TOKEN: "{env:TEST_TOKEN}",
    })
    expect(result.API_TOKEN).toBe("secret-123")
  })

  test("resolves ${VAR:-default} with fallback when unset", () => {
    const result = resolveEnvVars({
      MODE: "${UNSET_VAR:-production}",
    })
    expect(result.MODE).toBe("production")
  })

  test("resolves ${VAR:-default} to env value when set", () => {
    const result = resolveEnvVars({
      TOKEN: "${TEST_TOKEN:-fallback}",
    })
    expect(result.TOKEN).toBe("secret-123")
  })

  test("preserves $${VAR} as literal ${VAR}", () => {
    const result = resolveEnvVars({
      TEMPLATE: "$${TEST_TOKEN}",
    })
    expect(result.TEMPLATE).toBe("${TEST_TOKEN}")
  })

  test("resolves unset variable to empty string", () => {
    const result = resolveEnvVars({
      MISSING: "${COMPLETELY_UNSET_VAR_XYZ}",
    })
    expect(result.MISSING).toBe("")
  })

  test("passes through plain values without modification", () => {
    const result = resolveEnvVars({
      PLAIN: "just-a-string",
      URL: "https://gitlab.com/api/v4",
    })
    expect(result.PLAIN).toBe("just-a-string")
    expect(result.URL).toBe("https://gitlab.com/api/v4")
  })

  test("resolves multiple variables in a single value", () => {
    const result = resolveEnvVars({
      URL: "https://${TEST_HOST}/api?token=${TEST_TOKEN}",
    })
    expect(result.URL).toBe("https://gitlab.example.com/api?token=secret-123")
  })

  test("handles mixed resolved and plain entries", () => {
    const result = resolveEnvVars({
      TOKEN: "${TEST_TOKEN}",
      STATIC_URL: "https://gitlab.com/api/v4",
      HOST: "{env:TEST_HOST}",
    })
    expect(result.TOKEN).toBe("secret-123")
    expect(result.STATIC_URL).toBe("https://gitlab.com/api/v4")
    expect(result.HOST).toBe("gitlab.example.com")
  })

  test("does not interpolate bare $VAR without braces", () => {
    const result = resolveEnvVars({
      TOKEN: "$TEST_TOKEN",
    })
    expect(result.TOKEN).toBe("$TEST_TOKEN")
  })

  test("handles empty environment object", () => {
    const result = resolveEnvVars({})
    expect(result).toEqual({})
  })
})

// -------------------------------------------------------------------------
// Discovery integration — env vars in external MCP configs
// -------------------------------------------------------------------------

describe("discoverExternalMcp with env-var interpolation", () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    process.env["TEST_MCP_TOKEN"] = "glpat-secret-token"
    process.env["TEST_MCP_HOST"] = "https://gitlab.internal.com"
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
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
})
// altimate_change end
