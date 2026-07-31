/**
 * marker.ts — the on-disk `.altimate-sample.json` sentinel that decides
 * whether the starter-sample materializer can reuse / upgrade / suffix /
 * refuse a candidate target directory.
 *
 * Test surface targets the four `classifyTarget()` verdicts + the
 * `findSafeTarget()` suffix-hunt (numeric loop → randomized fallback),
 * plus the `checkParentWritable()` pre-check that codex flagged as needing
 * its own contract.
 */

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  MARKER_FILE_NAME,
  MARKER_KIND,
  checkParentWritable,
  classifyTarget,
  findSafeTarget,
  readMarker,
  writeMarker,
  type SampleMarker,
} from "../../../src/altimate/onboarding/marker"

function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makeMarker(overrides: Partial<SampleMarker> = {}): SampleMarker {
  return {
    kind: MARKER_KIND,
    sampleName: "jaffle-shop-duckdb",
    version: "1.0.0",
    materializedAt: "2026-07-24T12:00:00.000Z",
    cliVersion: "0.9.4",
    ...overrides,
  }
}

describe("readMarker + writeMarker round-trip", () => {
  test("write then read returns the same marker shape", () => {
    const dir = makeTmp("marker-rt-")
    const marker = makeMarker()
    writeMarker(dir, marker)
    const readBack = readMarker(dir)
    expect(readBack).toEqual(marker)
  })

  test("readMarker returns undefined when the file is missing", () => {
    const dir = makeTmp("marker-missing-")
    expect(readMarker(dir)).toBeUndefined()
  })

  test("readMarker returns undefined on unparseable JSON", () => {
    const dir = makeTmp("marker-badjson-")
    fs.writeFileSync(path.join(dir, MARKER_FILE_NAME), "{not-json")
    expect(readMarker(dir)).toBeUndefined()
  })

  test("readMarker rejects a payload with wrong `kind` (guards against a user's ordinary .json in the dir being mistaken for our marker)", () => {
    const dir = makeTmp("marker-wrongkind-")
    fs.writeFileSync(
      path.join(dir, MARKER_FILE_NAME),
      JSON.stringify({ kind: "some-other-tool", sampleName: "x", version: "1", materializedAt: "", cliVersion: "" }),
    )
    expect(readMarker(dir)).toBeUndefined()
  })

  test("readMarker rejects a payload missing required string fields", () => {
    const dir = makeTmp("marker-shortfield-")
    fs.writeFileSync(
      path.join(dir, MARKER_FILE_NAME),
      JSON.stringify({ kind: MARKER_KIND, sampleName: "x" }), // missing version, materializedAt, cliVersion
    )
    expect(readMarker(dir)).toBeUndefined()
  })
})

