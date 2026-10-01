/**
 * A Snowflake connection that the SDK reports as closed (idle session expiry,
 * VPN drop, laptop sleep) is reopened instead of failing every later statement
 * with "Unable to perform operation using terminated connection" until restart.
 */
import { describe, test, expect } from "bun:test"
import { connect, isClosedConnectionError, keepAliveSetting } from "../src/snowflake"

type Behaviour = { up: boolean; failNextWith?: { code: unknown; message: string } }

/** A minimal stand-in for snowflake-sdk: records connections and lets a test close them. */
function fakeSdk() {
  const created: Array<{ options: any; state: Behaviour; destroyed: boolean; executed: string[] }> = []
  const sdk = {
    configure() {},
    createConnection(options: any) {
      const entry = { options, state: { up: true } as Behaviour, destroyed: false, executed: [] as string[] }
      created.push(entry)
      return {
        connect(cb: (err: Error | null) => void) {
          setTimeout(() => cb(null), 1)
        },
        isUp: () => entry.state.up,
        execute(opts: { sqlText: string; complete: (err: any, stmt: any, rows: any[]) => void }) {
          if (entry.state.failNextWith) {
            const f = entry.state.failNextWith
            entry.state.failNextWith = undefined
            const err = Object.assign(new Error(f.message), { code: f.code })
            setTimeout(() => opts.complete(err, null, []), 1)
            return
          }
          entry.executed.push(opts.sqlText)
          setTimeout(() => opts.complete(null, null, [{ N: created.indexOf(entry) }]), 1)
        },
        destroy(cb: (err: Error | null) => void) {
          entry.destroyed = true
          cb(null)
        },
      }
    },
  }
  return { sdk, created }
}

const config = { type: "snowflake", account: "acct", user: "u", password: "p" } as any

describe("Snowflake connection lifecycle", () => {
  test("keep-alive is on by default and can be turned off", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    expect(created[0].options.clientSessionKeepAlive).toBe(true)

    const off = fakeSdk()
    const c2 = await connect({ ...config, client_session_keep_alive: false }, off.sdk)
    await c2.connect()
    expect(off.created[0].options.clientSessionKeepAlive).toBe(false)
  })

  test("a connection the SDK reports as down is reopened before the statement runs", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    created[0].state.up = false

    const result = await c.execute("SELECT 1")
    expect(created.length).toBe(2)
    expect(created[0].destroyed).toBe(true)
    expect(created[0].executed).toEqual([])
    expect(created[1].executed).toEqual(["SELECT 1 LIMIT 1001"])
    expect(result.rows).toEqual([[1]])
    // The reopened connection keeps the original options, keep-alive included.
    expect(created[1].options).toEqual(created[0].options)
  })

  test("a statement refused because the session was already closed is retried once on a new connection", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    // isUp() still says yes, but the SDK refuses the statement: the race isUp() cannot close.
    created[0].state.failNextWith = { code: 407002, message: "Unable to perform operation using terminated connection." }

    const result = await c.execute("SELECT 1")
    expect(created.length).toBe(2)
    expect(created[1].executed).toEqual(["SELECT 1 LIMIT 1001"])
    expect(result.rows).toEqual([[1]])
  })

  test("an expired session token (390114) is also retried", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    created[0].state.failNextWith = { code: "390114", message: "Authentication token has expired." }
    await c.execute("SELECT 1")
    expect(created.length).toBe(2)
  })

  test("any other error is not retried, so a statement is never sent twice", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    created[0].state.failNextWith = { code: "002003", message: "SQL compilation error: Object 'X' does not exist" }
    await expect(c.execute("INSERT INTO x VALUES (1)")).rejects.toThrow("does not exist")
    expect(created.length).toBe(1)
  })

  test("concurrent statements on a dead connection share one reconnect", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    created[0].state.up = false
    await Promise.all([c.execute("SELECT 1"), c.execute("SELECT 2"), c.listSchemas()])
    expect(created.length).toBe(2)
    expect(created[1].executed.length).toBe(3)
  })
})

describe("isClosedConnectionError", () => {
  test("matches only errors raised before the statement reached Snowflake", () => {
    expect(isClosedConnectionError({ code: 407002 })).toBe(true)
    expect(isClosedConnectionError({ code: "407002" })).toBe(true)
    expect(isClosedConnectionError({ code: "390114" })).toBe(true)
    expect(isClosedConnectionError({ code: "390111" })).toBe(true)
    expect(isClosedConnectionError({ code: 390112 })).toBe(true)
    expect(isClosedConnectionError(new Error("Unable to perform operation using terminated connection."))).toBe(true)
    for (const e of [null, undefined, "boom", { code: 390100 }, { code: "002003" }, new Error("Network error"), new Error("Request timed out")]) {
      expect(isClosedConnectionError(e)).toBe(false)
    }
  })
})

describe("keepAliveSetting", () => {
  test("only an explicit false turns keep-alive off", () => {
    expect(keepAliveSetting({} as any)).toBe(true)
    expect(keepAliveSetting({ client_session_keep_alive: true } as any)).toBe(true)
    expect(keepAliveSetting({ clientSessionKeepAlive: "true" } as any)).toBe(true)
    for (const off of [false, "false", 0, "0"]) {
      expect(keepAliveSetting({ client_session_keep_alive: off } as any)).toBe(false)
      expect(keepAliveSetting({ clientSessionKeepAlive: off } as any)).toBe(false)
    }
  })
})
