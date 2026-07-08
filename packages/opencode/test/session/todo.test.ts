import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Deferred, Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { Todo } from "@/session/todo"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { Log } from "../../src/util/log"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

Log.init({ print: false })

const it = testEffect(
  Layer.mergeAll(
    SessionNs.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    Todo.layer.pipe(Layer.provide(Database.defaultLayer), Layer.provideMerge(EventV2Bridge.defaultLayer)),
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

describe("Todo: CRUD lifecycle", () => {
  it.instance(
    "update then get returns todos in order",
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const todo = yield* Todo.Service
      const info = yield* session.create({})
      const todos: Todo.Info[] = [
        { content: "Fix SQL query", status: "pending", priority: "high" },
        { content: "Add index", status: "in_progress", priority: "medium" },
        { content: "Write docs", status: "completed", priority: "low" },
      ]

      yield* todo.update({ sessionID: info.id, todos })

      const result = yield* todo.get(info.id)
      expect(result).toHaveLength(3)
      expect(result[0].content).toBe("Fix SQL query")
      expect(result[0].status).toBe("pending")
      expect(result[0].priority).toBe("high")
      expect(result[1].content).toBe("Add index")
      expect(result[2].content).toBe("Write docs")

      yield* session.remove(info.id)
    }),
    { git: true },
  )

  it.instance(
    "update with empty array clears all todos",
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const todo = yield* Todo.Service
      const info = yield* session.create({})

      yield* todo.update({
        sessionID: info.id,
        todos: [{ content: "Task A", status: "pending", priority: "high" }],
      })
      expect(yield* todo.get(info.id)).toHaveLength(1)

      yield* todo.update({ sessionID: info.id, todos: [] })
      expect(yield* todo.get(info.id)).toHaveLength(0)

      yield* session.remove(info.id)
    }),
    { git: true },
  )

  it.instance(
    "update replaces previous todos entirely",
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const todo = yield* Todo.Service
      const info = yield* session.create({})

      yield* todo.update({
        sessionID: info.id,
        todos: [
          { content: "Old task 1", status: "pending", priority: "high" },
          { content: "Old task 2", status: "pending", priority: "medium" },
        ],
      })
      expect(yield* todo.get(info.id)).toHaveLength(2)

      yield* todo.update({
        sessionID: info.id,
        todos: [{ content: "New task", status: "in_progress", priority: "low" }],
      })

      const result = yield* todo.get(info.id)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe("New task")
      expect(result[0].status).toBe("in_progress")

      yield* session.remove(info.id)
    }),
    { git: true },
  )

  it.instance(
    "get returns empty array for session with no todos",
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const todo = yield* Todo.Service
      const info = yield* session.create({})

      const result = yield* todo.get(info.id)
      expect(result).toEqual([])

      yield* session.remove(info.id)
    }),
    { git: true },
  )

  it.instance(
    "publishes Todo.Event.Updated on update",
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const todo = yield* Todo.Service
      const events = yield* EventV2Bridge.Service
      const info = yield* session.create({})
      const received = yield* Deferred.make<Todo.Info[]>()

      const unsub = yield* events.listen((event) => {
        if (
          event.type === Todo.Event.Updated.type &&
          (event.data as typeof Todo.Event.Updated.data.Type).sessionID === info.id
        )
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof Todo.Event.Updated.data.Type).todos as Todo.Info[]),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const todos: Todo.Info[] = [{ content: "Emit test", status: "pending", priority: "high" }]
      yield* todo.update({ sessionID: info.id, todos })

      const receivedTodos = yield* awaitDeferred(received, "timed out waiting for todo.updated")
      expect(receivedTodos).toHaveLength(1)
      expect(receivedTodos[0].content).toBe("Emit test")

      yield* session.remove(info.id)
    }),
    { git: true },
  )

  it.instance(
    "todos are isolated between sessions",
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const todo = yield* Todo.Service
      const session1 = yield* session.create({})
      const session2 = yield* session.create({})

      yield* todo.update({
        sessionID: session1.id,
        todos: [{ content: "Session 1 task", status: "pending", priority: "high" }],
      })
      yield* todo.update({
        sessionID: session2.id,
        todos: [
          { content: "Session 2 task A", status: "pending", priority: "medium" },
          { content: "Session 2 task B", status: "completed", priority: "low" },
        ],
      })

      expect(yield* todo.get(session1.id)).toHaveLength(1)
      expect((yield* todo.get(session1.id))[0].content).toBe("Session 1 task")
      expect(yield* todo.get(session2.id)).toHaveLength(2)

      yield* session.remove(session1.id)
      yield* session.remove(session2.id)
    }),
    { git: true },
  )
})
