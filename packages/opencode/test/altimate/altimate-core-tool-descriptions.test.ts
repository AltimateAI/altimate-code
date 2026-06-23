/**
 * Regression guard for issue #881.
 *
 * The native altimate-core engine (column lineage, track lineage, equivalence,
 * grade, PII, …) runs fully offline via the bundled `@altimateai/altimate-core`
 * napi binary — there is no `altimate_core.init` and no API-key gate in that
 * path. Two tool descriptions used to falsely claim "Requires altimate_core.init()
 * with API key", a stale leftover from the old Python bridge. The reviewer agent
 * read those descriptions, concluded it needed an altimate API key, and degraded
 * `dbt_pr_review` to lint-only mode.
 *
 * This test pins the two corrected descriptions so the false claim can never
 * silently return, and sweeps EVERY `altimate-core-*` tool source so the stale
 * `altimate_core.init()` marker can't reappear in a newly added tool either.
 */
import { describe, test, expect } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { AltimateCoreColumnLineageTool } from "../../src/altimate/tools/altimate-core-column-lineage"
import { AltimateCoreTrackLineageTool } from "../../src/altimate/tools/altimate-core-track-lineage"

describe("altimate-core tool descriptions (issue #881)", () => {
  const tools = [
    { name: "altimate_core_column_lineage", tool: AltimateCoreColumnLineageTool },
    { name: "altimate_core_track_lineage", tool: AltimateCoreTrackLineageTool },
  ]

  for (const { name, tool } of tools) {
    test(`${name} must not claim it requires an API key / altimate_core.init()`, async () => {
      const { description } = await tool.init()
      expect(description).toBeTruthy()
      const lower = description.toLowerCase()
      // These deterministic engine tools run offline — no auth in their call path.
      // Guard the *false claim* (that a key/init is required), not the word
      // "api key" itself: the corrected copy legitimately says "no API key required".
      expect(lower).not.toContain("altimate_core.init")
      // Lazy `.*?` (no length cap) catches long-gap variants like
      // "requires an API key for authentication" that a bounded pattern misses.
      expect(lower).not.toMatch(/requires?\b.*?\bapi key\b/)
      // And it should positively state the offline / no-key reality.
      expect(lower).toContain("no api key")
    })
  }
})

/**
 * Forward guard: no `altimate-core-*` tool may reintroduce the stale
 * `altimate_core.init()` marker — the unambiguous fingerprint of the
 * Python-bridge-era "needs an API key" claim. No native engine tool calls a
 * dispatcher method by that name, so any occurrence is a regression. Scanning
 * the source (not just the two known tools) auto-covers tools added later.
 */
describe("altimate-core tool sources must not reference altimate_core.init() (issue #881)", () => {
  const toolsDir = join(import.meta.dir, "../../src/altimate/tools")
  const files = readdirSync(toolsDir).filter((f) => f.startsWith("altimate-core-") && f.endsWith(".ts"))

  test("there is at least one altimate-core tool to scan", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    test(`${file} must not contain the stale altimate_core.init() marker`, () => {
      const src = readFileSync(join(toolsDir, file), "utf8")
      expect(src).not.toContain("altimate_core.init")
    })
  }
})
