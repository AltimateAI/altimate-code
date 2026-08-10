/**
 * Adversarial tests for the v0.9.5 release surface.
 *
 * Covers the 8 upstream commits (`#1049`, `#1063`, `#1064`, `#1067`, `#1068`,
 * `#1069`+`#1071`, `#1074`, `#1078`) plus the 6 pre-release review-fix commits
 * that landed via PR #1086. The per-surface unit tests
 * (`test/telemetry/*`, `test/altimate/sample-setup-helpers.test.ts`) hit the
 * happy path and the documented failure modes; this file layers boundary /
 * injection / type-confusion / oversized-input cases on top so the FINAL
 * shipped code — not just what the unit tests exercised — is what gets tagged.
 *
 * Every assertion is deterministic — no timing dependencies, no shared state,
 * no `mock.module()`. Real helpers, real fs where needed, real
 * `process.env` mutation with snapshot/restore.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Flag } from "../../src/flag/flag"
import { Telemetry } from "../../src/altimate/telemetry"
import * as OnboardingTelemetry from "../../src/altimate/telemetry/onboarding"
import { redactPaths, countSampleContents } from "../../src/altimate/tools/sample-setup"
import { buildCliContext, buildAuthorizeUrl } from "../../src/altimate/plugin/altimate"

// -----------------------------------------------------------------------------
// 1. Telemetry opt-out — `Flag.truthyEnv` on hostile / oversized env values
// -----------------------------------------------------------------------------

describe("v0.9.5 — Flag.truthyEnv adversarial", () => {
  // Kilo review on PR #1088: env-var snapshot/restore hooks were previously
  // file-scoped, so they ran for every test in this file even though only the
  // tests in this describe block ever touch `ALTIMATE_TELEMETRY_DISABLED`.
  // Scoping them here matches usage.
  const OPT_OUT_VAR = "ALTIMATE_TELEMETRY_DISABLED"
  let optOutSnapshot: string | undefined
  beforeEach(() => {
    optOutSnapshot = process.env[OPT_OUT_VAR]
  })
  afterEach(() => {
    if (optOutSnapshot === undefined) delete process.env[OPT_OUT_VAR]
    else process.env[OPT_OUT_VAR] = optOutSnapshot
  })

  test("very long value (32KB) — must not enable, must not throw", () => {
    // A 32KB env value should be rejected as a non-truthy string, not crash the
    // parser. Real users don't hit this, but a shell injection into the env
    // could.
    process.env[OPT_OUT_VAR] = "x".repeat(32 * 1024)
    expect(Flag.truthyEnv(OPT_OUT_VAR)).toBe(false)
  })

  test("value with embedded null byte — must not enable", () => {
    process.env[OPT_OUT_VAR] = "true\x00"
    // JS's `===` doesn't treat "true\0" as "true", so this rejects — asserting
    // that the parser doesn't stringify-and-substring-check.
    expect(Flag.truthyEnv(OPT_OUT_VAR)).toBe(false)
  })

  test("value with leading/trailing whitespace — rejected (no trimming)", () => {
    // Documented semantic — matches the existing `truthy()` behaviour. If a
    // future edit adds trim(), this test flips and the reviewer must decide
    // whether that's intentional.
    process.env[OPT_OUT_VAR] = "\ttrue\n"
    expect(Flag.truthyEnv(OPT_OUT_VAR)).toBe(false)
  })

  test("unknown env var name — always false, never crash on missing key", () => {
    expect(Flag.truthyEnv("SOME_TOTALLY_UNSET_VAR_" + "A".repeat(50))).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// 2. `Telemetry.classifyProvider` — hostile ids + prototype defense stress
// -----------------------------------------------------------------------------

describe("v0.9.5 — Telemetry.classifyProvider adversarial", () => {
  test("very long providerID (10K chars) — 'other', no id leaked, no throw", () => {
    const huge = "z".repeat(10_000)
    const r = Telemetry.classifyProvider(huge)
    expect(r.provider).toBe("other")
    expect(r.provider_id).toBeUndefined()
  })

  test("providerID with embedded null byte — 'other', id dropped", () => {
    const r = Telemetry.classifyProvider("anthropic\x00injected")
    expect(r.provider).toBe("other")
    expect(r.provider_id).toBeUndefined()
  })

  test("providerID with newlines and control characters — 'other', id dropped", () => {
    const r = Telemetry.classifyProvider("anthropic\n\r\tinjected")
    expect(r.provider).toBe("other")
    expect(r.provider_id).toBeUndefined()
  })

  test("providerID that is a JSON stringification of an object — 'other'", () => {
    const r = Telemetry.classifyProvider('{"provider":"anthropic"}')
    expect(r.provider).toBe("other")
    expect(r.provider_id).toBeUndefined()
  })

  test("__proto__ / prototype as providerID — must NOT poison and must NOT enum", () => {
    for (const key of ["__proto__", "prototype", "hasOwnProperty", "isPrototypeOf"]) {
      const r = Telemetry.classifyProvider(key)
      expect(r.provider).toBe("other")
    }
    // Sanity: prototype pollution attempt at this call site didn't extend Object.
    // If CURATED_PROVIDER_ENUM were a plain object and a caller managed to write
    // to it, unrelated code paths could leak an inherited property here.
    expect(({} as any).polluted).toBeUndefined()
  })

  test("modelID with unusual types (empty string, whitespace, unicode) — no big_pickle unless exact", () => {
    // Contract: `big_pickle` only fires on the exact pair ("opencode","big-pickle").
    // Anything else on the opencode provider must fall through to "other" with the id kept.
    for (const modelID of ["", "  big-pickle  ", "BIG-PICKLE", "big-pickle​" /* zero-width */]) {
      const r = Telemetry.classifyProvider("opencode", modelID)
      expect(r.provider).toBe("other")
      expect(r.provider_id).toBe("opencode")
    }
  })
})

