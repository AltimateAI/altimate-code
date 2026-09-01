import { describe, expect, test } from "bun:test"
import { unavailableLogFields } from "../../src/mcp/index"

// altimate_change start — upstream_fix: regression guard for #1121.
// The connect path stores the real reason a server would not start — `401 Unauthorized`,
// a transport error, an invalid URL — in `status.error`, but the warning logged only
// `status.status`, which is always the constant "failed". The reporter of #1121 had to
// read this module's source to find out why their server was unreachable.
describe("unavailableLogFields", () => {
  test("carries the real error for a failed connection", () => {
    expect(unavailableLogFields("exodus-mcp", "remote", { status: "failed", error: "401 Unauthorized" })).toEqual({
      key: "exodus-mcp",
      type: "remote",
      status: "failed",
      error: "401 Unauthorized",
    })
  })

  test("carries the error for needs_client_registration too", () => {
    // The other failure state that has something worth reading.
    expect(
      unavailableLogFields("gh", "remote", { status: "needs_client_registration", error: "registration rejected" }),
    ).toEqual({ key: "gh", type: "remote", status: "needs_client_registration", error: "registration rejected" })
  })

  test("omits the key entirely when the status carries no error", () => {
    // `needs_auth` is not a fault — logging `error: undefined` would imply one.
    expect(unavailableLogFields("github", "remote", { status: "needs_auth" })).toEqual({
      key: "github",
      type: "remote",
      status: "needs_auth",
    })
    expect("error" in unavailableLogFields("github", "remote", { status: "needs_auth" })).toBe(false)
  })

  test("never loses the server key or transport type", () => {
    // These are what let an operator find the offending entry in their config.
    const fields = unavailableLogFields("local-one", "local", { status: "failed", error: "spawn ENOENT" })
    expect(fields.key).toBe("local-one")
    expect(fields.type).toBe("local")
  })
})
// altimate_change end