describe("classifyTarget — the four decision-table branches", () => {
  test("branch: dir does not exist → empty", () => {
    const parent = makeTmp("classify-notexist-")
    const target = path.join(parent, "does-not-exist")
    expect(classifyTarget(target, "1.0.0", "jaffle-shop-duckdb")).toEqual({ kind: "empty" })
  })

  test("branch: dir exists but is empty → empty", () => {
    const target = makeTmp("classify-emptydir-")
    expect(classifyTarget(target, "1.0.0", "jaffle-shop-duckdb")).toEqual({ kind: "empty" })
  })

  test("branch: target is a file, not a directory → unknown-dir", () => {
    const parent = makeTmp("classify-filepath-")
    const target = path.join(parent, "some-file")
    fs.writeFileSync(target, "hello")
    const result = classifyTarget(target, "1.0.0", "jaffle-shop-duckdb")
    expect(result.kind).toBe("unknown-dir")
  })

  test("branch: our marker at requested version → our-sample-current", () => {
    const dir = makeTmp("classify-current-")
    writeMarker(dir, makeMarker({ version: "1.0.0" }))
    const result = classifyTarget(dir, "1.0.0", "jaffle-shop-duckdb")
    expect(result.kind).toBe("our-sample-current")
    if (result.kind === "our-sample-current") {
      expect(result.marker.version).toBe("1.0.0")
      expect(result.path).toBe(dir)
    }
  })

  test("branch: our marker at different version → our-sample-different-version", () => {
    const dir = makeTmp("classify-diffver-")
    writeMarker(dir, makeMarker({ version: "1.0.0" }))
    const result = classifyTarget(dir, "1.0.1", "jaffle-shop-duckdb")
    expect(result.kind).toBe("our-sample-different-version")
    if (result.kind === "our-sample-different-version") {
      expect(result.marker.version).toBe("1.0.0")
    }
  })

  test("branch: non-empty dir with NO marker → unknown-dir (never overwrite)", () => {
    const dir = makeTmp("classify-unknown-")
    fs.writeFileSync(path.join(dir, "unrelated.txt"), "something the user had")
    const result = classifyTarget(dir, "1.0.0", "jaffle-shop-duckdb")
    expect(result.kind).toBe("unknown-dir")
    if (result.kind === "unknown-dir") {
      expect(result.reason).toContain("no altimate-code marker")
    }
  })

  test("branch: non-empty dir with wrong-kind marker → unknown-dir", () => {
    const dir = makeTmp("classify-wrongkind-")
    fs.writeFileSync(
      path.join(dir, MARKER_FILE_NAME),
      JSON.stringify({ kind: "other-tool", sampleName: "x", version: "1", materializedAt: "", cliVersion: "" }),
    )
    const result = classifyTarget(dir, "1.0.0", "jaffle-shop-duckdb")
    expect(result.kind).toBe("unknown-dir")
  })

  test("branch: our marker but DIFFERENT sampleName → unknown-dir (cubic P1: don't reuse a different sample) (cubic P1 #1)", () => {
    // The marker was written by an altimate-code CLI for sample-A. We're
    // asking about sample-B. Even if the version happens to match, this
    // is not "ours" for THIS request — must fall into the suffix
    // escalation path, not silently reuse or in-place-upgrade.
    const dir = makeTmp("classify-diff-sample-")
    writeMarker(dir, makeMarker({ sampleName: "other-sample", version: "1.0.0" }))
    const result = classifyTarget(dir, "1.0.0", "jaffle-shop-duckdb")
    expect(result.kind).toBe("unknown-dir")
    if (result.kind === "unknown-dir") {
      expect(result.reason).toContain("belongs to sample 'other-sample'")
    }
  })

  test("branch: symlinked directory → unknown-dir (codex NEW-21 — lstat, don't follow)", () => {
    // Pre-seed a symlink pointing at a REAL dir with a valid marker.
    // If classifyTarget follows the link, it would return
    // our-sample-current and (in the outer flow) authorize a
    // destructive overwrite of the linked-to content. lstat should catch
    // it as a symlink and classify unknown-dir.
    const linkTarget = makeTmp("classify-symlink-target-")
    writeMarker(linkTarget, makeMarker({ version: "1.0.0" }))
    const parent = makeTmp("classify-symlink-parent-")
    const link = path.join(parent, "our-sample")
    fs.symlinkSync(linkTarget, link)
    const result = classifyTarget(link, "1.0.0", "jaffle-shop-duckdb")
    expect(result.kind).toBe("unknown-dir")
    if (result.kind === "unknown-dir") {
      expect(result.reason).toContain("symlink")
    }
  })

  test("branch: unreadable directory (chmod 000) → unknown-dir with EACCES-flavored reason", () => {
    // Skip on root — chmod restrictions don't apply.
    if (typeof process.getuid !== "function" || process.getuid() === 0) return
    const dir = makeTmp("classify-unreadable-")
    fs.writeFileSync(path.join(dir, "some-content"), "x")
    fs.chmodSync(dir, 0o000)
    try {
      const result = classifyTarget(dir, "1.0.0", "jaffle-shop-duckdb")
      expect(result.kind).toBe("unknown-dir")
      if (result.kind === "unknown-dir") {
        expect(result.reason.toLowerCase()).toMatch(/unreadable|permission|eacces/)
      }
    } finally {
      // Restore so tmp cleanup can traverse it.
      try { fs.chmodSync(dir, 0o755) } catch { /* ignore */ }
    }
  })
})

