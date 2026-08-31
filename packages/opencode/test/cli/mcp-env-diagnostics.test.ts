// altimate_change start — upstream_fix (#701): the server listing must name environment variables
// that silently resolved to "". This is user-facing CLI behaviour, so it drives the real binary in
// an isolated HOME rather than calling the handler directly. The subprocess harness lives in
// ./fixtures/isolated-cli so this file and mcp-status.test.ts cannot drift apart.
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

describe("altimate-code mcp list — env diagnostics", () => {
  test(
    "`status` reaches the server listing",
    () =>
      withIsolatedCli(brokenServer, (output) => {
        const out = output(["mcp", "list"])
        expect(out, out).toContain("broken")
        expect(out, out).not.toContain("Unknown argument")
        // The point of this PR is that the *reason* reaches the user, not just the name. The
        // command above is a nonexistent binary, so the listing has to carry the failure —
        // without this the test passed even with `status.error` dropped from the payload,
        // which is the exact regression it is named after.
        expect(out.toLowerCase(), out).toMatch(/failed|enoent|no such file|spawn/)
      }),
    SUBPROCESS_TIMEOUT_MS,
  )

  test(
    "names the config env var that silently resolved to empty",
    () =>
      withIsolatedCli(brokenServer, (output) => {
        const out = output(["mcp", "list"])
        expect(out, out).toContain("ALTIMATE_TEST_VAR_THAT_IS_NEVER_SET")
        expect(out, out).toContain("resolved to empty")
      }),
    SUBPROCESS_TIMEOUT_MS,
  )

  test(
    "says nothing about env when every variable resolves",
    () =>
      withIsolatedCli(
        { fine: { type: "local", command: ["/nonexistent-binary-for-mcp-status-test"], enabled: true } },
        (output) => {
          const out = output(["mcp", "list"])
          expect(out, out).toContain("fine")
          expect(out, out).not.toContain("resolved to empty")
        },
      ),
    SUBPROCESS_TIMEOUT_MS,
  )
})
// altimate_change end
