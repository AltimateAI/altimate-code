/**
 * Adversarial coverage for the v0.11.0 stable release payload (v0.10.0..HEAD).
 *
 * The 26 commits in this range already carry unusually deep dedicated test
 * suites — confirmed during the release's multi-persona review (2,204 lines
 * for packages/opencode/src/altimate/free/*, a targeted regression test for
 * the #1246 credential leak, 425 lines of install-lock concurrency tests, six
 * resolve-*.test.ts files for driver path harvesting, and an exhaustive
 * describeRateLimit/describeRequestTooLarge suite in
 * test/altimate/altimate-base-rate-limit-messages.test.ts). This file does
 * NOT re-cover any of that ground. It adds two genuinely untested boundary
 * classes that the release review's End User and Tech Lead personas flagged
 * as risk areas but that no existing file exercises:
 *
 *   1. Symlinked store paths for the #1204 "populated store reads as empty"
 *      fix (packages/drivers/src/file-store.ts's assertStoreExists /
 *      rejectIfDirectory). Every existing test in file-store-guard.test.ts
 *      uses a plain path; none go through a symlink. fs.existsSync/statSync
 *      follow symlinks by default, so this is expected to already be
 *      correct — these tests PIN that behavior rather than allege a bug.
 *
 *   2. Adversarial content in the free-tier gateway's own error text
 *      (packages/opencode/src/altimate/free/client.ts's describeRateLimit /
 *      describeRequestTooLarge) — control characters, absurd numeric
 *      strings, and oversized detail text embedded in a gateway response.
 *      The existing rate-limit-messages suite covers every real ChatMode
 *      shape and several pure-function edge cases, but not what happens when
 *      the numeric fields those parsers extract are adversarial rather than
 *      merely absent or malformed.
 */
import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { assertStoreExists } from "../../../drivers/src/file-store"
import { FreeTier } from "../../src/altimate/free/client"

const tmpDirs: string[] = []
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-v0.11.0-adversarial-"))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe("assertStoreExists — symlinked store paths (#1204 boundary, not covered by file-store-guard.test.ts)", () => {
  test("a symlink to an existing file is treated as existing (fs.existsSync follows it)", () => {
    const dir = tmp()
    const real = path.join(dir, "real.duckdb")
    fs.writeFileSync(real, "")
    const link = path.join(dir, "link.duckdb")
    fs.symlinkSync(real, link)
    expect(() => assertStoreExists({ type: "duckdb" }, link, "DuckDB")).not.toThrow()
  })

  test("a dangling symlink is treated as missing — never silently opened as a new empty store", () => {
    const dir = tmp()
    const link = path.join(dir, "dangling.duckdb")
    fs.symlinkSync(path.join(dir, "does-not-exist.duckdb"), link)
    expect(() => assertStoreExists({ type: "duckdb" }, link, "DuckDB")).toThrow(/database file not found/)
  })

  test("a symlink to a directory is rejected as a directory, not silently treated as a missing file", () => {
    const dir = tmp()
    const realDir = path.join(dir, "realdir")
    fs.mkdirSync(realDir)
    const link = path.join(dir, "dirlink.duckdb")
    fs.symlinkSync(realDir, link)
    expect(() => assertStoreExists({ type: "duckdb" }, link, "DuckDB")).toThrow(/is a directory, not a file/)
  })

  test("a symlink to a directory is rejected even with create: true — the directory check runs before the create bypass", () => {
    const dir = tmp()
    const realDir = path.join(dir, "realdir2")
    fs.mkdirSync(realDir)
    const link = path.join(dir, "dirlink2.duckdb")
    fs.symlinkSync(realDir, link)
    expect(() => assertStoreExists({ type: "duckdb", create: true }, link, "DuckDB", true)).toThrow(
      /is a directory, not a file/,
    )
  })

  test("a broken symlink chain (link to a link to nothing) is still treated as missing, not crashed on", () => {
    const dir = tmp()
    const linkA = path.join(dir, "a.duckdb")
    const linkB = path.join(dir, "b.duckdb")
    fs.symlinkSync(path.join(dir, "nowhere.duckdb"), linkA)
    fs.symlinkSync(linkA, linkB)
    expect(() => assertStoreExists({ type: "duckdb" }, linkB, "DuckDB")).toThrow(/database file not found/)
  })
})

