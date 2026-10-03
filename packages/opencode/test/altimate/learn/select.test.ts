// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Effect, Schema } from "effect"
import { Config } from "../../../src/config/config"
import type { Lesson } from "../../../src/altimate/learn/lesson"
import { core, DEFAULT_LIMITS, estimateTokens, matchesFile, renderSection, resolveLimits, retrieve, selectStart, tokenize } from "../../../src/altimate/learn/select"
import { testEffect } from "../../lib/effect"

function lesson(id: string, text: string, extra: Partial<Lesson> = {}): Lesson {
  return {
    id, text, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0,
    created: "2026-09-30T00:00:00.000Z", updated: "2026-09-30T00:00:00.000Z", ...extra,
  }
}

describe("local lesson retrieval", () => {
  test("tokenizes snake, dotted, camel and acronym identifiers and retains underscore affixes", () => {
    const tokens = tokenize("raw.orders_total HTTPClient paidCents _cents stg_ amount_cents")
    for (const token of ["raw", "orders", "total", "http", "client", "paid", "cents", "_cents", "stg_", "amount"])
      expect(tokens).toContain(token)
    expect(tokenize("... __")).toEqual([])
  })

  test("BM25 rewards rare exact identifiers, relevant tags and trigger paths", () => {
    const lessons = [
      lesson("L-0001", "Preserve `net_amount_cents` when calculating invoice totals."),
      lesson("L-0002", "Preserve invoice totals and add tests to invoice functions."),
      lesson("L-0003", "Run reconciliation before publishing.", { tags: ["ledgerSettlement"] }),
      lesson("L-0004", "Keep the parser backwards compatible.", { trigger: { paths: ["src/protocol/*.ts"] } }),
    ]
    expect(retrieve(lessons, "invoice net_amount_cents", { limit: 1 }).map((l) => l.id)).toEqual(["L-0001"])
    expect(retrieve(lessons, "ledger settlement", { limit: 1 }).map((l) => l.id)).toEqual(["L-0003"])
    expect(retrieve(lessons, "protocol", { limit: 1 }).map((l) => l.id)).toEqual(["L-0004"])
    expect(retrieve(lessons, "_cents", { limit: 1 }).map((l) => l.id)).toEqual(["L-0001"])
  })

  test("BM25 length normalization favors focused lessons over padded matching lessons", () => {
    const lessons = [lesson("L-0001", "Use decimal money."), lesson("L-0002", `Use decimal money. ${"Unrelated prose. ".repeat(30)}`)]
    expect(retrieve(lessons, "decimal", { limit: 1 }).map((l) => l.id)).toEqual(["L-0001"])
  })

  test("excludes prior lessons, enforces retrieval limit, rejects unmatched and below-threshold scores", () => {
    const lessons = [3, 2, 1].map((n) => lesson(`L-000${n}`, "Use decimal money."))
    expect(retrieve(lessons, "decimal", { limit: 1, exclude: ["L-0001"] }).map((l) => l.id)).toEqual(["L-0002"])
    expect(retrieve(lessons, "unmatched", { limit: 3 })).toEqual([])
    expect(retrieve(lessons, "decimal", { limit: 3, minimumScore: 100 })).toEqual([])
    expect(retrieve(lessons, "", { limit: 3 })).toEqual([])
    expect(retrieve(lessons, "decimal", { limit: 0 })).toEqual([])
  })
})

describe("tiers and prompt budget", () => {
  test("core sorts by pin, net helpfulness and id, without mutating the store", () => {
    const lessons = [
      lesson("L-0004", "Fourth", { helpful: 5, harmful: 1 }),
      lesson("L-0003", "Third", { helpful: 8, harmful: 4 }),
      lesson("L-0002", "Second", { helpful: 20, harmful: 30, pinned: true }),
      lesson("L-0001", "First", { helpful: 10 }),
    ]
    expect(core(lessons, 3).map((l) => l.id)).toEqual(["L-0002", "L-0001", "L-0003"])
    expect(lessons.map((l) => l.id)).toEqual(["L-0004", "L-0003", "L-0002", "L-0001"])
  })

  test("session-start core and retrieved tiers are distinct and individually limited", () => {
    const lessons = [
      lesson("L-0001", "Core naming rule", { pinned: true }),
      lesson("L-0002", "Fix invoice money"),
      lesson("L-0003", "Check invoice totals"),
      lesson("L-0004", "Use safe paths"),
    ]
    const selected = selectStart(lessons, "invoice money totals", { ...DEFAULT_LIMITS, core_lessons: 1, retrieved_lessons: 1 })
    expect(selected.lessons.map(({ lesson, tier }) => [lesson.id, tier])).toEqual([["L-0001", "core"], ["L-0002", "retrieved"]])
    expect(selected.section).toBe("## Team rules\nCore naming rule\nFix invoice money")
    expect(selectStart(lessons, "invoice", { ...DEFAULT_LIMITS, session_max_lessons: 1 }).lessons).toHaveLength(1)
    expect(selectStart(lessons, "invoice", { ...DEFAULT_LIMITS, session_max_lessons: 0 }).section).toBe("")
  })

  test("budget includes heading/newlines, accepts exact fits and never cuts a lesson", () => {
    const first = lesson("L-0001", "abcdefghij")
    const second = lesson("L-0002", "k")
    expect(estimateTokens("## Team rules\nabcdefghij")).toBe(6)
    expect(renderSection([first, second], 6)).toEqual({ section: "## Team rules\nabcdefghij", lessons: [first] })
    expect(renderSection([first, second], 5)).toEqual({ section: "## Team rules\nk", lessons: [second] })
    expect(selectStart([first, second], "", { ...DEFAULT_LIMITS, budget_tokens: 5 }).lessons.map(({ lesson }) => lesson.id)).toEqual(["L-0002"])
    expect(renderSection([first], 0)).toEqual({ section: "", lessons: [] })
    expect(selectStart([], "anything", { ...DEFAULT_LIMITS }).section).toBe("")
  })

  test("renders lesson text alone, one normalized line per lesson", () => {
    const selected = renderSection([lesson("L-0001", " Use  `money_cents`\nconsistently. ", { helpful: 123, tags: ["hidden-tag"] })], 50)
    expect(selected.section).toBe("## Team rules\nUse `money_cents` consistently.")
  })
})

