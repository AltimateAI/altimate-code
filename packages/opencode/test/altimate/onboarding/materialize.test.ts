/**
 * materialize.ts — copies the shipped starter sample onto the user's
 * filesystem with a marker-based conflict policy and unsafe-HOME guard.
 *
 * These tests exercise the real materializer against the real shipped
 * sample source at packages/opencode/sample-projects/jaffle-shop-duckdb/
 * — verifies whitelisted files land, marker is written, DuckDB profile
 * is intact, reuse is correctly detected on second call, unsafe HOME
 * paths are refused with actionable messages.
 */

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { materializeSample, rejectUnsafeHome } from "../../../src/altimate/onboarding/materialize"
import { MARKER_FILE_NAME, MARKER_KIND, readMarker } from "../../../src/altimate/onboarding/marker"

const SAMPLE_VERSION = "1.0.0"
const CLI_VERSION = "0.9.4-test"

function makeTmpParent(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe("rejectUnsafeHome — codex-flagged HOME hygiene guard", () => {
  test("undefined HOME → refused", () => {
    expect(rejectUnsafeHome(undefined)).toContain("not set")
  })

  test("empty string HOME → refused", () => {
    expect(rejectUnsafeHome("")).toContain("not set")
  })

  test("HOME='/' → refused", () => {
    expect(rejectUnsafeHome("/")).toContain("not a usable")
  })

  test("HOME='/tmp/something' → refused (ephemeral)", () => {
    expect(rejectUnsafeHome("/tmp/xyz")).toContain("ephemeral")
  })

  test("normal HOME → allowed (returns undefined)", () => {
    expect(rejectUnsafeHome("/Users/somebody")).toBeUndefined()
    expect(rejectUnsafeHome("/home/somebody")).toBeUndefined()
  })

  // /root is safe when the process IS running as root; only refused when
  // uid != 0. Skip on macOS where getuid() behavior is CI-dependent.
  test("HOME='/root' with non-root uid → refused (guards against sudo npm install)", () => {
    if (typeof process.getuid !== "function" || process.getuid() === 0) return
    const err = rejectUnsafeHome("/root")
    expect(err).toBeDefined()
    expect(err).toContain("sudo")
  })
})

describe("materializeSample — happy path", () => {
  test("fresh materialize copies the sample files and writes a marker", async () => {
    const parent = makeTmpParent("materialize-fresh-")
    const result = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: SAMPLE_VERSION,
      cliVersion: CLI_VERSION,
    })

    expect(result.reused).toBe(false)
    expect(result.suffix).toBe(0)
    expect(result.targetPath).toBe(path.join(parent, "starter"))

    // Whitelisted files present.
    const expectedFiles = [
      "README.md",
      "dbt_project.yml",
      "profiles.yml",
      "sample-manifest.json",
      "models/staging/stg_customers.sql",
      "models/staging/schema.yml",
      "models/marts/customers.sql",
      "models/marts/schema.yml",
      "seeds/raw_customers.csv",
      "seeds/raw_orders.csv",
      "target/manifest.json",
    ]
    for (const rel of expectedFiles) {
      expect(fs.existsSync(path.join(result.targetPath, rel))).toBe(true)
    }

    // Marker was written and reads back correctly.
    const marker = readMarker(result.targetPath)
    expect(marker).toBeDefined()
    expect(marker!.kind).toBe(MARKER_KIND)
    expect(marker!.sampleName).toBe("jaffle-shop-duckdb")
    expect(marker!.version).toBe(SAMPLE_VERSION)
    expect(marker!.cliVersion).toBe(CLI_VERSION)

    // profiles.yml still declares the DuckDB target — codex fix #3 asserts
    // the shipped-source-copy did not silently drop this critical file.
    const profiles = fs.readFileSync(path.join(result.targetPath, "profiles.yml"), "utf8")
    expect(profiles).toContain("type: duckdb")
    expect(profiles).toContain("target/jaffle.duckdb")
  })
})

