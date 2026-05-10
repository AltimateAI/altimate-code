// altimate_change start — tests for issue #701: surface unresolved MCP env-var warnings
// Verifies the per-discovery accumulator correctly captures, dedupes, and resets
// unresolved ${VAR} references found in discovered MCP server env/headers blocks.
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { consumeUnresolvedEnvVars, discoverExternalMcp } from "../../src/mcp/discover"

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "mcp-unresolved-env-"))
  // Drain anything left over from prior tests so we start clean.
  consumeUnresolvedEnvVars()
  delete process.env["UNRESOLVED_TEST_VAR_A"]
  delete process.env["UNRESOLVED_TEST_VAR_B"]
  delete process.env["UNRESOLVED_TEST_TOKEN"]
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
  // Empty the accumulator so a failed test doesn't poison the next one.
  consumeUnresolvedEnvVars()
  delete process.env["UNRESOLVED_TEST_VAR_A"]
  delete process.env["UNRESOLVED_TEST_VAR_B"]
  delete process.env["UNRESOLVED_TEST_TOKEN"]
})

describe("consumeUnresolvedEnvVars (issue #701)", () => {
  test("captures unresolved ${VAR} in a local server's env block", async () => {
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".vscode/mcp.json"),
      JSON.stringify({
        servers: {
          snowflake: {
            command: "snowflake-mcp",
            env: {
              SNOWFLAKE_ACCOUNT: "myaccount",
              SNOWFLAKE_PASSWORD: "${UNRESOLVED_TEST_TOKEN}",
            },
          },
        },
      }),
    )

    await discoverExternalMcp(tempDir)
    const records = consumeUnresolvedEnvVars()

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      server: "snowflake",
      field: "env",
      vars: ["UNRESOLVED_TEST_TOKEN"],
    })
    expect(records[0].source).toContain(".vscode/mcp.json")
  })

  test("captures unresolved ${VAR} in a remote server's headers block", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          api: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer ${UNRESOLVED_TEST_TOKEN}" },
          },
        },
      }),
    )

    await discoverExternalMcp(tempDir)
    const records = consumeUnresolvedEnvVars()

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      server: "api",
      field: "headers",
      vars: ["UNRESOLVED_TEST_TOKEN"],
    })
  })

  test("dedupes when the same VAR appears in multiple keys of one block", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: {
            command: "node",
            env: {
              PRIMARY: "${UNRESOLVED_TEST_VAR_A}",
              SECONDARY: "${UNRESOLVED_TEST_VAR_A}-suffix",
            },
          },
        },
      }),
    )

    await discoverExternalMcp(tempDir)
    const records = consumeUnresolvedEnvVars()

    expect(records).toHaveLength(1)
    expect(records[0].vars).toEqual(["UNRESOLVED_TEST_VAR_A"])
  })

  test("captures multiple distinct vars in one block", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: {
            command: "node",
            env: {
              A: "${UNRESOLVED_TEST_VAR_A}",
              B: "${UNRESOLVED_TEST_VAR_B}",
            },
          },
        },
      }),
    )

    await discoverExternalMcp(tempDir)
    const records = consumeUnresolvedEnvVars()

    expect(records).toHaveLength(1)
    expect(records[0].vars.sort()).toEqual(["UNRESOLVED_TEST_VAR_A", "UNRESOLVED_TEST_VAR_B"])
  })

  test("does NOT capture ${VAR:-default} — default makes it intentional", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: {
            command: "node",
            env: { LOG_LEVEL: "${UNRESOLVED_TEST_VAR_A:-info}" },
          },
        },
      }),
    )

    await discoverExternalMcp(tempDir)
    const records = consumeUnresolvedEnvVars()

    expect(records).toHaveLength(0)
  })

  test("does NOT capture $${VAR} — escaped is a literal, not a reference", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: {
            command: "node",
            env: { TEMPLATE: "$${UNRESOLVED_TEST_VAR_A}" },
          },
        },
      }),
    )

    await discoverExternalMcp(tempDir)
    const records = consumeUnresolvedEnvVars()

    expect(records).toHaveLength(0)
  })

  test("does NOT capture when the env var is set", async () => {
    process.env["UNRESOLVED_TEST_TOKEN"] = "actual-value"
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: {
            command: "node",
            env: { TOKEN: "${UNRESOLVED_TEST_TOKEN}" },
          },
        },
      }),
    )

    await discoverExternalMcp(tempDir)
    const records = consumeUnresolvedEnvVars()

    expect(records).toHaveLength(0)
  })

  test("captures separate records for env and headers in the same server", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          mixed: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer ${UNRESOLVED_TEST_VAR_A}" },
          },
          local: {
            command: "node",
            env: { TOKEN: "${UNRESOLVED_TEST_VAR_B}" },
          },
        },
      }),
    )

    await discoverExternalMcp(tempDir)
    const records = consumeUnresolvedEnvVars()

    expect(records).toHaveLength(2)
    const byServer = Object.fromEntries(records.map((r) => [r.server, r]))
    expect(byServer["mixed"]).toMatchObject({ field: "headers", vars: ["UNRESOLVED_TEST_VAR_A"] })
    expect(byServer["local"]).toMatchObject({ field: "env", vars: ["UNRESOLVED_TEST_VAR_B"] })
  })

  test("consume is one-shot: a second call returns an empty array", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: { command: "node", env: { T: "${UNRESOLVED_TEST_TOKEN}" } },
        },
      }),
    )

    await discoverExternalMcp(tempDir)
    expect(consumeUnresolvedEnvVars()).toHaveLength(1)
    expect(consumeUnresolvedEnvVars()).toHaveLength(0)
  })

  test("each discovery run resets the accumulator (no stale records)", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: { command: "node", env: { T: "${UNRESOLVED_TEST_TOKEN}" } },
        },
      }),
    )
    await discoverExternalMcp(tempDir)
    // Intentionally don't consume — simulate a missed drain.

    // Now run a clean discovery in a fresh dir.
    const cleanDir = await mkdtemp(path.join(tmpdir(), "mcp-clean-"))
    await writeFile(
      path.join(cleanDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          ok: { command: "node", env: { LITERAL: "no-vars-here" } },
        },
      }),
    )
    try {
      await discoverExternalMcp(cleanDir)
      // The first run's record must NOT carry over.
      expect(consumeUnresolvedEnvVars()).toHaveLength(0)
    } finally {
      await rm(cleanDir, { recursive: true, force: true })
    }
  })

  test("records the source label for project-scoped configs", async () => {
    await mkdir(path.join(tempDir, ".cursor"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: { command: "node", env: { T: "${UNRESOLVED_TEST_TOKEN}" } },
        },
      }),
    )

    await discoverExternalMcp(tempDir)
    const records = consumeUnresolvedEnvVars()
    expect(records[0].source).toBe(".cursor/mcp.json")
  })
})
// altimate_change end
