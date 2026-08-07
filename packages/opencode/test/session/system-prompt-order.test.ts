/**
 * altimate_change — system prompt segment ordering for exact-prefix caches.
 *
 * Vertex/Gemini and OpenAI do EXACT prefix matching and stop at the first differing
 * byte. `session/llm.ts` joins the provider prompt, every segment from
 * `SystemPrompt.assemble()`, and the per-message system prompt into ONE string, so
 * the order asserted here is literally byte order on the wire.
 *
 * `SystemPrompt.environment()` used to be FIRST, right after the provider prompt. It
 * carries the working directory, worktree, platform and today's date, so the first
 * differing byte landed ~6k tokens into a ~121k-token payload. Measured against
 * Vertex: 6,142 tokens cached (5.1%) versus 120,804 (99.9%) on a full-prefix hit.
 *
 * Upstream builds the array with environment first, so a future merge can silently
 * reintroduce the regression. These tests are the guard.
 */

import { describe, expect, setSystemTime, test } from "bun:test"
import { Effect } from "effect"
import { SystemPrompt } from "../../src/session/system"
import { testEffect } from "../lib/effect"
import { withLegacyInstanceRunner } from "./legacy-instance"

const SKILLS = "SKILLS_SEGMENT"
const INSTRUCTIONS = ["AGENTS_MD_SEGMENT"]
const KNOWLEDGE = "KNOWLEDGE_SEGMENT"
const ENVIRONMENT = ["ENVIRONMENT_SEGMENT"]
const REMINDERS = ["REMINDER_SEGMENT"]

function assembleAll() {
  return SystemPrompt.assemble({
    skills: SKILLS,
    instructions: INSTRUCTIONS,
    knowledge: KNOWLEDGE,
    environment: ENVIRONMENT,
    hoistedReminders: REMINDERS,
  })
}

describe("SystemPrompt.assemble: stable→volatile ordering", () => {
  test("orders segments skills → instructions → knowledge → environment → reminders", () => {
    expect(assembleAll()).toEqual([SKILLS, ...INSTRUCTIONS, KNOWLEDGE, ...ENVIRONMENT, ...REMINDERS])
  })

  test("environment is never first — the regression that truncated the cached prefix", () => {
    const parts = assembleAll()
    expect(parts.indexOf("ENVIRONMENT_SEGMENT")).toBeGreaterThan(parts.indexOf(SKILLS))
    expect(parts.indexOf("ENVIRONMENT_SEGMENT")).toBeGreaterThan(parts.indexOf("AGENTS_MD_SEGMENT"))
    expect(parts.indexOf("ENVIRONMENT_SEGMENT")).toBeGreaterThan(parts.indexOf(KNOWLEDGE))
  })

  test("environment still precedes the per-turn hoisted reminders", () => {
    const parts = assembleAll()
    expect(parts.indexOf("ENVIRONMENT_SEGMENT")).toBeLessThan(parts.indexOf("REMINDER_SEGMENT"))
  })

  test("environment stays first when it is the only volatile segment present", () => {
    // Degenerate case: no skills, no AGENTS.md, no memory. Environment must still
    // be present — a cheaper prefix that drops the cwd is not the goal.
    expect(
      SystemPrompt.assemble({
        instructions: [],
        environment: ENVIRONMENT,
        hoistedReminders: [],
      }),
    ).toEqual(ENVIRONMENT)
  })

  test("omits absent optional segments rather than emitting empty strings", () => {
    const parts = SystemPrompt.assemble({
      skills: undefined,
      instructions: [],
      knowledge: "",
      environment: ENVIRONMENT,
      hoistedReminders: [],
    })
    expect(parts).toEqual(ENVIRONMENT)
    expect(parts.some((p) => p === "")).toBe(false)
  })

  test("drops no content — every supplied segment survives", () => {
    const parts = assembleAll()
    for (const expected of [SKILLS, ...INSTRUCTIONS, KNOWLEDGE, ...ENVIRONMENT, ...REMINDERS]) {
      expect(parts).toContain(expected)
    }
    expect(parts).toHaveLength(5)
  })

  test("preserves the relative order of multiple instruction files", () => {
    const parts = SystemPrompt.assemble({
      instructions: ["FIRST_AGENTS", "SECOND_AGENTS", "THIRD_AGENTS"],
      environment: ENVIRONMENT,
      hoistedReminders: [],
    })
    expect(parts).toEqual(["FIRST_AGENTS", "SECOND_AGENTS", "THIRD_AGENTS", ...ENVIRONMENT])
  })

  test("preserves the relative order of multiple hoisted reminders", () => {
    const parts = SystemPrompt.assemble({
      instructions: [],
      environment: ENVIRONMENT,
      hoistedReminders: ["R1", "R2"],
    })
    expect(parts).toEqual([...ENVIRONMENT, "R1", "R2"])
  })

  test("is pure — repeated calls with the same input produce identical output", () => {
    expect(assembleAll()).toEqual(assembleAll())
  })
})

// The reorder is only worth doing if the model still knows where it is and what day
// it is. These assert the content survived the move. environment() reads
// Instance.directory/worktree/project, so it needs a real instance context.
const it = withLegacyInstanceRunner(testEffect(SystemPrompt.layer))
const model = { api: { id: "test-model" }, providerID: "test" } as any

describe("SystemPrompt.environment: correctness bar", () => {
  it.instance("still reports the working directory, worktree, platform and git status", () =>
    Effect.gen(function* () {
      const [env] = yield* Effect.promise(() => SystemPrompt.environment(model))
      expect(env).toContain("Working directory:")
      expect(env).toContain("Workspace root folder:")
      expect(env).toContain("Is directory a git repo:")
      expect(env).toContain("Platform:")
    }),
  )

  it.instance("still carries today's date, and carries it INSIDE the <env> block", () =>
    Effect.gen(function* () {
      // LANDMINE (see the currentDate() comment in session/system.ts): the date was
      // previously appended to the trailing user message, which made models treat it
      // as user input and echo it back every turn. It must stay ambient system
      // context inside <env> — moving <env> later must not have split it back out.
      setSystemTime(new Date("2026-06-22T12:00:00.000Z"))
      try {
        const [env] = yield* Effect.promise(() => SystemPrompt.environment(model))
        const today = new Date().toDateString()
        const dateLine = `Today's date: ${today}`
        expect(env).toContain(dateLine)

        const open = env.indexOf("<env>")
        const close = env.indexOf("</env>")
        expect(open).toBeGreaterThanOrEqual(0)
        expect(close).toBeGreaterThan(open)
        expect(env.indexOf(dateLine)).toBeGreaterThan(open)
        expect(env.indexOf(dateLine)).toBeLessThan(close)
      } finally {
        setSystemTime()
      }
    }),
  )
})