describe("materializeSample — conflict policy", () => {
  test("second call to same target reuses existing sample (no re-copy, no marker rewrite)", async () => {
    const parent = makeTmpParent("materialize-reuse-")
    const first = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: SAMPLE_VERSION,
      cliVersion: CLI_VERSION,
    })
    const originalMaterializedAt = readMarker(first.targetPath)!.materializedAt
    // Small sleep so we can distinguish materializedAt values if a rewrite
    // happens — reuse must NOT rewrite the marker.
    await new Promise((r) => setTimeout(r, 20))
    const second = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: SAMPLE_VERSION,
      cliVersion: CLI_VERSION,
    })
    expect(second.reused).toBe(true)
    expect(second.targetPath).toBe(first.targetPath)
    expect(readMarker(second.targetPath)!.materializedAt).toBe(originalMaterializedAt)
  })

  test("preferred target holds unrelated content → suffix -2 slot used, unrelated content untouched", async () => {
    const parent = makeTmpParent("materialize-collide-")
    const preferred = path.join(parent, "starter")
    fs.mkdirSync(preferred)
    fs.writeFileSync(path.join(preferred, "user-file.txt"), "important, do not touch")
    const result = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: SAMPLE_VERSION,
      cliVersion: CLI_VERSION,
    })
    expect(result.suffix).toBe(1)
    expect(result.targetPath).toBe(path.join(parent, "starter-2"))
    // User's original file still there, untouched.
    expect(fs.readFileSync(path.join(preferred, "user-file.txt"), "utf8")).toBe("important, do not touch")
  })

  test("second call after in-place upgrade (bumped sampleVersion) refuses in-place unless allowInPlaceUpgrade=true", async () => {
    const parent = makeTmpParent("materialize-upgrade-")
    const first = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: "1.0.0",
      cliVersion: CLI_VERSION,
    })
    const second = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: "1.0.1",
      cliVersion: CLI_VERSION,
      // allowInPlaceUpgrade NOT set — impl should return reused-with-note.
    })
    // Same path, "reused" reported so caller sees the state and prompts.
    expect(second.targetPath).toBe(first.targetPath)
    expect(second.reused).toBe(true)
    expect(second.note).toContain("Caller must prompt")
  })

  test("in-place upgrade path rewrites files + updates marker version", async () => {
    const parent = makeTmpParent("materialize-upgrade-ok-")
    await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: "1.0.0",
      cliVersion: CLI_VERSION,
    })
    const upgraded = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: "1.0.1",
      cliVersion: CLI_VERSION,
      allowInPlaceUpgrade: true,
    })
    expect(upgraded.reused).toBe(false)
    expect(readMarker(upgraded.targetPath)!.version).toBe("1.0.1")
  })
})

describe("materializeSample — failure modes", () => {
  test("unsafe HOME (unset targetParent + HOME=/tmp) → refuses with actionable error", async () => {
    // Simulate the unsafe-HOME path by pointing targetParent at /tmp/x
    // directly (bypasses the opts.targetParent short-circuit? Actually
    // opts.targetParent set → skips rejectUnsafeHome. To exercise the
    // guard we need to omit targetParent and control os.homedir(). We
    // spy on os.homedir instead.
    const origHomedir = os.homedir
    Object.defineProperty(os, "homedir", { value: () => "/tmp/xyz-unsafe", configurable: true })
    try {
      await expect(
        materializeSample({
          preferredTargetName: "starter",
          sampleVersion: SAMPLE_VERSION,
          cliVersion: CLI_VERSION,
        }),
      ).rejects.toThrow(/ephemeral/)
    } finally {
      Object.defineProperty(os, "homedir", { value: origHomedir, configurable: true })
    }
  })

  test("unwritable target parent → refuses with actionable error (codex #3)", async () => {
    // Point at a nonexistent path that fs.accessSync will reject with
    // ENOENT (unwritable-in-the-sense-that-we-cannot-write-there).
    await expect(
      materializeSample({
        targetParent: "/definitely/not/writable/anywhere",
        preferredTargetName: "starter",
        sampleVersion: SAMPLE_VERSION,
        cliVersion: CLI_VERSION,
      }),
    ).rejects.toThrow(/not writable/)
  })
})

