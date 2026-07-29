/**
 * Single-source-of-truth guard: `sample-manifest.json`'s `assets` array is
 * consumed by BOTH materialize.ts (runtime copy into user's home) AND
 * publish.ts (release-time copy into the wrapper npm package). This test
 * verifies every asset listed in the manifest actually exists on disk in
 * the sample source tree — so the two consumers can never diverge from
 * reality: they read the same list, and if the list references a missing
 * file, we catch it in CI before it silently ships broken.
 *
 * Before we single-sourced the list, the same file names lived in three
 * places (materialize.ts const, publish.ts cp block, this test file's
 * hardcoded list) — codex dedupe-sweep called it out as "three sources of
 * truth for the same file list." The parity test was compensating for the
 * duplication rather than fixing it. Now the manifest IS the source, and
 * the test's only job is to verify the manifest matches the tree.
 */

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { readSampleAssets } from "../../../src/altimate/onboarding/materialize"

const SAMPLE_SOURCE = path.resolve(
  __dirname,
  "../../../sample-projects/jaffle-shop-duckdb",
)

describe("sample-manifest.json assets list ↔ sample source tree", () => {
  test("every REQUIRED asset in the manifest exists in the sample source", () => {
    const assets = readSampleAssets(SAMPLE_SOURCE)
    const missing: string[] = []
    for (const asset of assets) {
      if (!asset.required) continue
      const abs = path.join(SAMPLE_SOURCE, asset.from)
      if (!fs.existsSync(abs)) missing.push(asset.from)
    }
    expect(
      missing,
      `sample-manifest.json lists required assets that don't exist on disk — publish will fail and materialize will error. Fix the manifest or add the file: ${missing.join(", ")}`,
    ).toEqual([])
  })

  test("every asset entry has the correct kind (file vs dir)", () => {
    const assets = readSampleAssets(SAMPLE_SOURCE)
    const wrongKind: string[] = []
    for (const asset of assets) {
      const abs = path.join(SAMPLE_SOURCE, asset.from)
      if (!fs.existsSync(abs)) continue // absence is covered by the required-check above
      const isDir = fs.statSync(abs).isDirectory()
      if (asset.kind === "dir" && !isDir) wrongKind.push(`${asset.from} (declared dir, is file)`)
      if (asset.kind === "file" && isDir) wrongKind.push(`${asset.from} (declared file, is dir)`)
    }
    expect(wrongKind).toEqual([])
  })

  test.each([
    "../victim",
    "/etc/passwd",
    "models/../../../etc/passwd",
    "models/../../escape",
    "",
  ])("readSampleAssets rejects traversal/absolute path %p (cubic P1)", (badFrom) => {
    const scratch = fs.mkdtempSync(path.join(require("os").tmpdir(), "publish-parity-traversal-"))
    try {
      fs.writeFileSync(
        path.join(scratch, "sample-manifest.json"),
        JSON.stringify({
          name: "x",
          version: "1",
          kind: "altimate-starter-sample",
          assets: [{ from: badFrom, kind: "file", required: true }],
        }),
      )
      expect(() => readSampleAssets(scratch)).toThrow(/relative path.*no '\.\.'/)
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })

  test("readSampleAssets rejects a malformed manifest", () => {
    // Create a scratch source dir with a broken manifest — assets not an array.
    const scratch = fs.mkdtempSync(path.join(require("os").tmpdir(), "publish-parity-"))
    try {
      fs.writeFileSync(
        path.join(scratch, "sample-manifest.json"),
        JSON.stringify({ name: "x", version: "1", kind: "altimate-starter-sample", assets: "not-an-array" }),
      )
      expect(() => readSampleAssets(scratch)).toThrow(/assets/)
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })
})
