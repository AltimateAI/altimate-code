/**
 * Snowflake server-side cancel: a caller-named `cancelAfterMs` cancels the statement when it runs
 * out, and an aborted `signal` cancels it with or without one; with neither, execution is unchanged.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { connect, keepSdkOffCloudMetadata } from "../src/snowflake"
import { isQueryTimeoutError, QueryTimeoutError } from "../src/types"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let finishAfterMs: number | undefined
let cancelError: Error | undefined
let cancelSilently = false
let queryError: Error | undefined
let cancels = 0
let sent: string[] = []
let up = true
let holdConnect: Promise<void> | undefined
let failFirstWith: { code: string; message: string } | undefined
let failFirstAfterMs = 1
let connections = 0

beforeEach(() => {
  finishAfterMs = undefined
  cancelError = undefined
  cancelSilently = false
  queryError = undefined
  cancels = 0
  sent = []
  up = true
  holdConnect = undefined
  failFirstWith = undefined
  failFirstAfterMs = 1
  connections = 0
})

function fakeSdk() {
  return {
    configure() {},
    createConnection() {
      connections++
      return {
        connect(cb: (err: Error | null) => void) {
          if (holdConnect) holdConnect.then(() => cb(null))
          else cb(null)
        },
        isUp: () => up,
        execute(options: { sqlText: string; complete: (err: Error | null, stmt: unknown, rows: unknown[]) => void }) {
          sent.push(options.sqlText)
          if (failFirstWith) {
            const failure = Object.assign(new Error(failFirstWith.message), { code: failFirstWith.code })
            failFirstWith = undefined
            setTimeout(() => options.complete(failure, null, []), failFirstAfterMs)
          } else if (queryError) setTimeout(() => options.complete(queryError!, null, []), 1)
          else if (finishAfterMs !== undefined) {
            setTimeout(() => options.complete(null, null, [{ N: 1 }]), finishAfterMs)
          }
          return {
            cancel(cb: (err?: Error) => void) {
              cancels++
              if (!cancelSilently) cb(cancelError)
            },
          }
        },
        destroy(cb: (err: Error | null) => void) {
          cb(null)
        },
      }
    },
  }
}

async function connector(seams?: { cancelWaitMs?: number }) {
  const one = await connect({ type: "snowflake", account: "a", user: "u", password: "p" } as never, fakeSdk(), seams)
  await one.connect()
  return one
}

describe("Snowflake SDK in assessment mode", () => {
  test("cloud metadata probes are switched off only when the mode is on", () => {
    for (const value of ["true", "1", "yes"]) {
      const env: NodeJS.ProcessEnv = { ALTIMATE_ASSESSMENT_MODE: value }
      keepSdkOffCloudMetadata(env)
      expect(env.SNOWFLAKE_DISABLE_PLATFORM_DETECTION).toBe("true")
    }
    // The SDK skips detection only on "true", so another value left in the environment is replaced.
    const preset: NodeJS.ProcessEnv = { ALTIMATE_ASSESSMENT_MODE: "true", SNOWFLAKE_DISABLE_PLATFORM_DETECTION: "false" }
    keepSdkOffCloudMetadata(preset)
    expect(preset.SNOWFLAKE_DISABLE_PLATFORM_DETECTION).toBe("true")
    for (const env of [{}, { ALTIMATE_ASSESSMENT_MODE: "" }, { ALTIMATE_ASSESSMENT_MODE: "0" }, { ALTIMATE_ASSESSMENT_MODE: "false" }] as NodeJS.ProcessEnv[]) {
      keepSdkOffCloudMetadata(env)
      expect(env.SNOWFLAKE_DISABLE_PLATFORM_DETECTION).toBeUndefined()
    }
  })

  test("connecting applies it before the SDK is used", async () => {
    const saved = { mode: process.env.ALTIMATE_ASSESSMENT_MODE, off: process.env.SNOWFLAKE_DISABLE_PLATFORM_DETECTION }
    try {
      process.env.ALTIMATE_ASSESSMENT_MODE = "true"
      delete process.env.SNOWFLAKE_DISABLE_PLATFORM_DETECTION
      await connect({ type: "snowflake", account: "a", user: "u", password: "p" } as never, fakeSdk())
      expect(process.env.SNOWFLAKE_DISABLE_PLATFORM_DETECTION).toBe("true")
    } finally {
      for (const [key, value] of [["ALTIMATE_ASSESSMENT_MODE", saved.mode], ["SNOWFLAKE_DISABLE_PLATFORM_DETECTION", saved.off]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

describe("Snowflake server-side cancel", () => {
  test("a statement past `cancelAfterMs` is cancelled on Snowflake and reported as a timeout", async () => {
    const db = await connector()
    const error = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 30 }).catch((e) => e)
    expect(isQueryTimeoutError(error)).toBe(true)
    expect(error.cancelled).toBe(true)
    expect(error.timeoutMs).toBe(30)
    expect(error.engine).toBe("snowflake")
    expect(cancels).toBe(1)
  })

  test("`queryTimeoutMs` alone never cancels: a slow statement still returns its rows", async () => {
    finishAfterMs = 80
    const db = await connector()
    const result = await db.execute("SELECT 1", 10, [], { queryTimeoutMs: 30 })
    expect(result.rows).toEqual([[1]])
    expect(cancels).toBe(0)
  })

  test("an aborted signal cancels the statement and rejects with the abort reason", async () => {
    const controller = new AbortController()
    const db = await connector()
    const pending = db.execute("SELECT 1", 10, [], { cancelAfterMs: 60_000, signal: controller.signal }).catch((e) => e)
    await sleep(10)
    controller.abort(new Error("session stopped"))
    const error = await pending
    expect(isQueryTimeoutError(error)).toBe(false)
    expect(error.message).toBe("session stopped")
    expect(cancels).toBe(1)
  })

  test("without `cancelAfterMs`, an aborted signal still cancels the statement on Snowflake", async () => {
    const controller = new AbortController()
    const db = await connector()
    const pending = db.execute("SELECT 1", 10, [], { queryTimeoutMs: 60_000, signal: controller.signal }).catch((e) => e)
    await sleep(10)
    controller.abort(new Error("session stopped"))
    const error = await pending
    expect(error.message).toBe("session stopped")
    expect(cancels).toBe(1)
  })

  test("with a signal that never aborts and no `cancelAfterMs`, a slow statement still returns its rows", async () => {
    finishAfterMs = 40
    const db = await connector()
    const result = await db.execute("SELECT 1", 10, [], { signal: new AbortController().signal })
    expect(result.rows).toEqual([[1]])
    expect(cancels).toBe(0)
  })

  test("a client-side query timeout abandons the statement: it is not cancelled and runs to its end", async () => {
    finishAfterMs = 40
    const controller = new AbortController()
    const db = await connector()
    const pending = db.execute("SELECT 1", 10, [], { queryTimeoutMs: 10, signal: controller.signal })
    await sleep(10)
    // As `executeQuery` aborts its signal when its own deadline passes.
    controller.abort(new QueryTimeoutError({ engine: "snowflake", timeoutMs: 10, cancelled: false }))
    const result = await pending
    expect(result.rows).toEqual([[1]])
    expect(cancels).toBe(0)
  })

  test("a session that closes under a statement already stopped is not reopened for it", async () => {
    failFirstWith = { code: "407002", message: "Unable to perform operation using terminated connection." }
    failFirstAfterMs = 40
    const db = await connector()
    const error = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 15 }).catch((e) => e)
    expect(isQueryTimeoutError(error)).toBe(true)
    await sleep(60)
    expect(connections).toBe(1)
    expect(sent).toEqual(["SELECT 1 LIMIT 11"])
  })

  test("an already-aborted signal sends nothing", async () => {
    const controller = new AbortController()
    controller.abort(new Error("session stopped"))
    const db = await connector()
    const error = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 1_000, signal: controller.signal }).catch((e) => e)
    expect(error.message).toBe("session stopped")
    expect(sent).toEqual([])
  })

  test("a statement still waiting on a reconnect at the deadline is never sent", async () => {
    const db = await connector()
    let release: () => void = () => {}
    holdConnect = new Promise((resolve) => (release = resolve))
    up = false
    const error = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 30 }).catch((e) => e)
    expect(isQueryTimeoutError(error)).toBe(true)
    // Nothing reached Snowflake: nothing ran, so nothing was cancelled, and the error says so.
    expect(error.unsent).toBe(true)
    expect(error.cancelled).toBe(false)
    expect(error.message).toContain("before it was sent, so it did not run")
    expect(error.message).not.toContain("may still be running")
    expect(cancels).toBe(0)
    up = true
    release()
    await sleep(20)
    expect(sent).toEqual([])
  })

  test("when the cancel fails, the error says the statement may still be running", async () => {
    cancelError = new Error("network")
    const db = await connector()
    const error = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 30 }).catch((e) => e)
    expect(isQueryTimeoutError(error)).toBe(true)
    expect(error.cancelled).toBe(false)
    expect(error.message).toContain("it may still be running on the server")
  })

  test("when Snowflake never answers the cancel, the error says the statement may still be running", async () => {
    cancelSilently = true
    const db = await connector({ cancelWaitMs: 10 })
    const error = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 20 }).catch((e) => e)
    expect(isQueryTimeoutError(error)).toBe(true)
    expect(error.cancelled).toBe(false)
    expect(cancels).toBe(1)
  })

  test("a read retried after the session closed is still covered by the deadline", async () => {
    failFirstWith = { code: "407002", message: "Unable to perform operation using terminated connection." }
    const db = await connector()
    const error = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 40 }).catch((e) => e)
    expect(isQueryTimeoutError(error)).toBe(true)
    expect(sent).toEqual(["SELECT 1 LIMIT 11", "SELECT 1 LIMIT 11"])
    // The first copy may still be running, so both are cancelled.
    expect(cancels).toBe(2)
  })

  test("a statement whose session closed may still be running, so the deadline tries to cancel it", async () => {
    // A closed-session error can arrive while the statement keeps running on Snowflake.
    failFirstWith = { code: "407002", message: "Unable to perform operation using terminated connection." }
    cancelError = new Error("session is gone")
    const db = await connector()
    let release: () => void = () => {}
    holdConnect = new Promise((resolve) => (release = resolve))
    const error = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 30 }).catch((e) => e)
    expect(isQueryTimeoutError(error)).toBe(true)
    expect(error.cancelled).toBe(false)
    expect(cancels).toBe(1)
    release()
    await sleep(10)
    // The retry waiting on the reconnect is never sent.
    expect(sent).toEqual(["SELECT 1 LIMIT 11"])
  })

  test("the abort listener does not outlive the statement", async () => {
    finishAfterMs = 1
    const controller = new AbortController()
    const added: unknown[] = []
    const removed: unknown[] = []
    const add = controller.signal.addEventListener.bind(controller.signal)
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.addEventListener = ((type: string, fn: never, options: never) => (added.push(fn), add(type, fn, options))) as never
    controller.signal.removeEventListener = ((type: string, fn: never) => (removed.push(fn), remove(type, fn))) as never
    const db = await connector()
    await db.execute("SELECT 1", 10, [], { cancelAfterMs: 5_000, signal: controller.signal })
    expect(added.length).toBe(1)
    expect(removed).toEqual(added)
  })

  test("a statement that finishes in time returns its rows and is not cancelled", async () => {
    finishAfterMs = 1
    const db = await connector()
    const result = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 5_000 })
    expect(result.rows).toEqual([[1]])
    expect(cancels).toBe(0)
  })

  test("a query error inside the deadline is the query's own error, not a timeout", async () => {
    queryError = new Error("SQL compilation error")
    const db = await connector()
    const error = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 5_000 }).catch((e) => e)
    expect(isQueryTimeoutError(error)).toBe(false)
    expect(error.message).toContain("SQL compilation error")
    expect(cancels).toBe(0)
  })
})