/**
 * Path-traversal / adversarial-input guards for `preferredTargetName`.
 * `sample_setup` accepts this from the LLM; a prompt-injected model turn
 * (or a compromised template) could try to steer materialization outside
 * `targetParent`. The name-regex + post-resolve containment check should
 * refuse before any fs write happens.
 */
describe("materializeSample — preferredTargetName input hardening", () => {
  const REJECTED = [
    "../escape",
    "..",
    "../../etc/passwd",
    "a/b",
    "/absolute",
    ".hidden",
    "with space",
    "with\ttab",
    "with\nnewline",
    "quote'char",
    "back\\slash",
    "", // empty — no valid segment
  ]
  for (const name of REJECTED) {
    test(`refuses preferredTargetName ${JSON.stringify(name)} before any fs write`, async () => {
      const parent = makeTmpParent("materialize-traversal-")
      await expect(
        materializeSample({
          targetParent: parent,
          preferredTargetName: name,
          sampleVersion: SAMPLE_VERSION,
          cliVersion: CLI_VERSION,
        }),
      ).rejects.toThrow(/not a plain directory name|refusing to materialize/)
      // Parent still exists, but nothing was materialized inside it.
      expect(fs.readdirSync(parent)).toEqual([])
    })
  }

  const ACCEPTED = ["starter", "altimate-sample-dbt", "a", "A1", "with.dot", "with-dash", "with_underscore"]
  for (const name of ACCEPTED) {
    test(`accepts preferredTargetName ${JSON.stringify(name)}`, async () => {
      const parent = makeTmpParent("materialize-accept-")
      const result = await materializeSample({
        targetParent: parent,
        preferredTargetName: name,
        sampleVersion: SAMPLE_VERSION,
        cliVersion: CLI_VERSION,
      })
      expect(result.targetPath).toBe(path.join(parent, name))
    })
  }
})

/**
 * Interrupt-safety: a prior killed materialize leaves a `.<name>.tmp-<hex>`
 * staging dir. The next run must (a) not classify it as unknown-dir and
 * escalate to a suffix, and (b) sweep the orphan.
 */
describe("materializeSample — orphan staging cleanup", () => {
  test("prior killed run left a .starter.tmp-* orphan → next run sweeps it AND materializes starter/", async () => {
    const parent = makeTmpParent("materialize-orphan-")
    const orphan1 = path.join(parent, ".starter.tmp-deadbeef")
    const orphan2 = path.join(parent, ".starter.tmp-cafebabe")
    fs.mkdirSync(orphan1, { recursive: true })
    fs.writeFileSync(path.join(orphan1, "partial.txt"), "leftover from crash")
    fs.mkdirSync(orphan2, { recursive: true })

    const result = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: SAMPLE_VERSION,
      cliVersion: CLI_VERSION,
    })

    // Fresh materialize into starter/ (not starter-2/).
    expect(result.suffix).toBe(0)
    expect(result.targetPath).toBe(path.join(parent, "starter"))
    // Marker present → fully atomic.
    expect(fs.existsSync(path.join(result.targetPath, MARKER_FILE_NAME))).toBe(true)
    // Both orphans gone.
    expect(fs.existsSync(orphan1)).toBe(false)
    expect(fs.existsSync(orphan2)).toBe(false)
    // No stray staging dir for THIS run.
    const staging = fs.readdirSync(parent).filter((n) => n.startsWith(".starter.tmp-"))
    expect(staging).toEqual([])
  })

  test("orphan for a DIFFERENT preferredName is left alone (different sweep prefix)", async () => {
    const parent = makeTmpParent("materialize-orphan-scoped-")
    const otherOrphan = path.join(parent, ".other-sample.tmp-abcdef")
    fs.mkdirSync(otherOrphan, { recursive: true })

    await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: SAMPLE_VERSION,
      cliVersion: CLI_VERSION,
    })

    // Only starter's orphans get swept; another sample's staging is not our
    // business.
    expect(fs.existsSync(otherOrphan)).toBe(true)
  })
})
