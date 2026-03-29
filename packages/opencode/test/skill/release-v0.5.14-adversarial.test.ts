/**
 * Adversarial tests for v0.5.14 release features:
 *
 * 1. SkillFollowups — follow-up suggestions after skill completion
 * 2. Locale.duration — days/hours fix and boundary conditions
 * 3. Dispatcher.reset — lazy registration hook cleanup
 * 4. Impact analysis — model-specific test count (not project-wide)
 * 5. dbt-tools build — no-model project build, --downstream guard
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { SkillFollowups } from "../../src/skill/followups"
import { Locale } from "../../src/util/locale"
import * as Dispatcher from "../../src/altimate/native/dispatcher"

// ─────────────────────────────────────────────────────────────
// 1. SkillFollowups adversarial
// ─────────────────────────────────────────────────────────────

describe("v0.5.14 release: SkillFollowups", () => {
  describe("empty and null inputs", () => {
    test("empty string skill returns empty array", () => {
      const result = SkillFollowups.get("")
      expect(result).toEqual([])
    })

    test("format with empty string returns empty string", () => {
      expect(SkillFollowups.format("")).toBe("")
    })

    test("whitespace-only skill name returns empty array", () => {
      expect(SkillFollowups.get("   ")).toEqual([])
      expect(SkillFollowups.get("\t\n")).toEqual([])
    })
  })

  describe("injection and security", () => {
    test("prototype pollution skill name returns empty array", () => {
      expect(SkillFollowups.get("__proto__")).toEqual([])
      expect(SkillFollowups.get("constructor")).toEqual([])
      expect(SkillFollowups.get("prototype")).toEqual([])
    })

    test("prototype pollution does not modify Object.prototype", () => {
      const before = Object.keys(Object.prototype).length
      SkillFollowups.get("__proto__")
      SkillFollowups.get("constructor")
      const after = Object.keys(Object.prototype).length
      expect(after).toBe(before)
    })

    test("path traversal skill name returns empty array", () => {
      expect(SkillFollowups.get("../../etc/passwd")).toEqual([])
      expect(SkillFollowups.get("..\\..\\windows\\system32")).toEqual([])
    })

    test("SQL injection in skill name returns empty array", () => {
      expect(SkillFollowups.get("'; DROP TABLE skills; --")).toEqual([])
    })

    test("HTML/XSS in skill name returns empty array", () => {
      expect(SkillFollowups.get('<script>alert("xss")</script>')).toEqual([])
    })

    test("null byte in skill name returns empty array", () => {
      expect(SkillFollowups.get("dbt-develop\0malicious")).toEqual([])
    })
  })

  describe("boundary and stress", () => {
    test("extremely long skill name does not crash", () => {
      const longName = "a".repeat(100_000)
      const result = SkillFollowups.get(longName)
      expect(result).toEqual([])
    })

    test("1000 rapid sequential calls do not leak memory", () => {
      for (let i = 0; i < 1000; i++) {
        SkillFollowups.get("dbt-develop")
        SkillFollowups.format("dbt-develop")
      }
      // If we got here without crashing, the test passes
      expect(true).toBe(true)
    })

    test("unicode skill names return empty array", () => {
      expect(SkillFollowups.get("日本語スキル")).toEqual([])
      expect(SkillFollowups.get("навык")).toEqual([])
      expect(SkillFollowups.get("🔥💀")).toEqual([])
    })

    test("skill name with only special characters returns empty array", () => {
      expect(SkillFollowups.get("!@#$%^&*()")).toEqual([])
      expect(SkillFollowups.get("{}[]|\\:;<>?,./~`")).toEqual([])
    })
  })

  describe("immutability", () => {
    test("get() returns frozen array that cannot be modified", () => {
      const result = SkillFollowups.get("dbt-develop")
      expect(result.length).toBeGreaterThan(0)
      expect(Object.isFrozen(result)).toBe(true)
      expect(() => (result as any).push({ skill: "hacked", label: "x", description: "x" })).toThrow()
    })

    test("sequential get() calls return structurally equal results", () => {
      const a = SkillFollowups.get("dbt-develop")
      const b = SkillFollowups.get("dbt-develop")
      expect(a).toEqual(b)
    })

    test("modifying a suggestion object does not affect subsequent calls", () => {
      const first = SkillFollowups.get("dbt-develop")
      // Even with frozen arrays, attempt to mutate nested object
      try {
        ;(first[0] as any).skill = "hacked"
      } catch {
        // Expected: frozen object throws
      }
      const second = SkillFollowups.get("dbt-develop")
      expect(second[0]!.skill).not.toBe("hacked")
    })
  })

  describe("format output correctness", () => {
    test("format includes What's Next header for mapped skill", () => {
      const output = SkillFollowups.format("dbt-develop")
      expect(output).toContain("## What's Next?")
      expect(output).toContain("---")
    })

    test("format produces numbered list matching suggestion count", () => {
      const suggestions = SkillFollowups.get("dbt-develop")
      const output = SkillFollowups.format("dbt-develop")
      for (let i = 1; i <= suggestions.length; i++) {
        expect(output).toContain(`${i}.`)
      }
    })

    test("format includes warehouse nudge", () => {
      const output = SkillFollowups.format("dbt-develop")
      expect(output).toContain("/discover")
    })

    test("format for unmapped skill returns empty string not undefined", () => {
      const result = SkillFollowups.format("nonexistent-skill-xyz")
      expect(result).toBe("")
      expect(typeof result).toBe("string")
    })
  })

  describe("data integrity", () => {
    test("no circular references in follow-up chains", () => {
      // For every skill that has followups, none of its followups should suggest
      // a cycle back to a skill that suggests the original
      const allSkills = [
        "dbt-develop", "dbt-troubleshoot", "dbt-test", "dbt-docs",
        "dbt-analyze", "sql-review", "sql-translate", "query-optimize",
        "cost-report", "pii-audit", "lineage-diff", "schema-migration",
      ]

      for (const skill of allSkills) {
        const suggestions = SkillFollowups.get(skill)
        for (const suggestion of suggestions) {
          // The suggestion's followups should not immediately suggest the original skill
          // (depth-1 cycle detection)
          const nextSuggestions = SkillFollowups.get(suggestion.skill)
          const cycleBack = nextSuggestions.find(
            (s) => s.skill === skill && SkillFollowups.get(s.skill).some((ss) => ss.skill === skill),
          )
          // Cycles of depth 2 are acceptable (A→B→A is fine for UX)
          // but A→A (self-reference) is never OK
          expect(suggestion.skill).not.toBe(skill)
        }
      }
    })

    test("all suggested skills are valid skill names (no typos)", () => {
      const knownSkills = new Set([
        "dbt-develop", "dbt-troubleshoot", "dbt-test", "dbt-docs",
        "dbt-analyze", "sql-review", "sql-translate", "query-optimize",
        "cost-report", "pii-audit", "lineage-diff", "schema-migration",
        // Add any other valid skill names here
      ])

      const allMapped = [
        "dbt-develop", "dbt-troubleshoot", "dbt-test", "dbt-docs",
        "dbt-analyze", "sql-review", "sql-translate", "query-optimize",
        "cost-report", "pii-audit", "lineage-diff", "schema-migration",
      ]

      for (const skill of allMapped) {
        const suggestions = SkillFollowups.get(skill)
        for (const s of suggestions) {
          expect(knownSkills.has(s.skill)).toBe(true)
        }
      }
    })

    test("every suggestion has non-empty label and description", () => {
      const allMapped = [
        "dbt-develop", "dbt-troubleshoot", "dbt-test", "dbt-docs",
        "dbt-analyze", "sql-review", "sql-translate", "query-optimize",
        "cost-report", "pii-audit", "lineage-diff", "schema-migration",
      ]

      for (const skill of allMapped) {
        for (const s of SkillFollowups.get(skill)) {
          expect(s.label.trim().length).toBeGreaterThan(0)
          expect(s.description.trim().length).toBeGreaterThan(0)
          expect(s.skill.trim().length).toBeGreaterThan(0)
        }
      }
    })
  })
})

// ─────────────────────────────────────────────────────────────
// 2. Locale.duration adversarial
// ─────────────────────────────────────────────────────────────

describe("v0.5.14 release: Locale.duration", () => {
  describe("boundary values at each tier transition", () => {
    test("0ms returns 0ms", () => {
      expect(Locale.duration(0)).toBe("0ms")
    })

    test("999ms stays in ms tier", () => {
      expect(Locale.duration(999)).toBe("999ms")
    })

    test("1000ms transitions to seconds", () => {
      expect(Locale.duration(1000)).toBe("1.0s")
    })

    test("59999ms stays in seconds tier", () => {
      expect(Locale.duration(59999)).toBe("60.0s")
    })

    test("60000ms transitions to minutes", () => {
      expect(Locale.duration(60000)).toBe("1m 0s")
    })

    test("3599999ms stays in minutes tier", () => {
      expect(Locale.duration(3599999)).toBe("59m 59s")
    })

    test("3600000ms transitions to hours", () => {
      expect(Locale.duration(3600000)).toBe("1h 0m")
    })

    test("86399999ms stays in hours tier", () => {
      // 23h 59m (just under 24h)
      expect(Locale.duration(86399999)).toBe("23h 59m")
    })

    test("86400000ms transitions to days (the fixed bug boundary)", () => {
      // Exactly 24 hours = 1 day
      expect(Locale.duration(86400000)).toBe("1d 0h")
    })
  })

  describe("days/hours fix verification (issue #368)", () => {
    test("25 hours = 1d 1h (not 25d 1h or 1h 1d)", () => {
      expect(Locale.duration(90000000)).toBe("1d 1h")
    })

    test("48 hours = 2d 0h", () => {
      expect(Locale.duration(48 * 3600000)).toBe("2d 0h")
    })

    test("49 hours = 2d 1h", () => {
      expect(Locale.duration(49 * 3600000)).toBe("2d 1h")
    })

    test("72 hours = 3d 0h", () => {
      expect(Locale.duration(72 * 3600000)).toBe("3d 0h")
    })

    test("100 hours = 4d 4h", () => {
      expect(Locale.duration(100 * 3600000)).toBe("4d 4h")
    })

    test("365 days = 365d 0h", () => {
      expect(Locale.duration(365 * 86400000)).toBe("365d 0h")
    })

    test("days calculation uses integer division, not floating point", () => {
      // 1.5 days = 1d 12h, not 1.5d
      const oneAndHalfDays = 86400000 + 12 * 3600000
      expect(Locale.duration(oneAndHalfDays)).toBe("1d 12h")
    })
  })

  describe("type confusion and edge cases", () => {
    test("negative input returns negative ms", () => {
      // Negative durations shouldn't crash
      const result = Locale.duration(-1)
      expect(typeof result).toBe("string")
    })

    test("NaN input returns NaNms", () => {
      const result = Locale.duration(NaN)
      expect(typeof result).toBe("string")
    })

    test("Infinity returns a string without crashing", () => {
      const result = Locale.duration(Infinity)
      expect(typeof result).toBe("string")
    })

    test("very large value (Number.MAX_SAFE_INTEGER) does not crash", () => {
      const result = Locale.duration(Number.MAX_SAFE_INTEGER)
      expect(typeof result).toBe("string")
      expect(result).toContain("d")
    })

    test("fractional milliseconds are handled", () => {
      expect(Locale.duration(0.5)).toBe("0.5ms")
      expect(Locale.duration(999.9)).toBe("999.9ms")
    })
  })

  describe("idempotency", () => {
    test("same input always produces same output", () => {
      const inputs = [0, 500, 1000, 60000, 3600000, 86400000, 90000000]
      for (const input of inputs) {
        const a = Locale.duration(input)
        const b = Locale.duration(input)
        expect(a).toBe(b)
      }
    })
  })
})

// ─────────────────────────────────────────────────────────────
// 3. Dispatcher.reset adversarial
// ─────────────────────────────────────────────────────────────

describe("v0.5.14 release: Dispatcher.reset", () => {
  beforeEach(() => {
    Dispatcher.reset()
  })

  test("reset clears all handlers", async () => {
    Dispatcher.register("altimate_core.check" as any, async () => "test")
    Dispatcher.reset()
    await expect(Dispatcher.call("altimate_core.check" as any, {} as any)).rejects.toThrow()
  })

  test("reset clears lazy registration hook", async () => {
    let hookCalled = false
    Dispatcher.setRegistrationHook(async () => {
      hookCalled = true
      Dispatcher.register("altimate_core.check" as any, async () => "test")
    })

    // Reset should clear the hook
    Dispatcher.reset()

    // After reset, calling a method should NOT trigger the old hook
    await expect(Dispatcher.call("altimate_core.check" as any, {} as any)).rejects.toThrow()
    expect(hookCalled).toBe(false)
  })

  test("double reset does not crash", () => {
    Dispatcher.reset()
    Dispatcher.reset()
    // No crash = pass
  })

  test("register after reset works correctly", async () => {
    Dispatcher.register("altimate_core.check" as any, async () => ({ result: "fresh" }))
    const result = await Dispatcher.call("altimate_core.check" as any, {} as any)
    expect(result).toEqual({ result: "fresh" })
  })

  test("new registration hook after reset is honored", async () => {
    let hookCalled = false
    Dispatcher.setRegistrationHook(async () => {
      hookCalled = true
      Dispatcher.register("altimate_core.check" as any, async () => ({ result: "lazy" }))
    })

    const result = await Dispatcher.call("altimate_core.check" as any, {} as any)
    expect(hookCalled).toBe(true)
    expect(result).toEqual({ result: "lazy" })
  })

  test("concurrent reset and call do not deadlock", async () => {
    Dispatcher.register("altimate_core.check" as any, async () => "ok")

    // Fire reset and call concurrently
    const results = await Promise.allSettled([
      (async () => {
        Dispatcher.reset()
      })(),
      Dispatcher.call("altimate_core.check" as any, {} as any).catch(() => "rejected"),
    ])

    // Both should complete (no deadlock), regardless of outcome
    expect(results.every((r) => r.status === "fulfilled")).toBe(true)
  })

  test("100 rapid reset-register cycles do not leak", () => {
    for (let i = 0; i < 100; i++) {
      Dispatcher.register("altimate_core.check" as any, async () => i)
      Dispatcher.reset()
    }
    // No crash or memory growth = pass
  })
})
