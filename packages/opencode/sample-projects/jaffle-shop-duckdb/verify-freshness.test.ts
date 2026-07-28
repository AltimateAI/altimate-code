/**
 * Freshness guard for the committed pre-compiled dbt manifest.
 *
 * `sample-projects/regenerate.sh` advertises this test in its docblock:
 * "the freshness test will fail if source hashes don't match what the
 * committed manifest was generated from — that's the guard against a
 * source edit landing without a matching artifact refresh." Consensus
 * review flagged that no such test existed. This IS that test.
 *
 * For every model / seed node in the shipped `target/manifest.json` that
 * carries a `checksum.name === "sha256"`, re-hash the source file it
 * refers to and assert the digests match. If a maintainer edits a model
 * without re-running `regenerate.sh`, this fails — pointing at the
 * specific file and expected checksum.
 *
 * dbt's convention: the hash is computed on the file contents with the
 * trailing newline stripped (see dbt-core's `hash_file` in
 * `dbt.parser.base.BaseParser`; `contents.rstrip("\n")` then sha256).
 * We reproduce that here so a maintainer's editor-added or -stripped
 * trailing newline doesn't false-positive the check.
 */

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const SAMPLE_DIR = path.resolve(__dirname)
const MANIFEST_PATH = path.join(SAMPLE_DIR, "target", "manifest.json")

interface ChecksumStanza {
  name: string
  checksum: string
}

interface DbtNode {
  original_file_path?: string
  checksum?: ChecksumStanza
  resource_type?: string
}

/**
 * dbt's file-hash convention. See dbt-core `hash_file`.
 * The sha256 is over the contents with the FINAL trailing newline stripped
 * (only one — not all consecutive trailing newlines).
 */
function dbtFileHash(absPath: string): string {
  const raw = fs.readFileSync(absPath, "utf8")
  // Strip one trailing \n if present. Windows line endings survive as \r\n;
  // dbt hashes the file contents as-read from disk in text mode, so we
  // match that.
  const stripped = raw.endsWith("\n") ? raw.slice(0, -1) : raw
  return createHash("sha256").update(stripped, "utf8").digest("hex")
}

describe("verify-freshness — committed manifest matches source files", () => {
  test("target/manifest.json is present", () => {
    expect(fs.existsSync(MANIFEST_PATH), `expected shipped manifest at ${MANIFEST_PATH}`).toBe(true)
  })

  test("every checksummed node in the manifest matches its source file's dbt hash", () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as {
      nodes?: Record<string, DbtNode>
    }
    const nodes = manifest.nodes ?? {}
    const failures: string[] = []
    let checked = 0

    for (const [id, node] of Object.entries(nodes)) {
      const checksum = node.checksum
      if (!checksum || checksum.name !== "sha256") continue
      const origPath = node.original_file_path
      if (!origPath) continue
      const abs = path.join(SAMPLE_DIR, origPath)
      if (!fs.existsSync(abs)) {
        failures.push(
          `${id}: manifest references ${origPath} but the file does not exist at ${abs}. Rerun regenerate.sh?`,
        )
        continue
      }
      const expected = checksum.checksum
      const actual = dbtFileHash(abs)
      if (actual !== expected) {
        failures.push(
          `${id}: sha256 mismatch for ${origPath}\n  committed manifest: ${expected}\n  current file:       ${actual}\n  → run sample-projects/regenerate.sh and commit the refreshed manifest`,
        )
      }
      checked++
    }

    // Sanity: the manifest must actually contain checksummed nodes; a zero
    // count would silently pass this test on any breakage.
    expect(checked, "no sha256-checksummed nodes found in manifest — has the shape changed?").toBeGreaterThan(0)
    expect(failures).toEqual([])
  })

  test("shipped source files are all represented in the manifest (codex NEW-10 — set membership, not just per-node hashing)", () => {
    // Companion to the per-node hash test. That test iterates nodes and
    // hashes what's there; it says nothing about whether new source files
    // added under models/ or seeds/ actually made it into the manifest.
    // A maintainer who adds a new .sql model but forgets to re-run
    // regenerate.sh would sail past the per-node hash check (the model
    // simply has no manifest node to compare against). This test locks
    // the source SET so that gap is caught.
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as {
      nodes?: Record<string, DbtNode>
    }
    const nodes = manifest.nodes ?? {}
    const manifestPaths = new Set<string>()
    for (const node of Object.values(nodes)) {
      if (node.original_file_path) manifestPaths.add(node.original_file_path)
    }
    // Enumerate the actual source tree the maintainer curates. Only files
    // dbt itself would compile: .sql models, .csv seeds. Docs, YAML,
    // manifest metadata files are not per-file compiled — dbt notices
    // schema.yml through its own parser and doesn't emit a checksum'd
    // node for it.
    const expectedFiles: string[] = []
    const walk = (relDir: string, exts: RegExp) => {
      const absDir = path.join(SAMPLE_DIR, relDir)
      if (!fs.existsSync(absDir)) return
      for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        const relPath = path.join(relDir, entry.name)
        if (entry.isDirectory()) walk(relPath, exts)
        else if (exts.test(entry.name)) expectedFiles.push(relPath)
      }
    }
    walk("models", /\.sql$/)
    walk("seeds", /\.csv$/)
    const missing = expectedFiles.filter((f) => !manifestPaths.has(f))
    expect(
      missing,
      `source files exist under models/ or seeds/ but have no manifest node — re-run sample-projects/regenerate.sh: ${missing.join(", ")}`,
    ).toEqual([])
  })

  test("manifest identity fields are scrubbed (no maintainer UUID or wall-clock times leaked to installers)", () => {
    // Companion to regenerate.sh's sanitizer: identity + wall-clock fields
    // must be zeroed/pinned. If a maintainer runs `dbt compile` by hand
    // without going through regenerate.sh and commits, this catches it.
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as {
      metadata?: Record<string, unknown>
      nodes?: Record<string, { created_at?: number }>
    }
    const md = manifest.metadata ?? {}
    const ZERO_UUID = "00000000-0000-0000-0000-000000000000"
    const FIXED_ISO = "2026-07-24T00:00:00Z"
    expect(md.user_id, "user_id would leak the maintainer's persistent dbt telemetry UUID").toBe(ZERO_UUID)
    expect(md.project_id).toBe(ZERO_UUID)
    expect(md.invocation_id).toBe(ZERO_UUID)
    expect(md.generated_at).toBe(FIXED_ISO)
    expect(md.invocation_started_at).toBe(FIXED_ISO)
    expect(md.run_started_at).toBe(FIXED_ISO)
    expect(md.send_anonymous_usage_stats).toBe(false)
    // env stripped — carries USER/PWD/HOME.
    expect(md.env).toBeUndefined()
  })
})
