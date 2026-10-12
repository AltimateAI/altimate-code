import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import path from "node:path"
import { closeScratch, getScratch, scratchOpened } from "../../src/altimate/native/connections/scratch"
import { registerAll } from "../../src/altimate/native/connections/register"
import { SqlExecuteTool } from "../../src/altimate/tools/sql-execute"
import { SqlMaterializeTool } from "../../src/altimate/tools/sql-materialize"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { initTool } from "./tool-fixture"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer, testInstanceStoreLayer))

// Other suites replace the process-global dispatcher handlers with stubs.
beforeEach(() => registerAll())
afterEach(() => closeScratch())

test("scratch connectors and cleanup are scoped to a session", async () => {
  const [a, b] = await Promise.all([getScratch("ses_a"), getScratch("ses_b")])
  expect(a).not.toBe(b)
  expect(await getScratch("ses_a")).toBe(a)
  await a.execute("CREATE TABLE private_result AS SELECT 11 AS id")
  await expect(b.execute("SELECT * FROM private_result")).rejects.toThrow(/does not exist/)
  await b.execute("CREATE TABLE private_result AS SELECT 22 AS id")
  await b.execute("DROP TABLE private_result")
  expect((await a.execute("SELECT * FROM private_result")).rows).toEqual([[11]])
  await closeScratch("ses_b")
  expect(scratchOpened("ses_b")).toBe(false)
  expect(scratchOpened("ses_a")).toBe(true)
  expect((await a.execute("SELECT * FROM private_result")).rows).toEqual([[11]])
})

test("tool context scopes materialize and execute to the same session's scratch", async () => {
  const materialize = await initTool(SqlMaterializeTool)
  const execute = await initTool(SqlExecuteTool)
  const context = (id: string) => ({
    sessionID: SessionID.make(id), messageID: MessageID.make("msg_scratch_sessions"),
    agent: "analyst", abort: AbortSignal.any([]), messages: [],
    metadata: () => {}, ask: async () => {},
  })
  const a = context("ses_materialize_a")
  const b = context("ses_materialize_b")
  for (const [ctx, value] of [[a, 11], [b, 22]] as const) {
    const result = await materialize.execute({
      source_warehouse: "scratch", sql: `SELECT ${value} AS id`, target_table: "private_result",
    }, ctx)
    expect(result.metadata.error).toBeUndefined()
  }
  const read = (ctx: typeof a) => execute.execute({ query: "SELECT id FROM private_result", warehouse: "scratch" }, ctx)
  expect((await read(a)).output).toMatch(/\b11\b/)
  expect((await read(b)).output).toMatch(/\b22\b/)
  await execute.execute({ query: "DROP TABLE private_result", warehouse: "scratch" }, b)
  expect((await read(a)).output).toMatch(/\b11\b/)
})

test("closing a session does not wait for its running scratch query", async () => {
  const scratch = await getScratch("ses_busy")
  const pending = scratch.execute(
    "SELECT sum(a.i * b.i) FROM range(1000000000) a(i), range(1000000000) b(i)",
    undefined, undefined, { queryTimeoutMs: 2500 },
  ).catch((error) => error)
  // Allow the real query to enter the helper before measuring shutdown.
  await Bun.sleep(50)
  const start = performance.now()
  await closeScratch("ses_busy")
  expect(performance.now() - start).toBeLessThan(1500)
  expect(await pending).toBeInstanceOf(Error)
  expect(scratchOpened("ses_busy")).toBe(false)
})

