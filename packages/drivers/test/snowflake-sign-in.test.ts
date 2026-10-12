/**
 * `externalbrowser` SSO: the SDK opens a sign-in page and waits up to two minutes
 * with nothing on screen. The driver now reports the page and the outcome, and a
 * sign-in that never came back is an actionable error, not the SDK's raw timeout.
 * Non-interactive logins get an upper bound instead of the SDK's 300 s retry floor.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { connect, SSO_WAIT_MS } from "../src/snowflake"
import { onBrowserSignIn, redactSignInUrl, setBrowserOpenerForTests, type BrowserSignInNotice } from "../src/sign-in"

const SIGN_IN_URL = "https://idp.example.com/sso/saml?SAMLRequest=abc&RelayState=xyz"

/** snowflake-sdk stand-in: `browser` decides what the SSO sign-in does; `connect` what a plain login does. */
function fakeSdk(opts: { browser?: "complete" | "timeout" | "no-prompt"; connect?: "ok" | "never" }) {
  const created: Array<{ options: any; destroyed: boolean }> = []
  const sdk = {
    configure() {},
    createConnection(options: any) {
      const entry = { options, destroyed: false }
      created.push(entry)
      return {
        async connectAsync(cb: (err: Error | null) => void) {
          if (opts.browser !== "no-prompt") options.openExternalBrowserCallback?.(SIGN_IN_URL)
          setTimeout(() => {
            if (opts.browser === "timeout") {
              cb(new Error("Error while getting SAML token: Browser action timed out after 120000 ms."))
            } else cb(null)
          }, 1)
        },
        connect(cb: (err: Error | null) => void) {
          if (opts.connect === "never") return
          setTimeout(() => cb(null), 1)
        },
        isUp: () => true,
        execute() {},
        destroy(cb: (err: Error | null) => void) {
          entry.destroyed = true
          cb(null)
        },
      }
    },
  }
  return { sdk, created }
}

const sso = { type: "snowflake", account: "acme-xy123", user: "u@example.com", authenticator: "externalbrowser" } as any

let notices: BrowserSignInNotice[]
let opened: string[]
let stopListening: () => void
let restoreOpener: () => void

beforeEach(() => {
  notices = []
  opened = []
  stopListening = onBrowserSignIn((n) => notices.push(n))
  restoreOpener = setBrowserOpenerForTests((url) => opened.push(url))
})

afterEach(() => {
  stopListening()
  restoreOpener()
})

describe("Snowflake browser sign-in", () => {
  test("the sign-in page is announced with its time limit, opened, and its completion reported", async () => {
    const { sdk, created } = fakeSdk({ browser: "complete" })
    const c = await connect(sso, sdk)
    await c.connect()

    expect(created[0].options.browserActionTimeout).toBe(SSO_WAIT_MS)
    expect(opened).toEqual([SIGN_IN_URL])
    expect(notices).toEqual([
      { warehouse: "snowflake", account: "acme-xy123", phase: "waiting", url: SIGN_IN_URL, timeoutMs: SSO_WAIT_MS },
      { warehouse: "snowflake", account: "acme-xy123", phase: "completed" },
    ])
  })

  test("a sign-in that never came back says what to do, instead of the SDK's raw timeout", async () => {
    const { sdk } = fakeSdk({ browser: "timeout" })
    const c = await connect(sso, sdk)
    const err = await c.connect().then(
      () => null,
      (e: Error) => e,
    )
    expect(err?.message).toContain("Snowflake browser sign-in for account 'acme-xy123' was not completed within 2 minutes")
    expect(err?.message).toContain("Ask the user to complete the sign-in")
    expect(err?.message).not.toContain("SAML token")
    expect(notices.map((n) => n.phase)).toEqual(["waiting", "failed"])
  })

  test("no completion is reported for an attempt that never asked the user to sign in", async () => {
    const { sdk } = fakeSdk({ browser: "no-prompt" })
    const c = await connect(sso, sdk)
    await c.connect()
    expect(notices).toEqual([])
    expect(opened).toEqual([])
  })

  test("password logins never announce a browser sign-in", async () => {
    const { sdk, created } = fakeSdk({ connect: "ok" })
    const c = await connect({ type: "snowflake", account: "a", user: "u", password: "p" } as any, sdk)
    await c.connect()
    expect(created[0].options.openExternalBrowserCallback).toBeUndefined()
    expect(notices).toEqual([])
  })

  test("logs keep the sign-in page's host and path but not its SAML query", () => {
    expect(redactSignInUrl(SIGN_IN_URL)).toBe("https://idp.example.com/sso/saml")
  })
})

describe("Snowflake connect time limit", () => {
  test("a login that never answers fails with a network hint instead of hanging", async () => {
    const { sdk, created } = fakeSdk({ connect: "never" })
    const c = await connect({ type: "snowflake", account: "acme", user: "u", password: "p" } as any, sdk, {
      connectTimeoutMs: 20,
    })
    const err = await c.connect().then(
      () => null,
      (e: Error) => e,
    )
    expect(err?.message).toContain("Snowflake did not accept the connection for account 'acme'")
    expect(err?.message).toContain("VPN and proxy")
    expect(created.length).toBe(1)
    // The SDK's own login retries are stopped rather than left running in the background.
    expect(created[0].destroyed).toBe(true)
  })
})
