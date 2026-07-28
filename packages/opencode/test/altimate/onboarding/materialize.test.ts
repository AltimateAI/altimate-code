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
      allowUnsafeParent: true,
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

    // target/manifest.json must be REHYDRATED at copy time — the shipped
    // artifact carries {{SAMPLE_ROOT}} / {{SAMPLE_ROOT_PARENT}} sentinels
    // in every path field so a single committed manifest works for every
    // materialization target. If copySampleTree ships it byte-for-byte,
    // /discover and /review get paths like
    // "{{SAMPLE_ROOT}}/models/staging/stg_customers.sql" and choke. This
    // asserts the sentinels were replaced with the real target path
    // BEFORE the file landed in the user's home.
    const manifest = fs.readFileSync(path.join(result.targetPath, "target/manifest.json"), "utf8")
    expect(manifest, "materialized manifest.json contains {{SAMPLE_ROOT}} — rehydration in copySampleTree is not running").not.toContain("{{SAMPLE_ROOT}}")
    expect(manifest, "materialized manifest.json contains {{SAMPLE_ROOT_PARENT}} — rehydration is missing the parent sentinel").not.toContain("{{SAMPLE_ROOT_PARENT}}")
    // Positive assertion: the materialized target path appears at least
    // once (in root_path or original_file_path fields).
    expect(manifest).toContain(result.targetPath)
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
      allowUnsafeParent: true,
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
      allowUnsafeParent: true,
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
      allowUnsafeParent: true,
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
      allowUnsafeParent: true,
    })
    const second = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: "1.0.1",
      cliVersion: CLI_VERSION,
      allowUnsafeParent: true,
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
      allowUnsafeParent: true,
    })
    const upgraded = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: "1.0.1",
      cliVersion: CLI_VERSION,
      allowUnsafeParent: true,
      allowInPlaceUpgrade: true,
    })
    expect(upgraded.reused).toBe(false)
    expect(readMarker(upgraded.targetPath)!.version).toBe("1.0.1")
  })

  test("installAlongside path materializes new version into starter-2, leaves old starter intact (codex #16)", async () => {
    const parent = makeTmpParent("materialize-alongside-")
    // Prior run: version 1.0.0 in slot 0.
    const first = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: "1.0.0",
      cliVersion: CLI_VERSION,
      allowUnsafeParent: true,
    })
    const oldPath = first.targetPath
    const oldMarker = readMarker(oldPath)!
    expect(oldMarker.version).toBe("1.0.0")
    // Install 1.0.1 ALONGSIDE — should skip slot 0 (version mismatch),
    // materialize into starter-2, leave starter/ untouched.
    const alongside = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: "1.0.1",
      cliVersion: CLI_VERSION,
      allowUnsafeParent: true,
      installAlongside: true,
    })
    expect(alongside.reused).toBe(false)
    expect(alongside.suffix).toBe(1) // slot 1 = <name>-2
    expect(alongside.targetPath).toBe(path.join(parent, "starter-2"))
    // Old marker/dir untouched.
    expect(fs.existsSync(oldPath)).toBe(true)
    expect(readMarker(oldPath)!.version).toBe("1.0.0")
    expect(readMarker(oldPath)!.materializedAt).toBe(oldMarker.materializedAt)
    // New marker at the alongside path.
    expect(readMarker(alongside.targetPath)!.version).toBe("1.0.1")
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
      // NO allowUnsafeParent — this test EXISTS to prove the guard fires
      // when the defaulted targetParent falls on an ephemeral path.
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
      allowUnsafeParent: true,
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
  // Split by which guard is expected to fire — regex vs containment check.
  // The alternation `regex|containment` previously masked *which* layer
  // caught the input; a review flagged that a regex regression could silently
  // shift catches to the containment layer without any test failing (the test
  // still passes because the second alternative matches). Asserting the
  // exact message per name proves the regex is doing the work it claims to.
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
    test(`refuses preferredTargetName ${JSON.stringify(name)} at the regex layer, before any fs write`, async () => {
      const parent = makeTmpParent("materialize-traversal-")
      await expect(
        materializeSample({
          targetParent: parent,
          preferredTargetName: name,
          sampleVersion: SAMPLE_VERSION,
          cliVersion: CLI_VERSION,
      allowUnsafeParent: true,
        }),
      ).rejects.toThrow(/not a plain directory name/)
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
      allowUnsafeParent: true,
      })
      expect(result.targetPath).toBe(path.join(parent, name))
    })
  }
})

/**
 * Default-targetParent behavior: when the caller omits targetParent, the
 * materializer must fall back to `os.homedir()` — and that call must run
 * through the same rejectUnsafeHome + writability guards as an explicit
 * targetParent. A review flagged that no test exercised the default path.
 */
