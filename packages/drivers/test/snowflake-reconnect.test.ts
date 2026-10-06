/**
 * A Snowflake connection that the SDK reports as closed (idle session expiry,
 * VPN drop, laptop sleep) is reopened instead of failing every later statement
 * with "Unable to perform operation using terminated connection" until restart.
 */
import { describe, test, expect } from "bun:test"
import { changesSession, connect, holdsSessionState, isClosedConnectionError, isRetrySafe, isSessionSetting, keepAliveSetting } from "../src/snowflake"

/** `after`: the failure is delivered only once this settles, so a test can order it against a reconnect. */
type Failure = { code: unknown; message: string; delayMs?: number; after?: Promise<unknown> }
/** `holdNext`: the next successful statement completes only once this settles (a statement still running on a
 * connection another statement replaces meanwhile). */
type Behaviour = { up: boolean; failNextWith?: Failure; failQueue?: Failure[]; holdNext?: Promise<unknown> }

/** A minimal stand-in for snowflake-sdk: records connections and lets a test close them. `gate`, when set, holds
 * every new connect() until the test calls it. */
function fakeSdk() {
  const created: Array<{ options: any; state: Behaviour; destroyed: boolean; executed: string[] }> = []
  const held: Array<() => void> = []
  const sdk = {
    hold: false,
    /** Applied to the state of the next connection created (e.g. to hold its first statement). */
    nextState: undefined as Partial<Behaviour> | undefined,
    release() {
      for (const r of held.splice(0)) r()
    },
    configure() {},
    createConnection(options: any) {
      const entry = { options, state: { up: true, ...sdk.nextState } as Behaviour, destroyed: false, executed: [] as string[] }
      sdk.nextState = undefined
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
            const deliver = () => setTimeout(() => opts.complete(err, null, []), f.delayMs ?? 1)
            if (f.after) f.after.then(deliver)
            else deliver()
            return
          }
          entry.executed.push(opts.sqlText)
          const hold = entry.state.holdNext
          entry.state.holdNext = undefined
          const done = () => setTimeout(() => opts.complete(null, null, [{ N: created.indexOf(entry) }]), 1)
          if (hold) hold.then(done)
          else done()
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
    // Two statements in flight on the first connection; one fails at once, the other only once the reconnect
    // has completed (not after a guessed delay, so a paused event loop cannot reorder them).
    let reconnected!: () => void
    const reconnectDone = new Promise<void>((r) => (reconnected = r))
    created[0].state.failQueue = [
      { code: 407002, message: "terminated connection", delayMs: 1 },
      { code: 407002, message: "terminated connection", after: reconnectDone },
    ]
    const a = c.execute("SELECT 1")
    const bPromise = c.execute("SELECT 2")
    await a
    expect(created.length).toBe(2) // the reconnect for SELECT 1 is complete
    reconnected()
    const b = await bPromise
    expect(created.length).toBe(2)
    expect(created[1].destroyed).toBe(false)
    expect(created[1].executed).toEqual(["SELECT 1 LIMIT 1001", "SELECT 2 LIMIT 1001"])
    expect((await a).rows).toEqual([[1]])
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

  test("session settings are restored on the reopened session before anything runs on it", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    await c.execute("USE SCHEMA analytics")
    await c.execute("ALTER SESSION SET TIMEZONE = 'UTC'")
    created[0].state.failNextWith = { code: 407002, message: "terminated connection" }
    await c.execute("SELECT * FROM orders")
    expect(created[1].executed).toEqual(["USE SCHEMA analytics", "ALTER SESSION SET TIMEZONE = 'UTC'", "SELECT * FROM orders LIMIT 1001"])
  })

  test("callers waiting on the same reconnect all get the restored settings", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    await c.execute("USE SCHEMA analytics")
    created[0].state.up = false
    await Promise.all([c.execute("SELECT 1"), c.execute("SELECT 2")])
    expect(created[1].executed[0]).toBe("USE SCHEMA analytics")
    expect(created[1].executed.slice(1).sort()).toEqual(["SELECT 1 LIMIT 1001", "SELECT 2 LIMIT 1001"])
  })

  test("a USE interrupted by a closed session is applied on the new session and remembered", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    created[0].state.failNextWith = { code: 407002, message: "terminated connection" }
    await c.execute("USE SCHEMA analytics")
    expect(created[1].executed).toEqual(["USE SCHEMA analytics"])
    created[1].state.up = false
    await c.execute("SELECT 1")
    expect(created[2].executed).toEqual(["USE SCHEMA analytics", "SELECT 1 LIMIT 1001"])
  })

  test("temporary objects cannot be restored: every statement started before the reconnect says so, later ones run", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    await c.execute("CREATE TEMPORARY TABLE scratch AS SELECT 1 AS a")
    created[0].state.up = false
    // Both were issued against the old session, so both may depend on the temporary table.
    const results = await Promise.allSettled([c.execute("SELECT * FROM scratch"), c.execute("SELECT count(*) FROM scratch")])
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"])
    expect(String((results[0] as PromiseRejectedResult).reason)).toContain("temporary objects or open transaction")
    expect(created[1].executed).toEqual([])
    // Issued after the loss was reported: runs on the new session.
    expect((await c.execute("SELECT 1")).rows).toEqual([[1]])
  })

  test("a late error from the replaced session does not hide the loss from a later reconnect", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    // The old session's error is delivered only after the temporary table exists on the new session.
    let tempCreated!: () => void
    const afterTemp = new Promise<void>((r) => (tempCreated = r))
    created[0].state.failQueue = [{ code: 407002, message: "terminated connection", after: afterTemp }]
    const late = c.execute("SELECT 0").catch(() => {})
    created[0].state.up = false
    await c.execute("SELECT 1") // reconnects; generation 1
    await c.execute("CREATE TEMP TABLE t2 AS SELECT 1 AS a") // state on the new session
    tempCreated()
    await late
    created[1].state.up = false
    const started = c.execute("SELECT * FROM t2")
    await expect(started).rejects.toThrow("temporary objects or open transaction")
  })

  test("a SET computed with side effects is not replayed; the session that ran it is reported as not restorable", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    await c.execute("USE SCHEMA analytics")
    await c.execute("SET v = (SELECT my_seq.NEXTVAL)")
    created[0].state.up = false
    await expect(c.execute("SELECT $v")).rejects.toThrow("temporary objects or open transaction")
    expect(created[1].executed).toEqual(["USE SCHEMA analytics"])
  })

  test("a setting that finishes on a session already replaced is applied to the new one too", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    let release!: () => void
    created[0].state.holdNext = new Promise<void>((r) => (release = r))
    const slowUse = c.execute("USE SCHEMA analytics") // still running on the first session
    await new Promise((r) => setTimeout(r, 5)) // issued (and held) before the next failure is armed
    created[0].state.failNextWith = { code: 407002, message: "terminated connection" }
    await c.execute("SELECT 1") // fails, reconnects, retries on the second session
    release()
    await slowUse
    expect(created[1].executed).toContain("USE SCHEMA analytics")
    created[1].state.up = false
    await c.execute("SELECT 2")
    expect(created[2].executed[0]).toBe("USE SCHEMA analytics")
  })

  test("temporary state created on a session already replaced is reported to its caller, not pinned on the new one", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    let release!: () => void
    created[0].state.holdNext = new Promise<void>((r) => (release = r))
    const slowTemp = c.execute("CREATE TEMP TABLE t AS SELECT 1 AS a")
    await new Promise((r) => setTimeout(r, 5)) // issued (and held) before the next failure is armed
    created[0].state.failNextWith = { code: 407002, message: "terminated connection" }
    await c.execute("SELECT 1")
    release()
    await expect(slowTemp).rejects.toThrow("temporary objects or open transaction")
    // The new session holds nothing unrestorable, so a later reconnect holds nothing back.
    created[1].state.up = false
    expect((await c.execute("SELECT 2")).rows).toEqual([[2]])
  })

  test("a committed transaction is not reported as lost; repeated settings are replayed once", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    await c.execute("USE SCHEMA a")
    await c.execute("USE SCHEMA b")
    await c.execute("USE SCHEMA a")
    await c.execute("BEGIN")
    await c.execute("INSERT INTO t VALUES (1)")
    await c.execute("COMMIT")
    created[0].state.up = false
    expect((await c.execute("SELECT 1")).rows).toEqual([[1]])
    expect(created[1].executed).toEqual(["USE SCHEMA b", "USE SCHEMA a", "SELECT 1 LIMIT 1001"])
  })

  test("connecting again starts a fresh session: nothing recorded for the old one carries over", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    await c.execute("CREATE TEMP TABLE t AS SELECT 1 AS a")
    await c.execute("USE SCHEMA old")
    await c.close()
    await c.connect()
    created[1].state.up = false
    expect((await c.execute("SELECT 1")).rows).toEqual([[2]])
    expect(created[2].executed).toEqual(["SELECT 1 LIMIT 1001"])
  })

  test("a late setting arriving while settings are replayed does not make the replay skip one", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    await c.execute("USE SCHEMA a")
    await c.execute("ALTER SESSION SET TIMEZONE = 'UTC'")
    // A repeat of the first setting is still running on the old session.
    let releaseOld!: () => void
    created[0].state.holdNext = new Promise<void>((r) => (releaseOld = r))
    const lateRepeat = c.execute("USE SCHEMA a")
    await new Promise((r) => setTimeout(r, 5))
    // The replay's first statement on the new session is held until the late repeat has completed.
    let releaseReplay!: () => void
    sdk.nextState = { holdNext: new Promise<void>((r) => (releaseReplay = r)) }
    created[0].state.up = false
    const next = c.execute("SELECT 1")
    await new Promise((r) => setTimeout(r, 5))
    releaseOld()
    await new Promise((r) => setTimeout(r, 5))
    releaseReplay()
    await next
    await lateRepeat
    expect(created[1].executed).toContain("ALTER SESSION SET TIMEZONE = 'UTC'")
  })

  test("a setting still running when the caller connects afresh is not carried onto the new session", async () => {
    const { sdk, created } = fakeSdk()
    const c = await connect(config, sdk)
    await c.connect()
    let release!: () => void
    created[0].state.holdNext = new Promise<void>((r) => (release = r))
    const slowUse = c.execute("USE SCHEMA old")
    await new Promise((r) => setTimeout(r, 5))
    await c.close()
    await c.connect()
    release()
    await slowUse.catch(() => {})
    expect(created[1].executed).toEqual([])
    created[1].state.up = false
    await c.execute("SELECT 1")
    expect(created[2].executed).toEqual(["SELECT 1 LIMIT 1001"])
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
      "SELECT CURRENT_DATE()",
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
      "SELECT my_seq.NEXTVAL",
      "select seq1.nextval, 2",
      "SELECT GETNEXTVAL(my_seq)",
      "SELECT SYSTEM$CANCEL_ALL_QUERIES(1)",
      "",
    ])
      expect(isRetrySafe(no)).toBe(false)
  })

  test("only effect-free single settings are replayable; the rest is session state", () => {
    for (const ok of ["USE SCHEMA x", "SET v = 'a;b'", "ALTER SESSION SET TIMEZONE = 'UTC'"]) expect(isSessionSetting(ok)).toBe(true)
    for (const no of ["SET v = (SELECT my_seq.NEXTVAL)", "SET a = 1; SET b = 2", "SET v = SYSTEM$WAIT(1)"]) {
      expect(isSessionSetting(no)).toBe(false)
      expect(holdsSessionState(no)).toBe(true)
    }
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