describe("file matching", () => {
  test("matches trigger globs including nested and root files and normalizes separators", () => {
    const rule = lesson("L-0001", "Use clear names.", { trigger: { paths: ["src/**/*.ts", "config.{json,yaml}"] } })
    for (const file of ["src/main.ts", "src/nested/helper.ts", "src\\nested\\helper.ts", "./config.yaml"])
      expect(matchesFile(rule, file)).toBe(true)
    expect(matchesFile(rule, "src/main.py")).toBe(false)
  })

  test("matches exact code anchors and underscore affixes, not unmarked prose or partial identifiers", () => {
    expect(matchesFile(lesson("L-0001", "Check `payments` before use."), "src/payments.ts")).toBe(true)
    expect(matchesFile(lesson("L-0001", "Check `payments` before use."), "src/payments_extra.ts")).toBe(true)
    expect(matchesFile(lesson("L-0001", "Check `payments` before use."), "src/repayments.ts")).toBe(false)
    expect(matchesFile(lesson("L-0001", "Check `orders` before use."), "models/stg_orders.sql")).toBe(true)
    expect(matchesFile(lesson("L-0001", "Check payments before use."), "src/payments.ts")).toBe(false)
    expect(matchesFile(lesson("L-0001", "Convert `_cents` to dollars."), "models/net_amount_cents.sql")).toBe(true)
    expect(matchesFile(lesson("L-0001", "Keep `stg_` models simple."), "models/stg_orders.sql")).toBe(true)
  })
})

describe("selection config", () => {
  test("all four limits use environment over config over defaults, including zero", () => {
    expect(resolveLimits({}, {})).toEqual(DEFAULT_LIMITS)
    const configured = { core_lessons: 2, retrieved_lessons: 3, budget_tokens: 400, session_max_lessons: 5 }
    expect(resolveLimits(configured, {})).toEqual(configured)
    expect(resolveLimits(configured, {
      ALTIMATE_LEARN_CORE_LESSONS: " 0 ", ALTIMATE_LEARN_RETRIEVED_LESSONS: "7",
      ALTIMATE_LEARN_BUDGET_TOKENS: "800", ALTIMATE_LEARN_SESSION_MAX_LESSONS: "9",
    })).toEqual({ core_lessons: 0, retrieved_lessons: 7, budget_tokens: 800, session_max_lessons: 9 })
    expect(resolveLimits(configured, { ALTIMATE_LEARN_CORE_LESSONS: " " })).toEqual(configured)
    for (const value of ["-1", "1.5", "NaN", "Infinity", "9007199254740992"])
      expect(() => resolveLimits(configured, { ALTIMATE_LEARN_CORE_LESSONS: value })).toThrow("nonnegative safe integer")
    expect(() => resolveLimits({ budget_tokens: -1 }, {})).toThrow("budget_tokens")
  })

  test("core config schema accepts limits and rejects negative or fractional values", () => {
    const parse = Schema.decodeUnknownSync(ConfigV1.Info)
    const learn = { core_lessons: 0, retrieved_lessons: 12, budget_tokens: 2000, session_max_lessons: 30 }
    expect(parse({ learn }).learn).toEqual(learn)
    for (const key of Object.keys(learn)) {
      expect(() => parse({ learn: { [key]: -1 } })).toThrow()
      expect(() => parse({ learn: { [key]: 1.5 } })).toThrow()
    }
  })
})

const it = testEffect(Config.defaultLayer)
it.instance("opencode config loader preserves the shared selection limits", () => Effect.gen(function* () {
  const config = yield* (yield* Config.Service).get()
  expect(config.learn).toMatchObject({ core_lessons: 2, retrieved_lessons: 3, budget_tokens: 400, session_max_lessons: 5 })
}), { config: { learn: { core_lessons: 2, retrieved_lessons: 3, budget_tokens: 400, session_max_lessons: 5 } } })
