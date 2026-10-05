/**
 * A Snowflake connection that the SDK reports as closed (idle session expiry,
 * VPN drop, laptop sleep) is reopened instead of failing every later statement
 * with "Unable to perform operation using terminated connection" until restart.
 */
import { describe, test, expect } from "bun:test"
import { changesSession, connect, isClosedConnectionError, isRetrySafe, keepAliveSetting } from "../src/snowflake"

type Failure = { code: unknown; message: string; delayMs?: number }
type Behaviour = { up: boolean; failNextWith?: Failure; failQueue?: Failure[] }

/** A minimal stand-in for snowflake-sdk: records connections and lets a test close them. `gate`, when set, holds
 * every new connect() until the test calls it. */
function fakeSdk() {
  const created: Array<{ options: any; state: Behaviour; destroyed: boolean; executed: string[] }> = []
  const held: Array<() => void> = []
  const sdk = {
    hold: false,
    release() {
      for (const r of held.splice(0)) r()
    },
    configure() {},
    createConnection(options: any) {
      const entry = { options, state: { up: true } as Behaviour, destroyed: false, executed: [] as string[] }
      created.push(entry)
      return {
        connect(cb: (err: Error | null) => void) {
          if (sdk.hold) held.push(() => cb(null))
          else setTimeout(() => cb(null), 1)
        },
        isUp: () => entry.state.up,
        execute(opts: { sqlText: string; complete: (err: any, stmt: any, rows: any[]) => void }) {
          const f = entry.state.failNextWith ?? entry.state.failQueue?.shift()
          if (f) {
            entry.state.failNextWith = undefined
            const err = Object.assign(new Error(f.message), { code: f.code })
            setTimeout(() => opts.complete(err, null, []), f.delayMs ?? 1)
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
    expect(created[0].executed).toEqual([])
    expect(created[1].executed).toEqual(["SELECT 1 LIMIT 1001"])
    expect(result.rows).toEqual([[1]])
  })

  test("a write whose session closed mid-statement is not sent again: it may already have run", async () => {
    // 407002 is also what the SDK returns when it polls for the result of a statement Snowflake already accepted.
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    created[0].state.failNextWith = { code: 407002, message: "Unable to perform operation using terminated connection." }
    await expect(c.execute("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE")).rejects.toThrow(
      "it may change data and could already have run",
    )
    expect(created.length).toBe(2) // reopened for the next statement
    expect(created[1].executed).toEqual([])
    const after = await c.execute("SELECT 1")
    expect(after.rows).toEqual([[1]])
  })

  test("a late error from a connection already replaced does not replace the new one", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    // Two statements in flight on the first connection; one fails at once, the other only after the reconnect.
    created[0].state.failQueue = [
      { code: 407002, message: "terminated connection", delayMs: 1 },
      { code: 407002, message: "terminated connection", delayMs: 40 },
    ]
    const [a, b] = await Promise.all([c.execute("SELECT 1"), c.execute("SELECT 2")])
    expect(created.length).toBe(2)
    expect(created[1].destroyed).toBe(false)
    expect(created[1].executed).toEqual(["SELECT 1 LIMIT 1001", "SELECT 2 LIMIT 1001"])
    expect(a.rows).toEqual([[1]])
    expect(b.rows).toEqual([[1]])
  })

  test("close() while a reconnect is pending leaves no live session behind", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    created[0].state.up = false
    sdk.hold = true
    const running = c.execute("SELECT 1")
    await new Promise((r) => setTimeout(r, 5))
    const closing = c.close()
    sdk.release()
    await closing
    await expect(running).rejects.toThrow("closed while reconnecting")
    expect(created.length).toBe(2)
    expect(created[1].destroyed).toBe(true)
  })

  test("a session that ran USE is not silently replaced: the next statement says so, then runs normally", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    await c.execute("USE SCHEMA analytics")
    created[0].state.failNextWith = { code: 407002, message: "terminated connection" }
    await expect(c.execute("SELECT * FROM orders")).rejects.toThrow("run those statements again first")
    expect(created[1].executed).toEqual([])
    expect((await c.execute("SELECT 1")).rows).toEqual([[1]])
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

describe("isRetrySafe", () => {
  test("only a single read-only statement may be sent twice", () => {
    for (const ok of [
      "SELECT 1",
      "  select * from t limit 5",
      "-- why\nSELECT 1",
      "/* note */ WITH a AS (SELECT 1) SELECT * FROM a",
      "SHOW SCHEMAS",
      "DESCRIBE TABLE t",
      "SELECT 'insert into x' AS label",
      "SELECT 1;",
    ])
      expect(isRetrySafe(ok)).toBe(true)
    for (const no of [
      "INSERT INTO t VALUES (1)",
      "MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN DELETE",
      "CREATE TABLE t AS SELECT 1",
      "WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a",
      "SELECT 1; DELETE FROM t",
      "CALL refresh()",
      "COPY INTO t FROM @s",
      "USE SCHEMA x",
      "",
    ])
      expect(isRetrySafe(no)).toBe(false)
  })

  test("session-changing statements are recognised", () => {
    for (const yes of ["USE SCHEMA x", "use warehouse w", "ALTER SESSION SET TIMEZONE = 'UTC'", "SET v = 1", "CREATE TEMP TABLE t (a int)", "create or replace temporary table t as select 1", "BEGIN"])
      expect(changesSession(yes)).toBe(true)
    for (const no of ["SELECT 1", "CREATE TABLE t (a int)", "ALTER TABLE t ADD c int"]) expect(changesSession(no)).toBe(false)
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