it.instance("subagents share their root's materialized tables while unrelated roots stay isolated", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({})
  const child = yield* sessions.create({ parentID: parent.id })
  const grandchild = yield* sessions.create({ parentID: child.id })
  const other = yield* sessions.create({})
  const otherChild = yield* sessions.create({ parentID: other.id })
  const context = (sessionID: SessionID) => ({
    sessionID, messageID: MessageID.make("msg_scratch_subagents"),
    agent: "analyst", abort: AbortSignal.any([]), messages: [],
    metadata: () => {}, ask: async () => {},
  })
  const { read, materialize } = yield* Effect.promise(async () => {
    const execute = await initTool(SqlExecuteTool)
    const materialize = await initTool(SqlMaterializeTool)
    const read = (sessionID: SessionID) => execute.execute({
      query: "SELECT id FROM parent_result", warehouse: "scratch",
    }, context(sessionID))
    return { read, materialize }
  })
  for (const [root, value] of [[parent, 11], [other, 22]] as const) {
    const result = yield* Effect.promise(() => materialize.execute({
      source_warehouse: "scratch", sql: `SELECT ${value} AS id`, target_table: "parent_result",
    }, context(root.id)))
    expect(result.metadata.error).toBeUndefined()
  }
  for (const descendant of [child, grandchild]) {
    const result = yield* Effect.promise(() => read(descendant.id))
    expect(result.metadata.error).toBeUndefined()
    expect(result.output).toMatch(/\b11\b/)
    expect(yield* Effect.promise(() => getScratch(descendant.id))).toBe(yield* Effect.promise(() => getScratch(parent.id)))
    expect(scratchOpened(descendant.id)).toBe(true)
  }
  expect((yield* Effect.promise(() => read(otherChild.id))).output).toMatch(/\b22\b/)
  yield* sessions.remove(child.id)
  expect(scratchOpened(parent.id)).toBe(true)
  expect((yield* Effect.promise(() => read(parent.id))).output).toMatch(/\b11\b/)
  yield* sessions.remove(parent.id)
  expect(scratchOpened(parent.id)).toBe(false)
  expect((yield* Effect.promise(() => read(otherChild.id))).output).toMatch(/\b22\b/)
  yield* sessions.remove(other.id)
  expect(scratchOpened(other.id)).toBe(false)
}))

test("scratch ancestry uses the core session store with an in-memory database", () => {
  const script = `
    import { Effect } from "effect"
    import { Database } from "@opencode-ai/core/database/database"
    import { makeRuntime } from "@opencode-ai/core/effect/runtime"
    import { ProjectTable } from "@opencode-ai/core/project/sql"
    import { SessionTable } from "@opencode-ai/core/session/sql"
    import { SessionStore } from "@opencode-ai/core/session/store"
    import { getScratch, closeScratch } from "./src/altimate/native/connections/scratch"

    const database = makeRuntime(Database.Service, Database.defaultLayer)
    await database.runPromise(({ db }) => Effect.gen(function* () {
      yield* db.insert(ProjectTable).values({ id: "global", worktree: process.cwd(), sandboxes: [] })
      for (const [id, parent_id] of [["ses_memory_parent", null], ["ses_memory_child", "ses_memory_parent"]]) {
        yield* db.insert(SessionTable).values({
          id, parent_id, project_id: "global", directory: process.cwd(),
          slug: id, title: id, version: "test",
        })
      }
    }))
    const sessions = makeRuntime(SessionStore.Service, SessionStore.defaultLayer)
    const childSession = sessions.runSync((store) => store.get("ses_memory_child"))
    if (childSession?.parentID !== "ses_memory_parent") throw new Error("Missing core session fixture")
    try {
      const parent = await getScratch("ses_memory_parent")
      await parent.execute("CREATE TABLE parent_result AS SELECT 11 AS id")
      const child = await getScratch("ses_memory_child")
      console.log("ROWS=" + JSON.stringify((await child.execute("SELECT id FROM parent_result")).rows))
    } finally {
      await closeScratch()
    }
    process.exit(0)
  `
  const processResult = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, OPENCODE_DB: ":memory:", ALTIMATE_CLI_DB: ":memory:" },
  })
  expect(processResult.stdout.toString() + processResult.stderr.toString()).toContain("ROWS=[[11]]")
  expect(processResult.exitCode).toBe(0)
})