describe("materializeSample — default targetParent", () => {
  test("omitted targetParent defaults to os.homedir() and materializes there", async () => {
    // Two things being tested together:
    //   1. When targetParent is omitted, the code falls back to os.homedir()
    //      (opts.targetParent ?? os.homedir()) — we mock homedir to a
    //      scratch dir and assert the result lands under it.
    //   2. The materializer still runs to completion — proves no other
    //      code path assumed targetParent was always set.
    // allowUnsafeParent is set so the tmp-shaped scratch home doesn't
    // trigger rejectUnsafeHome; the guard itself has its own dedicated
    // "unsafe HOME → refuses" test above that verifies it fires on the
    // defaulted path.
    const scratchParent = makeTmpParent("materialize-default-home-")
    const origHomedir = os.homedir
    Object.defineProperty(os, "homedir", { value: () => scratchParent, configurable: true })
    try {
      const result = await materializeSample({
        preferredTargetName: "altimate-sample-default",
        sampleVersion: SAMPLE_VERSION,
        cliVersion: CLI_VERSION,
        allowUnsafeParent: true,
      })
      expect(result.targetPath).toBe(path.join(scratchParent, "altimate-sample-default"))
      expect(fs.existsSync(path.join(result.targetPath, MARKER_FILE_NAME))).toBe(true)
    } finally {
      Object.defineProperty(os, "homedir", { value: origHomedir, configurable: true })
    }
  })
})

/**
 * Symlink hardening (codex #21). `classifyTarget` uses lstatSync so a
 * symlinked target is classified `unknown-dir` and forwarded to a suffix,
 * rather than being followed (which would (a) place the materialize outside
 * the parent our containment check validated, or (b) let an "empty"
 * classification silently unlink the symlink when the overwrite path fires).
 */
describe("materializeSample — symlink target", () => {
  test("symlinked preferred slot is classified unknown-dir → suffixed to -2, symlink untouched", async () => {
    const parent = makeTmpParent("materialize-symlink-")
    // Real dir the symlink points at — outside the parent, so if
    // classifyTarget followed the symlink and treated its target as our
    // slot, materialization would land wherever the symlink went and would
    // trip either the containment check or clobber unrelated content.
    const linkTarget = makeTmpParent("materialize-symlink-target-")
    fs.writeFileSync(path.join(linkTarget, "user-file.txt"), "please do not touch")
    const symlinkPath = path.join(parent, "starter")
    fs.symlinkSync(linkTarget, symlinkPath)

    const result = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: SAMPLE_VERSION,
      cliVersion: CLI_VERSION,
      allowUnsafeParent: true,
    })

    // Escalated to slot 1 — symlink was classified as unknown-dir.
    expect(result.suffix).toBe(1)
    expect(result.targetPath).toBe(path.join(parent, "starter-2"))
    // Symlink itself still exists (not unlinked) and still points where it did.
    const stat = fs.lstatSync(symlinkPath)
    expect(stat.isSymbolicLink()).toBe(true)
    // What the link points at is intact.
    expect(fs.readFileSync(path.join(linkTarget, "user-file.txt"), "utf8")).toBe("please do not touch")
  })
})

/**
 * findSafeTarget bail-early behavior (codex #26). Scanning a hostile
 * parent with 10+ consecutive unrelated dirs should short-circuit to the
 * hex fallback rather than burning ~100 stat syscalls to arrive at the
 * same answer.
 */
describe("materializeSample — findSafeTarget bail-early on crowded parent", () => {
  test("11 consecutive unrelated dirs under preferred name → materializes into hex-suffixed slot", async () => {
    const parent = makeTmpParent("materialize-crowded-")
    // Seed slot 0 through slot 10 (starter, starter-2, …, starter-11) with
    // unrelated content — CONSECUTIVE_UNKNOWN_LIMIT is 10, so 11 unknowns
    // guarantees the short-circuit fires.
    fs.mkdirSync(path.join(parent, "starter"))
    fs.writeFileSync(path.join(parent, "starter", "unrelated.txt"), "x")
    for (let i = 2; i <= 11; i++) {
      const dir = path.join(parent, `starter-${i}`)
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, "unrelated.txt"), "x")
    }

    const result = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: SAMPLE_VERSION,
      cliVersion: CLI_VERSION,
      allowUnsafeParent: true,
    })

    // The scan bailed to hex — suffix is a string, not a number.
    expect(typeof result.suffix).toBe("string")
    expect(result.targetPath).toMatch(new RegExp(`starter-[0-9a-f]{6}$`))
    // Marker written to the hex-suffixed slot.
    expect(fs.existsSync(path.join(result.targetPath, MARKER_FILE_NAME))).toBe(true)
    // Unrelated content untouched.
    expect(fs.readFileSync(path.join(parent, "starter", "unrelated.txt"), "utf8")).toBe("x")
    expect(fs.readFileSync(path.join(parent, "starter-11", "unrelated.txt"), "utf8")).toBe("x")
  })
})

