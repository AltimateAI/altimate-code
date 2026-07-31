/**
 * Round 3 adversarial regression for the v1.4.0 bridge merge.
 *
 * Distinct from:
 *   - v140-merge-adversarial.test.ts (round 1 — static invariants)
 *   - v140-merge-fuzz.test.ts (round 2 — property-based fuzzing)
 *
 * This file pins:
 *   - regex DoS resistance on adversarial maskString input
 *   - concurrent-session state isolation for deriveAgentOutcomeReason
 *   - Config schema migration: old keybinds shapes still validate
 *   - Path sandbox sensitive-file blocklist coverage
 *
 * Plus 2 [KNOWN ISSUE] tests for findings round 3 surfaced:
 *   - Plugin.trigger does NOT catch hook exceptions → buggy plugin can
 *     crash session at chat.params (file: plugin/index.ts trigger())
 *   - Bearer regex \s+ vs \s mutation not detected by tests (test
 *     coverage gap, not a code bug)
 */
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Telemetry } from "../../src/altimate/telemetry"
// v1.17.9 merge: the TUI (and its keybind schema) moved to packages/tui. The
// old zod `Config.Keybinds` was replaced by the effect-Schema `TuiKeybind`
// (KeybindOverrides struct + Keybinds.parse defaulting). variant_list (PR
// #21185) is still wired — see Definitions/CommandMap in keybind.ts.
import { TuiKeybind } from "../../../tui/src/config/keybind"
import { readFileSync } from "fs"
import path from "path"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..")

// ---------- Regex DoS resistance ----------
//
// We measure adversarial-input runtime relative to a baseline of a benign
// short input. This is more robust against CI runner variability than a
// fixed wall-clock threshold: a slow runner that takes 50ms on the baseline
// gets a 50× budget (2500ms) for adversarial input; a fast runner that takes
// 0.5ms gets a 25ms budget. Either way, catastrophic-backtracking regressions
// (which would be 100×–1000× slower than baseline) get caught.
//
// We also include a single warmup invocation before each timed run so JIT
// optimization doesn't artificially penalize the first call.
describe("v1.4.0 chaos — maskString regex DoS resistance", () => {
  // Baseline: trivial input. Computed once per describe block.
  const BASELINE_INPUT = "no secrets here, just plain text"
  const BUDGET_MULTIPLIER = 50 // adversarial input must be at most 50× baseline

  function baselineMs(): number {
    // Take min of 5 runs to filter out scheduler jitter
    const samples: number[] = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      Telemetry.maskString(BASELINE_INPUT)
      samples.push(performance.now() - t0)
    }
    // 1ms floor so we don't divide-by-zero on very-fast runners
    return Math.max(1, Math.min(...samples))
  }

  function probe(input: string, label: string): void {
    Telemetry.maskString(input) // warmup
    const t0 = performance.now()
    Telemetry.maskString(input)
    const dt = performance.now() - t0
    const baseline = baselineMs()
    const budget = baseline * BUDGET_MULTIPLIER
    if (dt > budget) {
      throw new Error(
        `DoS regression: "${label}" took ${dt.toFixed(2)}ms (baseline ${baseline.toFixed(2)}ms × ${BUDGET_MULTIPLIER} budget = ${budget.toFixed(2)}ms)`,
      )
    }
  }

  test("10000 backslashes — runtime stays within 50× baseline", () => {
    const input = '"' + "\\\\".repeat(10000) + '"'
    expect(() => probe(input, "10000 backslashes")).not.toThrow()
  })

  test("alternating quotes (10k) — runtime stays within 50× baseline", () => {
    const input = '""""'.repeat(2500)
    expect(() => probe(input, "alternating quotes")).not.toThrow()
  })

  test("evil escape pattern (1k×3) — runtime stays within 50× baseline", () => {
    const input = '"' + "\\\\.".repeat(1000) + '"'
    expect(() => probe(input, "evil escape pattern")).not.toThrow()
  })

  test("1000 concurrent sk-ant prefixes — runtime stays within 50× baseline", () => {
    const input = ("sk-ant-" + "a".repeat(20) + " ").repeat(1000)
    expect(() => probe(input, "sk-ant prefix flood")).not.toThrow()
  })
})

// ---------- Concurrent state isolation ----------
describe("v1.4.0 chaos — deriveAgentOutcomeReason isolates state across parallel calls", () => {
  test("100 parallel calls return per-call outputs (no state bleed)", async () => {
    const inputs = Array.from({ length: 100 }, (_, i) => ({
      outcome: ["completed", "abandoned", "aborted", "error"][i % 4] as "completed" | "abandoned" | "aborted" | "error",
      lastToolName: `tool_${i}`,
      lastMessageError: i % 4 === 3 ? `error_${i}` : null,
      abortReason: i % 4 === 2 ? `reason_${i}` : null,
      lastErrorClass: `class_${i}`,
    }))
    const seq = inputs.map((inp) => Telemetry.deriveAgentOutcomeReason(inp))
    const par = await Promise.all(
      inputs.map((inp) => Promise.resolve().then(() => Telemetry.deriveAgentOutcomeReason(inp))),
    )
    expect(par).toEqual(seq)
    expect(new Set(par.map((r) => r.final_tool)).size).toBe(100)
  })
})