describe("describeRateLimit — adversarial retryAfter values (beyond the 45.7 / 0 / absent shapes already covered)", () => {
  const throttleBody = JSON.stringify({ error: { type: "throttling_error", message: "burst limit" } })

  test("a retryAfter far beyond any plausible wait still renders without NaN/Infinity", () => {
    const described = FreeTier.describeRateLimit({ body: throttleBody, retryAfter: "99999999999999" })
    expect(described?.message).not.toContain("NaN")
    expect(described?.message).not.toContain("Infinity")
    expect(described?.message).toBe("Too many requests to Altimate Base right now. Try again in 99999999999999s.")
  })

  test("a scientific-notation retryAfter is parsed by Number() and rendered, not rejected", () => {
    const described = FreeTier.describeRateLimit({ body: throttleBody, retryAfter: "4.5e1" })
    expect(described?.message).toBe("Too many requests to Altimate Base right now. Try again in 45s.")
  })

  test("a non-numeric retryAfter (Number() -> NaN) falls back to 'shortly', never renders the literal string", () => {
    for (const garbage of ["soon", "5 seconds", "Infinity", "-Infinity", "1,000", ""]) {
      const described = FreeTier.describeRateLimit({ body: throttleBody, retryAfter: garbage })
      expect(described?.message).toBe("Too many requests to Altimate Base right now. Try again shortly.")
    }
  })

  test("a negative-but-not-zero retryAfter is treated as absent (not > 0), falls back to 'shortly'", () => {
    const described = FreeTier.describeRateLimit({ body: throttleBody, retryAfter: "-45" })
    expect(described?.message).toBe("Too many requests to Altimate Base right now. Try again shortly.")
  })

  test("control characters and a null byte inside the throttle detail do not crash the token-limit substring check", () => {
    const body = JSON.stringify({
      error: { type: "throttling_error", message: "Limit type: tokens\x00\x07, quota exceeded" },
    })
    const described = FreeTier.describeRateLimit({ body })
    expect(described).toEqual({
      message:
        "This request is too large for Altimate Base's per-minute token limit. Start a new session or shorten the context, then try again.",
      retryable: false,
    })
  })

  test("an extremely long detail string (10KB) is handled without throwing or truncation artifacts in the match", () => {
    const padding = "x".repeat(10_000)
    const body = JSON.stringify({ error: { type: "throttling_error", message: `${padding} Limit type: tokens` } })
    expect(() => FreeTier.describeRateLimit({ body })).not.toThrow()
    const described = FreeTier.describeRateLimit({ body })
    expect(described?.retryable).toBe(false)
  })

  test("budget detail containing HTML/script-like content is never echoed into the returned message", () => {
    const body = JSON.stringify({
      error: { type: "budget_exceeded", message: '<script>alert(1)</script> ExceededBudget: User=<img src=x>' },
    })
    const described = FreeTier.describeRateLimit({ body })
    expect(described?.message).toBe(
      "You've used today's free Altimate Base allowance. It resets tomorrow—switch models to keep going.",
    )
    expect(described?.message).not.toContain("<script>")
    expect(described?.message).not.toContain("<img")
  })
})

describe("describeRequestTooLarge — adversarial numeric content in the byte-count message", () => {
  test("byte counts at Number.MAX_SAFE_INTEGER scale render without Infinity/NaN in the KB parenthetical", () => {
    const body = JSON.stringify({
      error: {
        code: "request_too_large",
        message: `Request is ${Number.MAX_SAFE_INTEGER} bytes; the free tier limit is ${Number.MAX_SAFE_INTEGER} bytes.`,
      },
    })
    const described = FreeTier.describeRequestTooLarge({ status: 413, body })
    expect(described).not.toContain("NaN")
    expect(described).not.toContain("Infinity")
    expect(described).toContain("KB against a")
  })

  test("a zero-byte limit (degenerate gateway config) renders 0KB rather than dividing into NaN", () => {
    const body = JSON.stringify({
      error: { code: "request_too_large", message: "Request is 1000 bytes; the free tier limit is 0 bytes." },
    })
    const described = FreeTier.describeRequestTooLarge({ status: 413, body })
    expect(described).toContain("0KB limit")
    expect(described).not.toContain("NaN")
  })

  test("control characters embedded in the message do not break the byte-count regex match or crash", () => {
    const body = JSON.stringify({
      error: {
        code: "request_too_large",
        message: "Request is 179608 bytes;\x00\x1b[31m the free tier limit is 128000 bytes.",
      },
    })
    expect(() => FreeTier.describeRequestTooLarge({ status: 413, body })).not.toThrow()
    // The control characters break the exact regex match (by design — the regex requires the
    // literal "; the free tier limit is" substring), so this falls back to the generic message
    // rather than fabricating numbers from a mangled match. Pinning that fallback, not a crash.
    expect(FreeTier.describeRequestTooLarge({ status: 413, body })).toBe(
      "This request is too large for Altimate Base. Start a new session, or switch to another model for this task.",
    )
  })

  test("a deeply nested provider_specific_fields.error with prototype-pollution-shaped keys is inert", () => {
    // Built as a raw JSON string, not a JS object literal: `{ __proto__: ... }` as a literal sets the
    // prototype and is dropped by JSON.stringify, which would make this payload never actually contain
    // "__proto__" and the test would pass regardless of whether the code under test guards against it.
    // JSON.parse has no such special-casing — it creates a genuine own "__proto__" property — so a raw
    // string is what an actual adversarial gateway response looks like on the wire.
    const body =
      '{"error":{"code":"request_too_large","__proto__":{"polluted":true},' +
      '"provider_specific_fields":{"error":{"code":"request_too_large","__proto__":{"polluted":true}}}}}'
    expect(() => FreeTier.describeRequestTooLarge({ status: 413, body })).not.toThrow()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("a non-string, numeric JSON message field is ignored rather than coerced into the byte-count text", () => {
    const body = JSON.stringify({ error: { code: "request_too_large", message: 12345 } })
    expect(FreeTier.describeRequestTooLarge({ status: 413, body })).toBe(
      "This request is too large for Altimate Base. Start a new session, or switch to another model for this task.",
    )
  })
})