describe("findSafeTarget — suffix hunt + randomized fallback", () => {
  test("preferred slot empty → returns suffix 0 at the preferred path", () => {
    const parent = makeTmp("safe-fresh-")
    const result = findSafeTarget(parent, "altimate-sample-dbt", "1.0.0", "jaffle-shop-duckdb")
    expect(result.suffix).toBe(0)
    expect(result.path).toBe(path.join(parent, "altimate-sample-dbt"))
    expect(result.state.kind).toBe("empty")
  })

  test("preferred slot holds unrelated content → returns -2 suffix", () => {
    const parent = makeTmp("safe-collide-")
    const preferredPath = path.join(parent, "altimate-sample-dbt")
    fs.mkdirSync(preferredPath)
    fs.writeFileSync(path.join(preferredPath, "unrelated.txt"), "user's stuff")
    const result = findSafeTarget(parent, "altimate-sample-dbt", "1.0.0", "jaffle-shop-duckdb")
    expect(result.suffix).toBe(1)
    expect(result.path).toBe(path.join(parent, "altimate-sample-dbt-2"))
  })

  test("preferred slot holds OUR sample at same version → returns suffix 0 with 'our-sample-current' state", () => {
    const parent = makeTmp("safe-reuse-")
    const preferredPath = path.join(parent, "altimate-sample-dbt")
    fs.mkdirSync(preferredPath)
    writeMarker(preferredPath, makeMarker({ version: "1.0.0" }))
    const result = findSafeTarget(parent, "altimate-sample-dbt", "1.0.0", "jaffle-shop-duckdb")
    expect(result.suffix).toBe(0)
    expect(result.state.kind).toBe("our-sample-current")
  })

  test("preferred slot holds OUR sample at different version → returns suffix 0 with 'different-version' state (caller decides upgrade vs new slot)", () => {
    const parent = makeTmp("safe-diffver-")
    const preferredPath = path.join(parent, "altimate-sample-dbt")
    fs.mkdirSync(preferredPath)
    writeMarker(preferredPath, makeMarker({ version: "0.9.0" }))
    const result = findSafeTarget(parent, "altimate-sample-dbt", "1.0.0", "jaffle-shop-duckdb")
    expect(result.suffix).toBe(0)
    expect(result.state.kind).toBe("our-sample-different-version")
  })

  test("all N numeric slots taken → randomized fallback returns a string suffix", () => {
    const parent = makeTmp("safe-random-")
    // Poison the first 3 candidate slots with unrelated content so the
    // numeric loop cannot land, forcing the randomized fallback path.
    for (const suffix of ["", "-2", "-3"]) {
      const dir = path.join(parent, `altimate-sample-dbt${suffix}`)
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, "unrelated.txt"), "user's stuff")
    }
    const result = findSafeTarget(parent, "altimate-sample-dbt", "1.0.0", "jaffle-shop-duckdb", 3)
    expect(typeof result.suffix).toBe("string")
    // Random suffix is 6 hex chars per the impl.
    expect(result.suffix).toMatch(/^[0-9a-f]{6}$/)
    expect(result.state.kind).toBe("empty")
    expect(result.path).toBe(path.join(parent, `altimate-sample-dbt-${result.suffix}`))
  })
})

describe("checkParentWritable — the pre-check codex asked for", () => {
  test("writable parent returns undefined", () => {
    const parent = makeTmp("writable-")
    expect(checkParentWritable(parent)).toBeUndefined()
  })

  test("nonexistent parent returns a specific error message", () => {
    const parent = "/definitely/does/not/exist/on/this/machine"
    const err = checkParentWritable(parent)
    expect(err).toBeDefined()
    expect(err).toContain("not writable")
  })
})
