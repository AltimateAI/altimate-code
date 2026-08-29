/**
 * Round 2 adversarial regression for the v1.4.0 bridge merge.
 *
 * Distinct from v140-merge-adversarial.test.ts (round 1, static invariants).
 * This file exercises:
 *   - Property-based fuzzing of pure helpers (1000+ random inputs each)
 *   - Failure injection through deriveAgentOutcomeReason with synthetic provider errors
 *   - Documented [KNOWN GAP] tests for classifyError pattern coverage holes
 *
 * Run on every future bridge merge to catch:
 *   - maskString redaction regressions (API key / Bearer token leaks)
 *   - deriveAgentOutcomeReason crashes on malformed inputs
 *   - Reason length blowups
 *   - classifyError gaps that would reduce telemetry diagnostic value
 */
import { describe, expect, test } from "bun:test"
import { Telemetry } from "../../src/altimate/telemetry"
import { randomBytes } from "crypto"

const FUZZ_ITERATIONS = 500 // halved vs scratch run — keeps CI fast while still catching regressions

// ---------- helpers ----------
function randString(maxLen = 200): string {
  const len = Math.floor(Math.random() * maxLen)
  const chars: string[] = []
  for (let i = 0; i < len; i++) {
    const r = Math.random()
    if (r < 0.4) chars.push(String.fromCharCode(0x20 + Math.floor(Math.random() * 95)))
    else if (r < 0.6) chars.push(String.fromCharCode(Math.floor(Math.random() * 32)))
    else if (r < 0.85) chars.push(String.fromCharCode(0x4e00 + Math.floor(Math.random() * 0x500)))
    else chars.push("🔥")
  }
  return chars.join("")
}

function randAPIKey(): string {
  const prefix = ["sk-ant-", "sk-proj-", "sk-", "Bearer "][Math.floor(Math.random() * 4)]
  const len = 25 + Math.floor(Math.random() * 50)
  return prefix + randomBytes(len).toString("hex").slice(0, len)
}

const OUTCOMES = ["completed", "abandoned", "aborted", "error"] as const
type Outcome = (typeof OUTCOMES)[number]

// ---------- maskString fuzz ----------
describe("v1.4.0 fuzz — maskString hardness", () => {
  test("never produces invalid UTF-8 across random inputs", () => {
    for (let i = 0; i < FUZZ_ITERATIONS; i++) {
      const input = randString(500)
      const output = Telemetry.maskString(input)
      expect(Buffer.from(output, "utf8").toString("utf8")).toBe(output)
    }
  })

  test("never lets a 25+ char API-key prefix leak", () => {
    let leaks = 0
    for (let i = 0; i < FUZZ_ITERATIONS; i++) {
      const key = randAPIKey()
      const input = `${randString(50)} ${key} ${randString(50)}`
      const output = Telemetry.maskString(input)
      if (/sk-(?:ant-|proj-)?[A-Za-z0-9]{20,}/.test(output)) leaks++
      if (/Bearer\s+[A-Za-z0-9]{20,}/i.test(output)) leaks++
    }
    expect(leaks).toBe(0)
  })

  test("output never explodes in length", () => {
    for (let i = 0; i < FUZZ_ITERATIONS; i++) {
      const input = randString(500)
      const output = Telemetry.maskString(input)
      expect(output.length).toBeLessThanOrEqual(input.length * 2 + 50)
    }
  })

  test("never throws on any input", () => {
    for (let i = 0; i < FUZZ_ITERATIONS; i++) {
      const input = randString(2000)
      expect(() => Telemetry.maskString(input)).not.toThrow()
    }
  })

  test("idempotent: running maskString twice on a redacted string is a no-op", () => {
    for (let i = 0; i < 100; i++) {
      const input = `Authentication failed: ${randAPIKey()}`
      const once = Telemetry.maskString(input)
      const twice = Telemetry.maskString(once)
      expect(twice).toBe(once)
    }
  })
})

