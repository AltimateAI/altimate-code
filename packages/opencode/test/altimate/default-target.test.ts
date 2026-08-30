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
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { registerAll, resolveDefaultTarget, resetDbtAdapter } from "../../src/altimate/native/connections/register"
import { Dispatcher } from "../../src/altimate/native"
import * as Registry from "../../src/altimate/native/connections/registry"

const OPS = ["sql.execute", "sql.explain", "schema.inspect"] as const

beforeAll(() => {
  // Re-register handlers in case another test file called Dispatcher.reset(): the
  // concurrency tests below dispatch `sql.execute`, which this module registers.
  registerAll()
})

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

describe("resolveDefaultTarget — the dbt fallback is reported, not hidden", () => {
  test("the registry fallback is exposed whenever one exists", async () => {
    // `sql.execute` falls back to the first registry connection whenever the dbt
    // attempt yields nothing — not only when dbt is absent, but on an unrecognised
    // result shape or a throw. A caller deciding whether to route this call has to be
    // able to see both possible targets; reporting only the dbt one lets a call slip
    // through and execute locally against a connection that should have been routed.
    Registry.setConfigs({ first: { type: "snowflake", account: "a" } as never })
    const target = await resolveDefaultTarget("sql.execute")
    if (target.source === "dbt") {
      expect(target.fallback).toEqual({ type: "snowflake", name: "first" })
    } else {
      // No dbt project here, so this resolves to the registry directly — same target.
      expect(target).toMatchObject({ source: "registry", name: "first", type: "snowflake" })
    }
  })

  test("no fallback is reported when the registry is empty", async () => {
    Registry.setConfigs({})
    const target = await resolveDefaultTarget("sql.execute")
    if (target.source === "dbt") expect(target.fallback).toBeUndefined()
    else expect(target.source).toBe("none")
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

describe("the default target survives a concurrent registry change", () => {
  // `sql.execute` awaits the dbt attempt before it reaches the registry. The registry
  // is a process-wide mutable singleton, so a `warehouse.add`/`remove` landing during
  // that await used to change which connection the call fell back to — after the
  // caller's routing decision had already been made against the old one. The handler
  // now pins the fallback before the await, so the decided and executed connections
  // are the same by construction.
  test("a connection dropped during the dbt await does not silently redirect the call", async () => {
    // Warm the dispatcher: its first call awaits lazy handler registration, and a
    // mutation landing in *that* window would be indistinguishable from the one
    // under test.
    Registry.setConfigs({ warm: { type: "duckdb", path: ":memory:" } as never })
    await Dispatcher.call("warehouse.list", {}).catch(() => {})

    Registry.setConfigs({
      pinned_first: { type: "duckdb", path: ":memory:" } as never,
      other: { type: "duckdb", path: ":memory:" } as never,
    })

    // Start the call, then mutate while it is suspended in the dbt attempt.
    const inflight = Dispatcher.call("sql.execute", { sql: "select 1" } as never)
    Registry.setConfigs({ other: { type: "duckdb", path: ":memory:" } as never })

    // The call must still be about `pinned_first` — the connection the decision
    // covered — rather than quietly landing on whatever now sorts first. The handler
    // reports connection failures in the result rather than throwing, so the named
    // connection in the error is what identifies which one it tried.
    const result = (await inflight) as { error?: string }
    expect(result.error).toMatch(/pinned_first/)
  })
})

describe("a connection replaced under the same name is not executed on the old verdict", () => {
  // Pinning the name closes the case where the *identity* of the default changes.
  // It does not close a same-name replacement: `Registry.get(name)` still consults the
  // mutable registry after the dbt await, so a name re-added against a different
  // warehouse would execute under a routing decision computed for the old one. The
  // decision is a function of the connection's canonical type, so pinning the type
  // pins the decision.
  test("a same-name replacement of a different type is refused, not run locally", async () => {
    Registry.setConfigs({ warm: { type: "duckdb", path: ":memory:" } as never })
    await Dispatcher.call("warehouse.list", {}).catch(() => {})

    Registry.setConfigs({ primary: { type: "duckdb", path: ":memory:" } as never })
    const inflight = Dispatcher.call("sql.execute", { sql: "select 1" } as never)
    // Same name, different warehouse — the kind a workspace integration may shadow.
    Registry.setConfigs({ primary: { type: "snowflake", account: "a" } as never })

    const result = (await inflight) as { error?: string }
    expect(result.error).toMatch(/changed while this query was being prepared/)
  })

  test("a same-name rewrite that keeps the type still runs", async () => {
    // The guard binds the routing decision, not the config bytes: an edit that cannot
    // change where the call is routed must not turn into a spurious failure.
    Registry.setConfigs({ warm: { type: "duckdb", path: ":memory:" } as never })
    await Dispatcher.call("warehouse.list", {}).catch(() => {})

    Registry.setConfigs({ primary: { type: "postgres", host: "a" } as never })
    const inflight = Dispatcher.call("sql.execute", { sql: "select 1" } as never)
    Registry.setConfigs({ primary: { type: "postgresql", host: "b" } as never })

    const result = (await inflight) as { error?: string }
    expect(result.error ?? "").not.toMatch(/changed while this query was being prepared/)
  })
})
