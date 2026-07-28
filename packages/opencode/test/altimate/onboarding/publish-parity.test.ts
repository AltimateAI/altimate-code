/**
 * Publish-parity guard: script/publish.ts must copy every file that
 * MATERIALIZE_ENTRIES in materialize.ts declares. If a maintainer adds a
 * new file to the runtime whitelist but forgets to add it to the publish
 * copy step, dev + local tests still pass (they resolve to the source
 * tree via the dev-source-tree candidate) but prod installs ship
 * without the file — silently producing a broken materialize.
 *
 * The test reads publish.ts as text and asserts that every entry from
 * MATERIALIZE_ENTRIES appears as a path in the copy commands. A
 * reasonably tolerant match: we look for the literal `./sample-projects/
 * <sample-name>/<entry>` substring, which is how publish.ts writes them
 * today. If publish.ts refactors the copy shape substantially the test
 * fails loudly and forces this file to be updated in lockstep — that's
 * the point.
 */

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// Keep this list in sync with MATERIALIZE_ENTRIES in
// packages/opencode/src/altimate/onboarding/materialize.ts. We inline the
// list here (rather than import it) so the test would fail even if the
// import chain re-exported it — a re-export shadow that always agrees
// with itself is not a real cross-check. The lint is against the shape
// publish.ts actually writes on disk.
const MATERIALIZE_ENTRIES = [
  "README.md",
  "dbt_project.yml",
  "profiles.yml",
  "sample-manifest.json",
  ".gitignore",
  "models",
  "seeds",
  "target/manifest.json",
]

describe("publish.ts ships every file the materializer expects", () => {
  test("every MATERIALIZE_ENTRIES path appears in publish.ts's sample-projects copy list", () => {
    const publishPath = path.resolve(__dirname, "../../../script/publish.ts")
    const src = fs.readFileSync(publishPath, "utf8")
    // The copy commands reference paths like
    // `./sample-projects/jaffle-shop-duckdb/<entry>` — split on any
    // whitespace and lint each entry. Fuzzy substring is intentional
    // (we want to survive `\\` line-continuations, path stitching, etc.);
    // if publish.ts refactors away from that shape entirely, the test
    // fails and the maintainer updates both files together.
    const missing: string[] = []
    for (const entry of MATERIALIZE_ENTRIES) {
      const needle = `sample-projects/jaffle-shop-duckdb/${entry}`
      if (!src.includes(needle)) missing.push(entry)
    }
    expect(
      missing,
      `publish.ts is missing copy commands for these materialize entries — dev works but prod installs ship broken: ${missing.join(", ")}`,
    ).toEqual([])
  })

  test("if publish.ts's sample-projects block is removed entirely, the test fails loudly", () => {
    // Sanity: our substring search MUST find something in publish.ts today.
    // A zero-match result would silently pass every entry check above if
    // publish.ts were entirely rewritten to not mention sample-projects,
    // which would be a much bigger regression than the parity check alone
    // is meant to catch.
    const publishPath = path.resolve(__dirname, "../../../script/publish.ts")
    const src = fs.readFileSync(publishPath, "utf8")
    expect(src).toContain("sample-projects/jaffle-shop-duckdb/")
  })
})
