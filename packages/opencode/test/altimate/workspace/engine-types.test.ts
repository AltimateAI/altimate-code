// altimate_change - new file
//
// The pure vocabulary of the workspace engine overlay: version floor, pin
// parser, tool keys, and the meaning tables over the outcome union.
import { describe, expect, test } from "bun:test"
import {
  INSTALL_COMMAND,
  INSTALL_HELPS,
  MIN_ENGINE_VERSION,
  REPAIRABLE,
  SERVING,
  attributableEngine,
  clearsFloor,
  compareVersions,
  describeMissing,
  describeRefusal,
  engineEntry,
  engineToolKeys,
  foreignEngineKeys,
  installWouldHelp,
  pinnedWorkspace,
  type Outcome,
} from "../../../src/altimate/workspace/engine-types"

describe("compareVersions", () => {
  test("orders by major, minor, patch", () => {
    expect(compareVersions("0.7.0", "0.7.0")).toBe(0)
    expect(compareVersions("0.7.1", "0.7.0")).toBeGreaterThan(0)
    expect(compareVersions("0.8.0", "0.7.9")).toBeGreaterThan(0)
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0)
    expect(compareVersions("0.6.3", "0.7.0")).toBeLessThan(0)
  })
  test("a release outranks every pre-release of it", () => {
    expect(compareVersions("0.7.0-beta.1", "0.7.0")).toBeLessThan(0)
    expect(compareVersions("0.7.0", "0.7.0-rc.2")).toBeGreaterThan(0)
    expect(compareVersions("0.7.0-beta.2", "0.7.0-beta.10")).toBeLessThan(0)
    expect(compareVersions("0.7.0-alpha", "0.7.0-beta")).toBeLessThan(0)
    expect(compareVersions("0.7.0-1", "0.7.0-alpha")).toBeLessThan(0)
  })
  test("ignores build metadata and a leading v", () => {
    expect(compareVersions("v0.7.0+build.5", "0.7.0")).toBe(0)
  })
  test("an unreadable core ranks below any readable one", () => {
    expect(compareVersions("0.7rc.0", "0.7.0")).toBeLessThan(0)
    expect(compareVersions("1", "0.7.0")).toBeLessThan(0)
    expect(compareVersions("garbage", "0.0.1")).toBeLessThan(0)
    expect(compareVersions("garbage", "nonsense")).toBe(0)
  })
})

describe("clearsFloor", () => {
  test("only a readable version at or above the floor clears it", () => {
    expect(clearsFloor(null)).toBe(false)
    expect(clearsFloor("")).toBe(false)
    expect(clearsFloor(MIN_ENGINE_VERSION)).toBe(true)
    expect(clearsFloor("0.7.1")).toBe(true)
    expect(clearsFloor("1.0.0")).toBe(true)
    expect(clearsFloor("0.6.9")).toBe(false)
    expect(clearsFloor("0.7.0")).toBe(false) // the previous floor no longer clears
    expect(clearsFloor(`${MIN_ENGINE_VERSION}-beta.1`)).toBe(false)
    expect(clearsFloor("0.7rc.0")).toBe(false)
  })
})

describe("pinnedWorkspace", () => {
  test("reads the pin from opencode's argv shape", () => {
    expect(pinnedWorkspace({ command: ["datamate", "start-stdio", "--datamate", "5"] })).toBe("5")
  })
  test("reads the pin from an IDE's command + args shape, either spelling", () => {
    expect(pinnedWorkspace({ command: "datamate", args: ["start-stdio", "--datamate=7"] })).toBe("7")
    expect(pinnedWorkspace({ command: "datamate", args: ["start-stdio", "--datamate", "8"] })).toBe("8")
  })
  test("a repeated pin resolves last-wins", () => {
    expect(pinnedWorkspace({ command: ["datamate", "--datamate", "1", "start-stdio", "--datamate=2"] })).toBe("2")
  })
  test("fails open on every miss", () => {
    expect(pinnedWorkspace(null)).toBeNull()
    expect(pinnedWorkspace({})).toBeNull()
    expect(pinnedWorkspace({ url: "https://example.invalid/sse" })).toBeNull()
    expect(pinnedWorkspace({ command: ["datamate", "start-stdio"] })).toBeNull()
    expect(pinnedWorkspace({ command: ["datamate", "start-stdio", "--datamate"] })).toBeNull()
    expect(pinnedWorkspace({ command: ["datamate", "--datamate="] })).toBeNull()
    expect(pinnedWorkspace({ command: ["datamate", "--datamate", 5 as unknown as string] })).toBeNull()
  })
  test("the derived entry is pinned to the workspace it was derived for", () => {
    const entry = engineEntry("42")
    expect(entry).toEqual({ type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true })
    expect(pinnedWorkspace(entry)).toBe("42")
  })
})

