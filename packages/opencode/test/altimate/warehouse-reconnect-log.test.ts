// altimate_change - new file
/**
 * A driver reopening a session the warehouse closed (idle timeout, VPN drop, sleep) is written to
 * opencode.log. The statement carries on and the user sees nothing, so the log is the only trace of it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as ReconnectLog from "../../src/altimate/native/connections/reconnect-log"
import { emitReconnect } from "../../../drivers/src/reconnect-events"

function recorder() {
  const lines: Array<{ level: string; service: string; message: string; fields: Record<string, unknown> }> = []
  const write = (level: string, service: string, message: string, fields: Record<string, unknown> = {}) =>
    void lines.push({ level, service, message, fields })
  return { lines, write: write as any }
}

// Connects elsewhere in the run install the default writer; each test starts unsubscribed.
beforeEach(() => ReconnectLog.resetForTests())
afterEach(() => ReconnectLog.resetForTests())

describe("reconnect log", () => {
  test("a reconnect is written as reconnecting then reconnected, under the connection's name", () => {
    const r = recorder()
    ReconnectLog.install(r.write)
    ReconnectLog.remember("acme-xy123", "prod_snowflake")
    emitReconnect({ warehouse: "snowflake", account: "acme-xy123", phase: "started", reason: "connection-down" })
    emitReconnect({
      warehouse: "snowflake",
      account: "acme-xy123",
      phase: "reconnected",
      reason: "connection-down",
      durationMs: 812,
      settingsRestored: 2,
      sessionStateLost: false,
    })
    expect(r.lines.map((l) => [l.level, l.service, l.message])).toEqual([
      ["INFO", "warehouse-connect", "reconnecting"],
      ["INFO", "warehouse-connect", "reconnected"],
    ])
    expect(r.lines[1].fields).toEqual({
      name: "prod_snowflake",
      type: "snowflake",
      account: "acme-xy123",
      reason: "connection-down",
      duration_ms: 812,
      settings_restored: 2,
      session_state_lost: false,
    })
  })

  test("a failed reconnect is a warning, with the error masked", () => {
    const r = recorder()
    ReconnectLog.handle(
      {
        warehouse: "snowflake",
        account: "acme-xy123",
        phase: "failed",
        reason: "statement-refused",
        durationMs: 120_000,
        error: "login failed for jane@example.com",
      },
      r.write,
    )
    expect(r.lines[0].level).toBe("WARN")
    expect(r.lines[0].message).toBe("reconnect failed")
    expect(String(r.lines[0].fields.error)).not.toContain("jane@example.com")
  })

  test("an account shared by two connections is logged by account only", () => {
    const r = recorder()
    ReconnectLog.remember("shared-acct", "a")
    ReconnectLog.remember("shared-acct", "b")
    ReconnectLog.handle({ warehouse: "snowflake", account: "shared-acct", phase: "started", reason: "connection-down" }, r.write)
    expect(r.lines[0].fields.name).toBeUndefined()
    expect(r.lines[0].fields.account).toBe("shared-acct")
  })
})