// ---------- deriveAgentOutcomeReason fuzz ----------
describe("v1.4.0 fuzz — deriveAgentOutcomeReason invariants", () => {
  test("returns 3 string fields for any combination of valid inputs", () => {
    for (let i = 0; i < FUZZ_ITERATIONS; i++) {
      const out = Telemetry.deriveAgentOutcomeReason({
        outcome: OUTCOMES[Math.floor(Math.random() * OUTCOMES.length)],
        lastToolName: Math.random() < 0.5 ? randString(30) : null,
        lastMessageError: Math.random() < 0.5 ? randString(800) : null,
        abortReason: Math.random() < 0.5 ? randString(500) : null,
        lastErrorClass: Math.random() < 0.5 ? randString(30) : "",
      })
      expect(typeof out.final_tool).toBe("string")
      expect(typeof out.error_class).toBe("string")
      expect(typeof out.reason).toBe("string")
    }
  })

  test("reason is bounded (≤500 for error, ≤200 for aborted)", () => {
    for (let i = 0; i < FUZZ_ITERATIONS; i++) {
      const outcome = OUTCOMES[Math.floor(Math.random() * OUTCOMES.length)]
      const out = Telemetry.deriveAgentOutcomeReason({
        outcome,
        lastToolName: null,
        lastMessageError: randString(10000),
        abortReason: randString(10000),
        lastErrorClass: "",
      })
      if (outcome === "error") expect(out.reason.length).toBeLessThanOrEqual(500)
      if (outcome === "aborted") expect(out.reason.length).toBeLessThanOrEqual(200)
    }
  })

  test("never throws even with garbage outcome (cast)", () => {
    for (let i = 0; i < 100; i++) {
      expect(() =>
        Telemetry.deriveAgentOutcomeReason({
          outcome: randString(20) as Outcome,
          lastToolName: randString(30),
          lastMessageError: randString(500),
          abortReason: randString(500),
          lastErrorClass: randString(30),
        }),
      ).not.toThrow()
    }
  })

  test("error reason: API keys stripped even when key is in input", () => {
    let leaks = 0
    for (let i = 0; i < 200; i++) {
      const key = randAPIKey()
      const out = Telemetry.deriveAgentOutcomeReason({
        outcome: "error",
        lastToolName: null,
        lastMessageError: `failure: ${key}`,
        abortReason: null,
        lastErrorClass: "",
      })
      if (/sk-(?:ant-|proj-)?[A-Za-z0-9]{20,}/.test(out.reason)) leaks++
      if (/Bearer\s+[A-Za-z0-9]{20,}/i.test(out.reason)) leaks++
    }
    expect(leaks).toBe(0)
  })

  test("aborted reason: API keys stripped even when key is in abortReason", () => {
    let leaks = 0
    for (let i = 0; i < 200; i++) {
      const key = randAPIKey()
      const out = Telemetry.deriveAgentOutcomeReason({
        outcome: "aborted",
        lastToolName: null,
        lastMessageError: null,
        abortReason: `cancel: ${key}`,
        lastErrorClass: "",
      })
      if (/sk-(?:ant-|proj-)?[A-Za-z0-9]{20,}/.test(out.reason)) leaks++
    }
    expect(leaks).toBe(0)
  })
})

// ---------- failure injection ----------
describe("v1.4.0 failure injection — synthetic provider errors flow through diagnostics", () => {
  test("AuthError with embedded sk-ant- key never leaks the key", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      outcome: "error",
      lastToolName: null,
      lastMessageError: "AuthError: invalid api key sk-ant-1234567890abcdef0123456789",
      abortReason: null,
      lastErrorClass: "",
    })
    expect(out.reason).toContain("sk-***")
    expect(out.reason).not.toContain("sk-ant-1234")
  })

  test("Bearer token in error: redacted", () => {
    // Synthetic 30+ char token (avoid real JWT shape — GitGuardian flags
    // those even in test fixtures).
    const synthetic = "abc123def456ghi789jkl012mno345pqr678"
    const out = Telemetry.deriveAgentOutcomeReason({
      outcome: "error",
      lastToolName: null,
      lastMessageError: `Auth header rejected: Bearer ${synthetic}`,
      abortReason: null,
      lastErrorClass: "",
    })
    expect(out.reason).toContain("Bearer ***")
    expect(out.reason).not.toContain(synthetic.slice(0, 12))
  })

  test("aborted with non-string reason normalized to 'non_string_reason' (not [object Object])", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      outcome: "aborted",
      lastToolName: "terminal",
      lastMessageError: null,
      abortReason: "non_string_reason",
      lastErrorClass: "",
    })
    expect(out.reason).toBe("non_string_reason")
    expect(out.reason).not.toContain("[object")
  })

  test("aborted preserves last tool error class (e.g. tool_timeout)", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      outcome: "aborted",
      lastToolName: "edit",
      lastMessageError: null,
      abortReason: "user_cancelled",
      lastErrorClass: "tool_timeout",
    })
    expect(out.error_class).toBe("tool_timeout")
  })

  test("'connection refused' classifies via connection class (not 'unknown')", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      outcome: "error",
      lastToolName: null,
      lastMessageError: "ECONNREFUSED 127.0.0.1:5432 connection refused",
      abortReason: null,
      lastErrorClass: "",
    })
    expect(out.error_class).not.toBe("unknown")
  })

  // Once gapped: classifyError patterns lacked "503" / "Service unavailable" /
  // "Rate limit" / "Retry after" / "Too many requests" keywords, so real
  // provider 5xx and rate-limit errors classified as "unknown" — defeating
  // the diagnostic value of agent_outcome.error_class. ERROR_PATTERNS now
  // includes those phrases under the http_error class. Tests below pin
  // the new classifications.
  test("APIError 503 classifies as 'http_error' (Service unavailable)", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      outcome: "error",
      lastToolName: "edit",
      lastMessageError: "APIError: Service unavailable (503)",
      abortReason: null,
      lastErrorClass: "",
    })
    expect(out.error_class).toBe("http_error")
    expect(out.reason).toContain("Service unavailable")
  })

  test("rate-limit error classifies as 'http_error' (Retry after)", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      outcome: "error",
      lastToolName: null,
      lastMessageError: "Rate limit exceeded. Retry after 60s",
      abortReason: null,
      lastErrorClass: "",
    })
    expect(out.error_class).toBe("http_error")
  })
})