// -----------------------------------------------------------------------------
// 3. `OnboardingTelemetry.claimEnvironmentScan` — hostile sessionIDs
// -----------------------------------------------------------------------------

describe("v0.9.5 — OnboardingTelemetry claim adversarial", () => {
  beforeEach(() => OnboardingTelemetry.resetForTest())
  afterEach(() => OnboardingTelemetry.resetForTest())

  test("empty-string sessionID — treated as its own session", () => {
    // Not a user-reachable shape (SessionPrompt always synthesizes an id) but
    // the helper must not crash and must remain idempotent for whatever key it
    // receives.
    expect(OnboardingTelemetry.claimEnvironmentScan("")).toBe(true)
    expect(OnboardingTelemetry.claimEnvironmentScan("")).toBe(false)
  })

  test("very long sessionID (10K chars) — one claim, then locked", () => {
    const huge = "s".repeat(10_000)
    expect(OnboardingTelemetry.claimEnvironmentScan(huge)).toBe(true)
    expect(OnboardingTelemetry.claimEnvironmentScan(huge)).toBe(false)
  })

  test("sessionID with special characters — treated as distinct keys", () => {
    const a = "sess/../etc/passwd"
    const b = "sess'; DROP TABLE users;--"
    const c = "sess\x00null"
    for (const s of [a, b, c]) {
      expect(OnboardingTelemetry.claimEnvironmentScan(s)).toBe(true)
      expect(OnboardingTelemetry.claimEnvironmentScan(s)).toBe(false)
    }
  })

  test("isOnboardingSession stays false for a session that only claimed (no markOnboardingSession)", () => {
    // The composed gate (`isOnboardingSession && claim`) at project-scan.ts:952
    // relies on markOnboardingSession being called separately. A session that
    // only ever hit `claim()` must NOT be reported as onboarding — that would
    // silently promote random /discover calls to funnel events.
    OnboardingTelemetry.claimEnvironmentScan("random-session")
    expect(OnboardingTelemetry.isOnboardingSession("random-session")).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// 4. `redactPaths` / `countSampleContents` — oversize / metachar / hostile fs
// -----------------------------------------------------------------------------

describe("v0.9.5 — sample-setup helpers adversarial", () => {
  test("redactPaths handles empty message without throwing", () => {
    expect(redactPaths("")).toBe("")
  })

  test("redactPaths handles a 100KB message without leaking paths or degenerating markers", () => {
    // Coderabbit review on PR #1088: previous version used `repeat(1000)` which is
    // ~20 KB not 100 KB, and a `performance.now()` wall-clock assertion which is
    // flaky under host load / parallel test runners. Build exactly 100,000 chars
    // deterministically and assert only the redaction shape.
    const segment = "normal text here /Users/alice/x/y/z "
    const msg = segment.repeat(Math.ceil(100_000 / segment.length)).slice(0, 100_000)
    const out = redactPaths(msg)
    expect(out).not.toContain("/Users/alice")
    // Should not have degenerated to `<path><path><path>...`
    expect(out).not.toMatch(/<path><path>/)
  })

  test("redactPaths accepts extras containing regex metacharacters (treated as literal via split)", () => {
    // The known-value pass uses `split(known).join("<path>")`, which is a literal
    // substring split — regex metachars in `known` don't have any special meaning.
    // A future rewrite that regressed to `.replace(new RegExp(known), ...)` would
    // either crash on the unclosed `[` or match wildly. This test locks the
    // literal-split semantics in.
    const out = redactPaths("failed at /tmp/checkout-.+*[xyz", ["/tmp/checkout-.+*[xyz"])
    expect(out).toBe("failed at <path>")
  })

  test("redactPaths does not leak the marker back if a user's error text already contains '<path>'", () => {
    // If the input already contained `<path>` as literal user text, the collapse
    // step could double-eat surrounding characters. Assert the marker is
    // preserved as-is when it's not adjacent to another marker.
    const out = redactPaths("caller received sentinel <path> from upstream")
    expect(out).toContain("<path>")
    expect(out).toContain("sentinel")
    expect(out).toContain("upstream")
  })

  test("countSampleContents on a symlink loop returns 0 rather than crashing", () => {
    // fs.readdirSync follows the surface entries but doesn't recurse into loops
    // in this helper (countFilesWithExtension only recurses via `isDirectory()`
    // on the entry itself). The loop link itself does not resolve to a
    // directory here, so it's counted as a file (and skipped by the .sql / .csv
    // extension filter). Still: the important adversarial guarantee is "does
    // not blow up".
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "v095-adversarial-symlink-"))
    try {
      fs.mkdirSync(path.join(root, "models"))
      // Create a symlink pointing back to models — a real loop.
      // Coderabbit review on PR #1088: bare `catch` used to swallow every symlink
      // setup failure into a passing test, and `toBeGreaterThanOrEqual(0)` was
      // trivially true for any non-negative count. Narrow the skip to the one
      // known-unsupported-symlink error class (EPERM on Windows without
      // dev-mode); re-throw anything else so a real filesystem regression
      // doesn't hide behind the skip. Assert exact `models === 0` — the loop
      // link resolves to a directory but has no `.sql` inside; anything nonzero
      // would mean the helper is following the loop.
      try {
        fs.symlinkSync(path.join(root, "models"), path.join(root, "models", "loop"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return
        throw error
      }
      const counts = countSampleContents(root)
      expect(counts.models).toBe(0)
      expect(counts.tables).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// -----------------------------------------------------------------------------
// 5. `buildCliContext` / `buildAuthorizeUrl` — cli_context URL fragment
// -----------------------------------------------------------------------------

describe("v0.9.5 — cli_context builder adversarial", () => {
  test("buildCliContext produces valid base64url that decodes to v=1 payload", async () => {
    // Machine-id file lives at ~/.altimate/machine-id in the runtime path;
    // point at a tmpfile so the runner's real state is untouched.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v095-adversarial-mid-"))
    try {
      const midPath = path.join(tmp, "machine-id")
      const encoded = await buildCliContext(midPath)
      // base64url characters only — no `+`, `/`, `=`.
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
      const decoded = Buffer.from(encoded, "base64url").toString("utf8")
      const payload = JSON.parse(decoded)
      expect(payload.v).toBe(1)
      expect(typeof payload.cli_version).toBe("string")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("buildAuthorizeUrl encodes redirect and state (no naked control chars)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v095-adversarial-authurl-"))
    try {
      const midPath = path.join(tmp, "machine-id")
      const hostile = "https://evil.example/callback?a=1&b=2#frag"
      const url = await buildAuthorizeUrl(
        "https://app.example.com",
        hostile,
        "state\nvalue\twith\tspecials",
        midPath,
      )
      // No literal newline / tab / naked `#` in the query-param portion.
      // (Fragment starts with `#cli_context=...` — that's the only allowed `#`.)
      const [queryPortion] = url.split("#")
      expect(queryPortion).not.toContain("\n")
      expect(queryPortion).not.toContain("\t")
      // Fragment is present and comes last.
      expect(url).toContain("#cli_context=")
      expect(url.indexOf("#cli_context=")).toBe(url.lastIndexOf("#"))
      // The redirect param carries the encoded form, not the raw URL —
      // an escaped `#` (%23) must be present, not a naked one.
      expect(url).toContain("redirect=" + encodeURIComponent(hostile))
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("buildCliContext returns valid payload even when machine-id path is unreadable", async () => {
    // Point at a directory (not a file) — the machine-id read/write should
    // fail internally, but the builder should still return a valid payload
    // WITHOUT machine_id rather than throw.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v095-adversarial-badmid-"))
    try {
      const encoded = await buildCliContext(tmp) // tmp is a dir, not a file
      const decoded = Buffer.from(encoded, "base64url").toString("utf8")
      const payload = JSON.parse(decoded)
      expect(payload.v).toBe(1)
      // machine_id must NOT be present when it can't be read/minted.
      // (`buildCliContext` uses `if (machineId) ctx.machine_id = machineId`.)
      expect(payload.machine_id).toBeUndefined()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