describe("engineToolKeys", () => {
  test("strips the datamate prefix and ignores everything else", () => {
    const keys = engineToolKeys({
      datamate_dbt_build_model: {},
      datamate_snowflake_execute_database_query: {},
      "datamate-prod_other_tool": {},
      sql_execute: {},
    })
    expect([...keys].sort()).toEqual(["dbt_build_model", "snowflake_execute_database_query"])
  })

  test("an entry stamped with another client is not an engine tool; an unstamped one is taken by prefix", () => {
    const tools = {
      datamate_snowflake_execute_database_query: { client: "datamate_snowflake" },
      datamate_dbt_build_model: { client: "datamate" },
      datamate_legacy_tool: {},
      other_tool: { client: "other" },
    }
    expect([...engineToolKeys(tools)].sort()).toEqual(["dbt_build_model", "legacy_tool"])
    expect(foreignEngineKeys(tools)).toEqual(["datamate_snowflake_execute_database_query"])
  })
})

describe("outcome tables", () => {
  const kinds: Outcome["kind"][] = [
    "disabled",
    "unbound",
    "attached",
    "engine-missing",
    "engine-too-old",
    "connect-failed",
  ]
  test("every table names every variant", () => {
    for (const table of [SERVING, INSTALL_HELPS, REPAIRABLE]) {
      expect(Object.keys(table).sort()).toEqual([...kinds].sort())
    }
  })
  test("only an attached engine is attributable", () => {
    expect(kinds.filter((k) => SERVING[k])).toEqual(["attached"])
    expect(attributableEngine(undefined)).toBe(false)
    expect(attributableEngine({ kind: "attached", available: 1 })).toBe(true)
    expect(attributableEngine({ kind: "connect-failed", error: "x" })).toBe(false)
  })
  test("only genuine unobtainability is fixed by an install", () => {
    expect(kinds.filter((k) => INSTALL_HELPS[k]).sort()).toEqual(["engine-missing", "engine-too-old"])
    expect(installWouldHelp(undefined)).toBe(false)
    expect(installWouldHelp({ kind: "engine-missing" })).toBe(true)
    expect(installWouldHelp({ kind: "connect-failed", error: "x" })).toBe(false)
  })
  test("refusals the user can act on are repairable; verdicts about the project are not", () => {
    expect(kinds.filter((k) => REPAIRABLE[k]).sort()).toEqual(["connect-failed", "engine-missing", "engine-too-old"])
  })
})

describe("messages", () => {
  test("a broken engine is described as broken, an old one as old", () => {
    expect(describeRefusal(null, "analytics")).toContain("more likely broken than out of date")
    expect(describeRefusal(null, "analytics")).toContain(INSTALL_COMMAND)
    expect(describeRefusal("0.6.3", "analytics")).toContain(`needs ${MIN_ENGINE_VERSION} or newer`)
    expect(describeRefusal("0.6.3", "analytics")).toContain("Found datamate 0.6.3")
    expect(describeRefusal("0.6.3", "analytics", "npm i -g @altimateai/datamate@next")).toContain(
      "Update with: npm i -g @altimateai/datamate@next",
    )
  })
  test("the missing list is truncated after five", () => {
    expect(describeMissing([])).toBe("")
    expect(describeMissing(["a", "b"])).toBe(" Declared but not available: a, b.")
    expect(describeMissing(["a", "b", "c", "d", "e", "f", "g"])).toBe(
      " Declared but not available: a, b, c, d, e (+2 more).",
    )
  })
})
