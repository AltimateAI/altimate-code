// Adversarial / regression tests for the v0.8.2 release.
//
// v0.8.2 rolls up:
//   #882 — the native altimate-core lineage tools (`column_lineage`,
//          `track_lineage`) run FULLY OFFLINE via the bundled napi binary.
//          Two tool descriptions used to falsely claim "Requires
//          altimate_core.init() with API key" — a stale Python-bridge leftover
//          that made the reviewer agent demand a key and degrade dbt_pr_review
//          to lint-only. The claim was corrected to "no API key required".
//   #884 — hardened the regression guard: loosened the false-claim regex and
//          added a source sweep across every altimate-core-* tool.
//
// These tests attack the corrected invariant adversarially: with EVERY altimate
// auth environment variable stripped, can the engine still resolve lineage
// (proving the "no API key" claim at runtime, not just in description text)?
// Does the offline path stay crash-safe on hostile input? And can the stale
// `altimate_core.init()` marker sneak back into any tool source?
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { registerAll } from "../../src/altimate/native/altimate-core"
import { AltimateCoreColumnLineageTool } from "../../src/altimate/tools/altimate-core-column-lineage"
import { AltimateCoreTrackLineageTool } from "../../src/altimate/tools/altimate-core-track-lineage"

// Plausible altimate auth/account env vars. The native engine reads NONE of
// these — stripping them must not change lineage behavior. That is the whole
// point of #882: lineage is offline.
const ALTIMATE_AUTH_ENV = [
  "ALTIMATE_API_KEY",
  "ALTIMATE_AI_API_KEY",
  "ALTIMATE_INSTANCE",
  "ALTIMATE_URL",
  "ALTIMATE_TENANT",
]

const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of ALTIMATE_AUTH_ENV) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // Re-register in case Dispatcher.reset() ran in another test file.
  registerAll()
})

afterAll(() => {
  for (const k of ALTIMATE_AUTH_ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

// ---------------------------------------------------------------------------
// #882 — the "no API key" claim must hold at RUNTIME, with auth env stripped
// ---------------------------------------------------------------------------
describe("v0.8.2 — altimate-core lineage runs offline (no API key)", () => {
  test("column_lineage resolves with every altimate auth env var unset", async () => {
    for (const k of ALTIMATE_AUTH_ENV) expect(process.env[k]).toBeUndefined()
    const result = await Dispatcher.call("altimate_core.column_lineage", {
      sql: "SELECT id, name FROM users",
    })
    // success=true means the handler completed offline — no auth gate fired.
    expect(result.success).toBe(true)
    expect(result.data).toBeDefined()
  })

  test("track_lineage resolves with every altimate auth env var unset", async () => {
    const result = await Dispatcher.call("altimate_core.track_lineage", {
      queries: ["CREATE TABLE stg AS SELECT id FROM raw", "SELECT id FROM stg"],
    })
    expect(result.success).toBe(true)
    expect(result.data).toBeDefined()
  })

  // Text claim and runtime behavior must agree: a tool that SAYS "no API key"
  // must also WORK with no API key. Pin both together so neither can drift.
  test("description claim matches runtime: column_lineage", async () => {
    const { description } = await AltimateCoreColumnLineageTool.init()
    expect(description.toLowerCase()).toContain("no api key")
    expect(description.toLowerCase()).not.toContain("altimate_core.init")
  })

  test("description claim matches runtime: track_lineage", async () => {
    const { description } = await AltimateCoreTrackLineageTool.init()
    expect(description.toLowerCase()).toContain("no api key")
    expect(description.toLowerCase()).not.toContain("altimate_core.init")
  })
})

// ---------------------------------------------------------------------------
// #882 — the offline path must stay crash-safe on hostile input
// (a review must never crash CI; bad SQL is a structured result, not a throw)
// ---------------------------------------------------------------------------
describe("v0.8.2 — offline lineage is crash-safe on hostile input", () => {
  const hostileSql = [
    "", // empty
    "   ", // whitespace
    "SELECT", // truncated
    "'; DROP TABLE users; --", // injection-shaped
    "SELECT __proto__, constructor FROM x", // prototype-pollution-shaped identifiers
    "SELECT * FROM " + "a,".repeat(500) + "b", // pathological width
  ]

  for (const sql of hostileSql) {
    test(`column_lineage returns a structured result (no throw) for ${JSON.stringify(sql.slice(0, 24))}`, async () => {
      const result = await Dispatcher.call("altimate_core.column_lineage", { sql })
      // Contract: the handler returns an envelope with a boolean success flag —
      // semantic failure lives in the data, it never throws.
      expect(typeof result.success).toBe("boolean")
    })
  }

  test("track_lineage tolerates an empty query list without throwing", async () => {
    const result = await Dispatcher.call("altimate_core.track_lineage", { queries: [] })
    expect(typeof result.success).toBe("boolean")
  })
})

// ---------------------------------------------------------------------------
// #884 — the stale `altimate_core.init()` marker must never return to any tool
// ---------------------------------------------------------------------------
describe("v0.8.2 — no altimate-core tool reintroduces altimate_core.init()", () => {
  const toolsDir = join(import.meta.dir, "../../src/altimate/tools")
  const files = readdirSync(toolsDir).filter((f) => f.startsWith("altimate-core-") && f.endsWith(".ts"))

  test("there is at least one altimate-core tool to scan", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    test(`${file} is free of the stale altimate_core.init() marker`, () => {
      const src = readFileSync(join(toolsDir, file), "utf8")
      expect(src).not.toContain("altimate_core.init")
    })
  }
})
