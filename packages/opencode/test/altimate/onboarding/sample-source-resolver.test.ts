/**
 * sample-source-resolver.ts — locate the shipped starter sample source
 * across dev / test / prod install layouts, and rehydrate the sentinel-
 * bearing pre-compiled manifest into a usable-anywhere manifest.
 *
 * The rehydration test is the load-bearing one — codex flagged a real
 * JSON-corruption failure mode (naive text-level replace breaking on
 * paths with quotes or Windows backslashes). The Phase 3 refinement
 * moved to a tree-walking replace that only touches string leaves;
 * these tests pin that behavior with adversarial inputs.
 */

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_SAMPLE_NAME,
  SAMPLE_ROOT_PARENT_SENTINEL,
  SAMPLE_ROOT_SENTINEL,
  loadShippedManifest,
  rehydrateSentinels,
  resolveSampleSource,
} from "../../../src/altimate/onboarding/sample-source-resolver"

describe("resolveSampleSource — env override", () => {
  test("ALTIMATE_STARTER_SAMPLE_DIR points at a valid sample → returns it with origin=env", () => {
    // Stage a fake sample dir under a tempdir so the override resolves.
    const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-env-"))
    const sampleDir = path.join(stageParent, DEFAULT_SAMPLE_NAME)
    fs.mkdirSync(sampleDir, { recursive: true })
    fs.writeFileSync(path.join(sampleDir, "dbt_project.yml"), "name: fake\n")

    const orig = process.env["ALTIMATE_STARTER_SAMPLE_DIR"]
    process.env["ALTIMATE_STARTER_SAMPLE_DIR"] = stageParent
    try {
      const location = resolveSampleSource()
      expect(location).toBeDefined()
      expect(location!.origin).toBe("env")
      expect(location!.path).toBe(path.resolve(sampleDir))
    } finally {
      if (orig === undefined) delete process.env["ALTIMATE_STARTER_SAMPLE_DIR"]
      else process.env["ALTIMATE_STARTER_SAMPLE_DIR"] = orig
    }
  })

  test("no override + shipped sample present → returns via dev-source-tree candidate in this repo", () => {
    // Ensure the env override isn't leaking from another test.
    const origEnv = process.env["ALTIMATE_STARTER_SAMPLE_DIR"]
    delete process.env["ALTIMATE_STARTER_SAMPLE_DIR"]
    try {
      const location = resolveSampleSource()
      // This test asserts against the real repo layout — expects the
      // dev-source-tree candidate to hit because
      // packages/opencode/sample-projects/jaffle-shop-duckdb/dbt_project.yml
      // exists in the branch that landed Phase 3.
      expect(location).toBeDefined()
      expect(location!.path).toContain("packages/opencode/sample-projects/jaffle-shop-duckdb")
      expect(location!.origin).toBe("dev-source-tree")
    } finally {
      if (origEnv !== undefined) process.env["ALTIMATE_STARTER_SAMPLE_DIR"] = origEnv
    }
  })
})

