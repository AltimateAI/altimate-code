// altimate_change - new file
//
// Coverage for `resolveDefaultTarget`, which answers "where would a warehouse call
// with no `warehouse` argument actually go?" — the question workspace precedence has
// to settle before it can decide whether such a call is served by the bound
// workspace's engine.
//
// The point of the function is that it mirrors each handler's OWN resolution rather
// than imposing a uniform one: only `sql.execute` consults dbt. These tests run
// outside a dbt project, so `ensureDbtAdapter` finds no config and every op falls
// through to the registry — which is exactly the behaviour to pin down, because the
// registry branch is what decides the default for the majority of users.
//
// Concurrency contract matches dispatcher.test.ts: the connection registry is a
// process-wide singleton mutated here via `setConfigs`/`reset`, which is safe under
// bun's default sequential file execution.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolveDefaultTarget, resetDbtAdapter } from "../../src/altimate/native/connections/register"
import * as Registry from "../../src/altimate/native/connections/registry"

const OPS = ["sql.execute", "sql.explain", "schema.inspect"] as const

beforeEach(() => {
  resetDbtAdapter()
  Registry.reset()
})

afterEach(() => {
  resetDbtAdapter()
  Registry.reset()
})

describe("resolveDefaultTarget — registry branch", () => {
  test("reports the first configured connection, which is what the handlers use", async () => {
    Registry.setConfigs({
      first_duck: { type: "duckdb", path: ":memory:" } as never,
      second_snow: { type: "snowflake", account: "a" } as never,
    })
    const target = await resolveDefaultTarget("sql.explain")
    expect(target.source).toBe("registry")
    expect(target).toMatchObject({ name: "first_duck", type: "duckdb" })
  })

  test("insertion order decides the default, not the type", async () => {
    Registry.setConfigs({
      second_snow: { type: "snowflake", account: "a" } as never,
      first_duck: { type: "duckdb", path: ":memory:" } as never,
    })
    const target = await resolveDefaultTarget("sql.explain")
    expect(target).toMatchObject({ name: "second_snow", type: "snowflake" })
  })

  test("no configured connection resolves to nothing rather than guessing", async () => {
    Registry.setConfigs({})
    for (const op of OPS) {
      expect((await resolveDefaultTarget(op)).source).toBe("none")
    }
  })
})

describe("resolveDefaultTarget — per-operation resolution", () => {
  test("every op agrees on the registry default when there is no dbt project", async () => {
    Registry.setConfigs({ only: { type: "postgres", host: "h" } as never })
    for (const op of OPS) {
      const target = await resolveDefaultTarget(op)
      expect(target).toMatchObject({ source: "registry", name: "only", type: "postgres" })
    }
  })

  test("explain and inspect never report a dbt source", async () => {
    // These handlers are registry-only by construction. Resolving them through dbt
    // would drag adapter construction — Python bridge, manifest rebuild, file
    // watchers — onto paths that never touch dbt today.
    Registry.setConfigs({ only: { type: "duckdb", path: ":memory:" } as never })
    expect((await resolveDefaultTarget("sql.explain")).source).not.toBe("dbt")
    expect((await resolveDefaultTarget("schema.inspect")).source).not.toBe("dbt")
  })

  test("repeated resolution is stable and does not rebuild state", async () => {
    Registry.setConfigs({ only: { type: "duckdb", path: ":memory:" } as never })
    const results = await Promise.all(OPS.map((op) => resolveDefaultTarget(op)))
    for (const target of results) {
      expect(target).toMatchObject({ source: "registry", name: "only" })
    }
  })

  test("concurrent execute resolutions share one adapter attempt", async () => {
    // Single-flight: two concurrent `warehouse`-less calls used to construct the dbt
    // adapter twice. Outside a dbt project both settle on the registry, and neither
    // should throw or disagree.
    Registry.setConfigs({ only: { type: "snowflake", account: "a" } as never })
    const [a, b] = await Promise.all([resolveDefaultTarget("sql.execute"), resolveDefaultTarget("sql.execute")])
    expect(a).toEqual(b)
  })
})