/**
 * Interrupt-safety: a prior killed materialize leaves a `.<name>.tmp-<hex>`
 * staging dir. The next run must (a) not classify it as unknown-dir and
 * escalate to a suffix, and (b) sweep the orphan.
 */
describe("materializeSample — orphan staging cleanup", () => {
  test("OLD .starter.tmp-* orphan (past age guard) → swept + starter/ materialized cleanly", async () => {
    const parent = makeTmpParent("materialize-orphan-")
    const orphan1 = path.join(parent, ".starter.tmp-deadbeef")
    const orphan2 = path.join(parent, ".starter.tmp-cafebabe")
    fs.mkdirSync(orphan1, { recursive: true })
    fs.writeFileSync(path.join(orphan1, "partial.txt"), "leftover from crash")
    fs.mkdirSync(orphan2, { recursive: true })
    // Backdate the orphans past the sweep age guard (default 1h). Young
    // orphans are DELIBERATELY kept to avoid nuking a live sibling's
    // staging tree — see sweepOrphanStaging comment in materialize.ts.
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    fs.utimesSync(orphan1, twoHoursAgo, twoHoursAgo)
    fs.utimesSync(orphan2, twoHoursAgo, twoHoursAgo)

    const result = await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: SAMPLE_VERSION,
      cliVersion: CLI_VERSION,
      allowUnsafeParent: true,
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

  test("YOUNG .starter.tmp-* orphan (recent — could be a live sibling) is LEFT ALONE (codex #17)", async () => {
    const parent = makeTmpParent("materialize-orphan-young-")
    const youngOrphan = path.join(parent, ".starter.tmp-freshxxxx")
    fs.mkdirSync(youngOrphan, { recursive: true })
    // No utimes backdating — modified just now, well under the 1h guard.

    await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: SAMPLE_VERSION,
      cliVersion: CLI_VERSION,
      allowUnsafeParent: true,
    })

    // Young orphan MUST still exist — the sweep is age-guarded to prevent
    // deleting a concurrent process's live staging tree.
    expect(fs.existsSync(youngOrphan)).toBe(true)
  })

  test("orphan for a DIFFERENT preferredName is left alone (different sweep prefix)", async () => {
    const parent = makeTmpParent("materialize-orphan-scoped-")
    const otherOrphan = path.join(parent, ".other-sample.tmp-abcdef")
    fs.mkdirSync(otherOrphan, { recursive: true })
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    fs.utimesSync(otherOrphan, twoHoursAgo, twoHoursAgo)

    await materializeSample({
      targetParent: parent,
      preferredTargetName: "starter",
      sampleVersion: SAMPLE_VERSION,
      cliVersion: CLI_VERSION,
      allowUnsafeParent: true,
    })

    // Only starter's orphans get swept; another sample's staging is not our
    // business — even when it's old enough that the age guard would allow
    // deletion.
    expect(fs.existsSync(otherOrphan)).toBe(true)
  })

  test("two concurrent materializeSample calls with the same preferredName → serialize under Flock, no corruption (codex #17)", async () => {
    const parent = makeTmpParent("materialize-concurrent-")
    // Kick off two concurrent materializes into the same slot. Without a
    // lock, findSafeTarget in both would see slot 0 as empty, both would
    // build staging dirs, and the second's rename would either fail with
    // ENOTEMPTY or silently clobber. With Flock, they serialize: one gets
    // slot 0 as fresh, the other sees "our-sample-current" and reuses.
    const [r1, r2] = await Promise.all([
      materializeSample({
        targetParent: parent,
        preferredTargetName: "starter",
        sampleVersion: SAMPLE_VERSION,
        cliVersion: CLI_VERSION,
      allowUnsafeParent: true,
      }),
      materializeSample({
        targetParent: parent,
        preferredTargetName: "starter",
        sampleVersion: SAMPLE_VERSION,
        cliVersion: CLI_VERSION,
      allowUnsafeParent: true,
      }),
    ])
    // Both landed at the SAME path — no suffix escalation, no split.
    expect(r1.targetPath).toBe(path.join(parent, "starter"))
    expect(r2.targetPath).toBe(path.join(parent, "starter"))
    // Exactly one wrote fresh (reused=false); the other found the sample
    // and reused it (reused=true). Order is undefined; XOR the flags.
    expect(r1.reused !== r2.reused).toBe(true)
    // The materialized dir has the marker.
    expect(fs.existsSync(path.join(r1.targetPath, MARKER_FILE_NAME))).toBe(true)
    // No stray staging left behind by either run.
    const staging = fs.readdirSync(parent).filter((n) => n.startsWith(".starter.tmp-"))
    expect(staging).toEqual([])
  })
})