describe("rehydrateSentinels — JSON-safe tree walk (codex fix #2)", () => {
  test("plain string with sentinels → single expansion", () => {
    const input = `${SAMPLE_ROOT_SENTINEL}/models/foo.sql`
    const out = rehydrateSentinels(input, "/home/alice/altimate-sample-dbt", "/home/alice") as string
    expect(out).toBe("/home/alice/altimate-sample-dbt/models/foo.sql")
  })

  test("target path with double-quotes gets substituted verbatim (naive text replace would break JSON)", () => {
    const input = { p: `${SAMPLE_ROOT_SENTINEL}/models/foo.sql` }
    const trickyPath = `/tmp/a"b`
    const out = rehydrateSentinels(input, trickyPath, "/tmp") as { p: string }
    // The value contains the quote — this is fine because we're walking
    // parsed JSON, not text. A round-trip through JSON.stringify would
    // re-escape the quote correctly.
    expect(out.p).toBe(`/tmp/a"b/models/foo.sql`)
    // Sanity check: JSON.stringify works on the result (no invalid state).
    const roundTrip = JSON.parse(JSON.stringify(out))
    expect(roundTrip.p).toBe(out.p)
  })

  test("target path with Windows-style backslashes gets substituted without producing invalid escape sequences", () => {
    const input = { p: `${SAMPLE_ROOT_SENTINEL}/models/foo.sql` }
    const winPath = String.raw`C:\Users\alice\altimate-sample-dbt`
    const out = rehydrateSentinels(input, winPath, String.raw`C:\Users\alice`) as { p: string }
    expect(out.p).toBe(String.raw`C:\Users\alice\altimate-sample-dbt/models/foo.sql`)
    // Should JSON-round-trip cleanly (naive text-replace failed here).
    const roundTrip = JSON.parse(JSON.stringify(out))
    expect(roundTrip.p).toBe(out.p)
  })

  test("object keys are NOT rehydrated — only string values (guards against a sentinel accidentally appearing in a key)", () => {
    // Synthesize a manifest fragment where the key contains the sentinel
    // — walking should leave the key untouched. Object-key rehydration
    // would corrupt the schema.
    const input: Record<string, unknown> = {}
    input[SAMPLE_ROOT_SENTINEL] = "value"
    const out = rehydrateSentinels(input, "/target", "/parent") as Record<string, unknown>
    // Key preserved literally.
    expect(Object.keys(out)).toContain(SAMPLE_ROOT_SENTINEL)
  })

  test("PARENT sentinel is replaced before ROOT so the shorter one can't shadow the longer one", () => {
    // If order were reversed, {{SAMPLE_ROOT}} would match inside
    // {{SAMPLE_ROOT_PARENT}} first and leave dangling tokens.
    const input = `${SAMPLE_ROOT_PARENT_SENTINEL}/other-project`
    const out = rehydrateSentinels(input, "/user/sample", "/user") as string
    expect(out).toBe("/user/other-project")
    // The ROOT sentinel is a substring of the PARENT sentinel token — a
    // faulty impl would produce "{{}}/other-project" or similar. Guard.
    expect(out).not.toContain("SAMPLE_ROOT")
    expect(out).not.toContain("{{")
  })

  test("array of strings is walked", () => {
    const input = [
      `${SAMPLE_ROOT_SENTINEL}/a`,
      `${SAMPLE_ROOT_SENTINEL}/b`,
      { nested: `${SAMPLE_ROOT_SENTINEL}/c` },
    ]
    const out = rehydrateSentinels(input, "/x", "/") as any[]
    expect(out[0]).toBe("/x/a")
    expect(out[1]).toBe("/x/b")
    expect(out[2].nested).toBe("/x/c")
  })

  test("numbers, booleans, nulls are untouched", () => {
    const input = { n: 42, b: true, z: null, s: `${SAMPLE_ROOT_SENTINEL}/x` }
    const out = rehydrateSentinels(input, "/t", "/") as Record<string, unknown>
    expect(out.n).toBe(42)
    expect(out.b).toBe(true)
    expect(out.z).toBeNull()
    expect(out.s).toBe("/t/x")
  })
})

describe("loadShippedManifest — end-to-end against the real shipped manifest", () => {
  test("loading the shipped sample's manifest.json with a target substitution yields no dangling sentinels", () => {
    delete process.env["ALTIMATE_STARTER_SAMPLE_DIR"]
    const location = resolveSampleSource()
    // Every branch of this test suite runs from within the worktree checkout
    // where the shipped sample tree lives at
    // packages/opencode/sample-projects/jaffle-shop-duckdb/. If the resolver
    // returns undefined here, the fallback candidate list is broken — that
    // IS the failure mode this test exists to catch. Do not silently skip.
    expect(location, "resolveSampleSource() returned undefined — the resolver's candidate-path list can no longer find the shipped sample tree in a dev checkout").toBeDefined()
    const materializedTarget = "/tmp/materialized-target"
    const manifest = loadShippedManifest(location!.path, materializedTarget)
    // The rehydrated manifest MUST NOT contain the sentinel strings
    // anywhere — the whole point of the tree walk was to substitute
    // them all.
    const serialized = JSON.stringify(manifest)
    expect(serialized).not.toContain(SAMPLE_ROOT_SENTINEL)
    expect(serialized).not.toContain(SAMPLE_ROOT_PARENT_SENTINEL)
    // And the materializedTarget path should appear (that's the substitution).
    expect(serialized).toContain(materializedTarget)
  })
})