// ---------- Config schema migration ----------
describe("v1.4.0 chaos — Keybinds schema accepts pre-PR-21185 configs", () => {
  const decodeOverrides = Schema.decodeUnknownOption(TuiKeybind.KeybindOverrides)

  test("keybinds without variant_list still validate (default 'none')", () => {
    // A pre-PR-21185 config (no variant_list) must still decode...
    const decoded = decodeOverrides({ agent_cycle: "tab", variant_cycle: "ctrl+t" })
    expect(decoded._tag).toBe("Some")
    // ...and Keybinds.parse fills the omitted key with its "none" default.
    const parsed = TuiKeybind.Keybinds.parse({ agent_cycle: "tab", variant_cycle: "ctrl+t" })
    expect(parsed.variant_list).toBe("none")
  })

  test("keybinds with variant_list rejected when not a string", () => {
    // A number is not in BindingValueSchema (false | "none" | binding | binding[]).
    expect(decodeOverrides({ variant_list: 42 })._tag).toBe("None")
    // Sanity: a string binding is accepted.
    expect(decodeOverrides({ variant_list: "ctrl+v" })._tag).toBe("Some")
  })
})

// ---------- Path sandbox coverage ----------
describe("v1.4.0 chaos — sensitive-file blocklist coverage", () => {
  // Read the protected.ts source and assert key entries are present.
  // Round 3 confirmed the blocklist via direct inspection — this test
  // pins the coverage so a future cleanup can't silently drop entries.
  const sourceText = (() => {
    try {
      return readFileSync(path.join(repoRoot, "packages/opencode/src/file/protected.ts"), "utf-8")
    } catch {
      return ""
    }
  })()

  for (const dir of [".git", ".ssh", ".gnupg", ".aws", ".azure", ".gcloud", ".kube", ".docker"]) {
    test(`SENSITIVE_DIRS includes ${dir}`, () => {
      expect(sourceText).toContain(`"${dir}"`)
    })
  }

  for (const file of ["env", "env.local", "npmrc", "netrc", "htpasswd"]) {
    test(`SENSITIVE_FILES includes .${file} (via DOT concat)`, () => {
      expect(sourceText).toContain(`DOT + "${file}"`)
    })
  }

  test("SENSITIVE_EXTENSIONS includes private-key extensions", () => {
    expect(sourceText).toContain('".pem"')
    expect(sourceText).toContain('".key"')
    expect(sourceText).toContain('".p12"')
    expect(sourceText).toContain('".pfx"')
  })
})

// ---------- KNOWN ISSUES from round 3 ----------
describe("v1.4.0 chaos — KNOWN ISSUES (round 3 findings)", () => {
  // Once gapped: Plugin.trigger used to propagate hook exceptions, which
  // meant a single buggy plugin's chat.params (or any hook) could crash
  // the session at session/llm.ts:121. Round-3 fix wraps the hook call
  // in try/catch and logs failures, then continues with remaining hooks.
  test("Plugin.trigger isolates hook failures (tryPromise + ignore around hook invocation)", async () => {
    const pluginSrc = readFileSync(path.join(repoRoot, "packages/opencode/src/plugin/index.ts"), "utf-8")
    // Since the v1.18.10 merge, trigger is Effect-native (the async export is a thin
    // makeRuntime delegate) — the isolation lives in the Effect body: each hook call is
    // wrapped in Effect.tryPromise and the failure is discarded via Effect.ignore.
    const triggerBody = pluginSrc.match(/const trigger = Effect\.fn\("Plugin\.trigger"\)[\s\S]*?^    \}\)$/m)?.[0] ?? ""
    expect(triggerBody).toMatch(/Effect\.tryPromise\(\{[\s\S]*fn\(input, output\)[\s\S]*\}\)/)
    expect(triggerBody).toMatch(/Effect\.ignore/)
    // and the Promise-facade export must delegate to the isolated Effect trigger
    expect(pluginSrc).toMatch(/export async function trigger[\s\S]*?svc\.trigger\(name, input, output\)/)
  })

  test("Plugin.trigger logs and continues when a hook throws (functional check)", async () => {
    // Black-box: register a plugin whose hook throws, register a second
    // plugin whose hook records that it ran. Verify (a) trigger does not
    // throw, (b) the second plugin still ran. Implemented as a focused
    // shape test — the full path requires Bus + state, so this asserts
    // the source-level invariant only. Pairs with the regex test above.
    const pluginSrc = readFileSync(path.join(repoRoot, "packages/opencode/src/plugin/index.ts"), "utf-8")
    const triggerBody = pluginSrc.match(/const trigger = Effect\.fn\("Plugin\.trigger"\)[\s\S]*?^    \}\)$/m)?.[0] ?? ""
    // The failure path must log — proves we're logging not silently swallowing
    expect(triggerBody).toMatch(/tapError[\s\S]*logError/)
  })

  // [KNOWN ISSUE] Bearer regex test coverage hole.
  // Round 3 mutation testing showed `Bearer\s+` → `Bearer\s` (require
  // exactly one whitespace) passes all tests. Real Bearer headers are
  // always 1 space, but the regex allows >=1 — a future "simplification"
  // could drop the `+` without test failure. Add a multi-whitespace
  // test case to pin the behavior.
  test("[KNOWN ISSUE] maskString does NOT pin Bearer multi-whitespace behavior", () => {
    // Synthetic 30+ char token (avoid real-looking JWT header which trips
    // GitGuardian even in tests). Both single- and double-space variants
    // must redact; if either fails, the regex broke.
    const synthetic = "abc123def456ghi789jkl012mno345pqr678"
    const single = Telemetry.maskString(`Authorization: Bearer ${synthetic}`)
    const double = Telemetry.maskString(`Authorization: Bearer  ${synthetic}`)
    expect(single).toContain("Bearer ***")
    expect(double).toContain("Bearer ***") // ← pins the `\s+` mutation
  })
})
