import { afterEach, beforeEach, expect, spyOn } from "bun:test"
import type { Connector } from "@altimateai/drivers"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import * as Registry from "../../src/altimate/native/connections/registry"
import { registerAll } from "../../src/altimate/native/connections/register"
import { closeScratch, getScratch } from "../../src/altimate/native/connections/scratch"
import { SqlExecuteTool } from "../../src/altimate/tools/sql-execute"
import { SqlMaterializeTool } from "../../src/altimate/tools/sql-materialize"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { initTool } from "./tool-fixture"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer, testInstanceStoreLayer))

beforeEach(() => registerAll())
afterEach(() => closeScratch())

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

async function within<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function slowSource(value: number) {
  const entered = gate()
  const release = gate()
  const execute: Connector["execute"] = async () => {
    entered.open()
    await release.promise
    return { columns: ["id"], rows: [[value]], row_count: 1, truncated: false }
  }
  return { entered, release, connector: { execute, supportsResultByteLimit: true } as Connector }
}

function sources(connectors: Record<string, Connector>) {
  Registry.setConfigs(Object.fromEntries(Object.keys(connectors).map((name) => [name, { type: "postgres" }])))
  const original = Registry.get.bind(Registry)
  return spyOn(Registry, "get").mockImplementation(async (name: string) => connectors[name] ?? original(name))
}

function context(sessionID: SessionID) {
  return {
    sessionID,
    messageID: MessageID.make("msg_materialize_concurrency"),
    agent: "analyst",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

it.instance("a remote materialization lets a sibling subagent query scratch before the source returns", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const reader = yield* sessions.create({ parentID: root.id })
    const writer = yield* sessions.create({ parentID: root.id })
    yield* Effect.promise(async () => {
      await getScratch(root.id)
      const materialize = await initTool(SqlMaterializeTool)
      const execute = await initTool(SqlExecuteTool)
      const source = slowSource(1)
      const registry = sources({ remote_source: source.connector })
      const pending = materialize.execute(
        {
          source_warehouse: "remote_source",
          sql: "SELECT id FROM records",
          target_table: "remote_records",
        },
        context(writer.id),
      )
      let read: ReturnType<typeof execute.execute> | undefined
      try {
        await within(source.entered.promise, 5_000, "The source read did not start")
        read = execute.execute({ query: "SELECT 1 AS id", warehouse: "scratch" }, context(reader.id))
        const result = await within(read, 1_000, "The scratch read waited for the unrelated remote source")
        expect(result.metadata.error).toBeUndefined()
        expect(result.output).toContain("1")
      } finally {
        source.release.open()
        const result = await pending
        await read
        registry.mockRestore()
        expect(result.metadata.error).toBeUndefined()
        expect(result.metadata.rowCount).toBe(1)
      }
    })
  }),
)

it.instance("materializations from distinct sources overlap their reads within one root session", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const first = yield* sessions.create({ parentID: root.id })
    const second = yield* sessions.create({ parentID: root.id })
    yield* Effect.promise(async () => {
      await getScratch(root.id)
      const materialize = await initTool(SqlMaterializeTool)
      const left = slowSource(1)
      const right = slowSource(2)
      const registry = sources({ left_source: left.connector, right_source: right.connector })
      const pending = [
        materialize.execute(
          {
            source_warehouse: "left_source",
            sql: "SELECT id FROM records",
            target_table: "left_records",
          },
          context(first.id),
        ),
      ]
      try {
        await within(left.entered.promise, 5_000, "The first source read did not start")
        pending.push(
          materialize.execute(
            {
              source_warehouse: "right_source",
              sql: "SELECT id FROM records",
              target_table: "right_records",
            },
            context(second.id),
          ),
        )
        await within(right.entered.promise, 1_000, "The second source read waited for the first source")
      } finally {
        left.release.open()
        right.release.open()
        const results = await Promise.all(pending)
        registry.mockRestore()
        for (const result of results) {
          expect(result.metadata.error).toBeUndefined()
          expect(result.metadata.rowCount).toBe(1)
        }
      }
      const scratch = await getScratch(root.id)
      expect(
        (
          await scratch.execute(
            "SELECT id::INTEGER AS id FROM left_records UNION ALL SELECT id::INTEGER FROM right_records ORDER BY id",
          )
        ).rows,
      ).toEqual([[1], [2]])
    })
  }),
)

it.instance("concurrent materializations append atomically to the same scratch table", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const first = yield* sessions.create({ parentID: root.id })
    const second = yield* sessions.create({ parentID: root.id })
    yield* Effect.promise(async () => {
      const scratch = await getScratch(root.id)
      await scratch.execute("CREATE TABLE shared_records AS SELECT 0::BIGINT AS id")
      const materialize = await initTool(SqlMaterializeTool)
      const left = slowSource(1)
      const right = slowSource(2)
      const registry = sources({ left_source: left.connector, right_source: right.connector })
      const pending = [
        materialize.execute(
          {
            source_warehouse: "left_source",
            sql: "SELECT id FROM records",
            target_table: "shared_records",
            mode: "append",
          },
          context(first.id),
        ),
        materialize.execute(
          {
            source_warehouse: "right_source",
            sql: "SELECT id FROM records",
            target_table: "shared_records",
            mode: "append",
          },
          context(second.id),
        ),
      ]
      try {
        await within(Promise.race([left.entered.promise, right.entered.promise]), 5_000, "Neither source read started")
      } finally {
        left.release.open()
        right.release.open()
        const results = await Promise.all(pending)
        registry.mockRestore()
        for (const result of results) expect(result.metadata.error).toBeUndefined()
      }
      expect((await scratch.execute("SELECT id::INTEGER AS id FROM shared_records ORDER BY id")).rows).toEqual([
        [0],
        [1],
        [2],
      ])
    })
  }),
)

it.instance("concurrent scratch-to-scratch derivations from one table lose no update", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const first = yield* sessions.create({ parentID: root.id })
    const second = yield* sessions.create({ parentID: root.id })
    yield* Effect.promise(async () => {
      const scratch = await getScratch(root.id)
      await scratch.execute("CREATE TABLE counter AS SELECT 0::BIGINT AS n")
      const materialize = await initTool(SqlMaterializeTool)
      const input = {
        source_warehouse: "scratch",
        sql: "SELECT n + 1 AS n FROM counter",
        target_table: "counter",
        mode: "replace" as const,
      }
      const results = await Promise.all([
        materialize.execute(input, context(first.id)),
        materialize.execute(input, context(second.id)),
      ])
      for (const result of results) expect(result.metadata.error).toBeUndefined()
      expect((await scratch.execute("SELECT n::INTEGER AS n FROM counter")).rows).toEqual([[2]])
    })
  }),
)
