// altimate_change start — upstream_fix (#878): `mcp status` must exist and must report drift.
// Drives the real binary in an isolated HOME. The subprocess harness lives in
// ./fixtures/isolated-cli so this file and mcp-env-diagnostics.test.ts cannot drift apart.
import { describe, expect, test } from "bun:test"
import { SUBPROCESS_TIMEOUT_MS, withIsolatedCli } from "./fixtures/isolated-cli"
// altimate_change end

const brokenServer = {
  broken: {
    type: "local",
    command: ["/nonexistent-binary-for-mcp-status-test"],
    environment: { API_TOKEN: "{env:ALTIMATE_TEST_VAR_THAT_IS_NEVER_SET}" },
    enabled: true,
  },
}

describe("altimate-code mcp status", () => {
  test(
    "`status` reaches the server listing",
    () =>
      withIsolatedCli(brokenServer, (output) => {
        const out = output(["mcp", "status"])
        expect(out, out).toContain("broken")
        expect(out, out).not.toContain("Unknown argument")
      }),
    SUBPROCESS_TIMEOUT_MS,
  )
})
// altimate_change end

// altimate_change start — upstream_fix (#878): drift must reach the user, not just the record.
describe("altimate-code mcp status — discovered config drift", () => {
  const configured = {
    datamate: {
      type: "local",
      command: ["/nonexistent-binary-for-mcp-status-test"],
      environment: { ALTIMATE_EXTENSION_RPC: "127.0.0.1:9000" },
      enabled: true,
    },
  }
  const vscode = (rpc: string) =>
    JSON.stringify({
      servers: {
        datamate: {
          type: "stdio",
          command: "/nonexistent-binary-for-mcp-status-test",
          env: { ALTIMATE_EXTENSION_RPC: rpc },
        },
      },
    })

  test(
    "reports the field that drifted from the discovered config",
    () =>
      withIsolatedCli(
        configured,
        (output) => {
          const out = output(["mcp", "status"])
          expect(out, out).toContain("datamate")
          expect(out, out).toContain("environment.ALTIMATE_EXTENSION_RPC")
        },
        { ".vscode/mcp.json": vscode("127.0.0.1:9999") },
      ),
    SUBPROCESS_TIMEOUT_MS,
  )

  test(
    "says nothing when the discovered config agrees",
    () =>
      withIsolatedCli(
        configured,
        (output) => {
          const out = output(["mcp", "status"])
          expect(out, out).toContain("datamate")
          expect(out, out).not.toContain("environment.ALTIMATE_EXTENSION_RPC")
        },
        { ".vscode/mcp.json": vscode("127.0.0.1:9000") },
      ),
    SUBPROCESS_TIMEOUT_MS,
  )
})
// altimate_change end
