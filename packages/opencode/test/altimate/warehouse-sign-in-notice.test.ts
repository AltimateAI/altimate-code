// @ts-nocheck
/**
 * A warehouse waiting on a browser sign-in is shown to the user (a TUI toast for
 * the whole wait, or one stderr line under `run`), and every connection attempt
 * is recorded before it starts, so one that hangs or ends the process still
 * leaves a trace.
 */
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Telemetry } from "../../src/altimate/telemetry"
import * as Registry from "../../src/altimate/native/connections/registry"
import * as SignInNotice from "../../src/altimate/native/connections/sign-in-notice"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"

const URL_WITH_QUERY = "https://idp.example.com/sso/saml?SAMLRequest=abc"
const waiting = { warehouse: "snowflake", account: "acme-xy123", phase: "waiting", url: URL_WITH_QUERY, timeoutMs: 120_000 }

function deps(headless: boolean) {
  const toasts: any[] = []
  const lines: string[] = []
  return {
    toasts,
    lines,
    deps: { headless: () => headless, toast: async (t) => void toasts.push(t), printLine: (l) => lines.push(l) },
  }
}

describe("browser sign-in notice", () => {
  test("the toast carries the workspace the connect started in, though the SDK calls back outside it", async () => {
    // A toast published without a workspace is dropped by a TUI showing one, so the notice remembers where
    // the connect began and publishes there.
    SignInNotice.resetForTests()
    const seen: any[] = []
    await WorkspaceContext.provide({ workspaceID: "wrk_signin", fn: () => SignInNotice.rememberOrigin(waiting.account) })
    SignInNotice.handle(waiting, { headless: () => false, toast: async (_t, from) => void seen.push(from), printLine: () => {} })
    expect(seen).toHaveLength(1)
    expect(seen[0].workspace).toBe("wrk_signin")
    SignInNotice.resetForTests()
  })

  test("overlapping connects to different accounts each reach their own workspace", async () => {
    SignInNotice.resetForTests()
    const seen: any[] = []
    const d = { headless: () => false, toast: async (t: any, from: any) => void seen.push([t.message, from.workspace]), printLine: () => {} }
    await WorkspaceContext.provide({ workspaceID: "wrk_a", fn: () => SignInNotice.rememberOrigin("acct-a") })
    await WorkspaceContext.provide({ workspaceID: "wrk_b", fn: () => SignInNotice.rememberOrigin("acct-b") })
    SignInNotice.handle({ ...waiting, account: "acct-a" }, d)
    expect(seen[0][1]).toBe("wrk_a")
    SignInNotice.resetForTests()
  })

  test("the TUI shows the sign-in for the whole wait, with the account and the link", () => {
    const d = deps(false)
    SignInNotice.handle(waiting, d.deps)
    expect(d.toasts).toHaveLength(1)
    const t = d.toasts[0]
    expect(t.duration).toBe(120_000)
    expect(t.variant).toBe("warning")
    expect(t.message).toContain("Sign in to Snowflake (account acme-xy123) in your browser")
    expect(t.message).toContain("Waiting up to 2 minutes")
    expect(t.message).toContain(URL_WITH_QUERY)
    expect(d.lines).toEqual([])
  })

  test("headless `run` prints the waiting line to stderr instead of a toast", () => {
    const d = deps(true)
    SignInNotice.handle(waiting, d.deps)
    SignInNotice.handle({ warehouse: "snowflake", account: "acme-xy123", phase: "completed" }, d.deps)
    expect(d.toasts).toEqual([])
    expect(d.lines).toHaveLength(1)
    expect(d.lines[0]).toStartWith("Waiting for sign-in: Sign in to Snowflake")
  })

  test("a completed sign-in is confirmed briefly; a failed one replaces the waiting toast at once", () => {
    const d = deps(false)
    SignInNotice.handle({ warehouse: "snowflake", account: "a", phase: "completed" }, d.deps)
    SignInNotice.handle({ warehouse: "snowflake", account: "a", phase: "failed" }, d.deps)
    expect(d.toasts.map((t) => t.variant)).toEqual(["success", "error"])
    expect(d.toasts[1].duration).toBeLessThan(10_000)
  })

  test("control characters from the identity provider never reach the screen", () => {
    const t = SignInNotice.toastFor({ ...waiting, url: "https://idp.example.com/x\u001b[2J\u2028y", account: "ac\u0007me" })
    expect(t.message).not.toMatch(/[\u0000-\u001F\u2028]/)
    expect(t.message).toContain("account acme")
  })
})

describe("connection attempts are recorded before connecting", () => {
  const tracked: any[] = []
  const trackSpy = spyOn(Telemetry, "track").mockImplementation((e: any) => void tracked.push(e))
  const ctxSpy = spyOn(Telemetry, "getContext").mockImplementation(() => ({ sessionId: "s1", projectId: "p1" }))
  afterAll(() => {
    trackSpy.mockRestore()
    ctxSpy.mockRestore()
    // Registry.get installs the process-wide sign-in listener; later test files must not inherit it.
    SignInNotice.resetForTests()
  })
  beforeEach(() => {
    Registry.reset()
    tracked.length = 0
  })

  test("a start event precedes the outcome, with the same auth method", async () => {
    Registry.setConfigs({ sf: { type: "unsupported_db_type", authenticator: "externalbrowser" } })
    await Registry.get("sf").catch(() => {})
    const types = tracked.map((e) => e.type).filter((t) => t.startsWith("warehouse_connect"))
    expect(types).toEqual(["warehouse_connect_started", "warehouse_connect"])
    expect(tracked[0].auth_method).toBe(tracked[1].auth_method)
  })

  test("a saved connection with no type still reports one on its start event", async () => {
    Registry.setConfigs({ notype: { account: "a" } as any })
    await Registry.get("notype").catch(() => {})
    expect(tracked.find((e) => e.type === "warehouse_connect_started")?.warehouse_type).toBe("unknown")
  })

  test("the driver's SSO and connect-limit errors get their own categories", () => {
    expect(
      Registry.categorizeConnectionError(
        new Error("Snowflake browser sign-in for account 'a' was not completed within 2 minutes. A sign-in page was opened"),
      ),
    ).toBe("sso_not_completed")
    expect(
      Registry.categorizeConnectionError(
        new Error("Snowflake did not accept the connection within 120 seconds. The network may be blocking"),
      ),
    ).toBe("connect_timeout")
  })
})
