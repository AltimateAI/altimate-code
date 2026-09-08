import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { ALTIMATE_BASE_DISCLOSURE, ALTIMATE_BASE_HINT } from "@opencode-ai/core/altimate-base-disclosure"

// Requirement 5 gave the disclosure ONE definition, which removed drift between the TUI gate and the
// HTTP disclosure route. It did nothing for the other consistency axis: the gate versus the fuller
// "Data handling" note in docs/docs/configure/providers.md. That axis had no mechanism except a
// comment saying "keep in sync" — and comments saying that had already failed three times in this
// feature. This file is the mechanism.
//
// The gate is deliberately a short summary, so it is NOT required to repeat everything the docs say
// (the per-installation identifier detail lives in docs only, per #1268). What it must never do is
// drop or weaken a *core* data term, because it is the only text a user reads before consenting.
// The terminal gate defaults to "No", so a stray Return declines rather than accepts — asserted in
// packages/tui/test/cli/tui/dialog-altimate-base.test.tsx.

const DOCS = path.join(import.meta.dir, "../../../../docs/docs/configure/providers.md")

/** The claims the consent gate must carry, whatever the wording. */
const REQUIRED = [
  { name: "logging", pattern: /logged/i },
  { name: "used to train or improve models", pattern: /train|improve/i },
  { name: "do not send secrets", pattern: /secret|confidential/i },
  { name: "rate limiting", pattern: /rate.?limit/i },
]

describe("Altimate Base consent gate", () => {
  test("carries every core data term", () => {
    for (const claim of REQUIRED) {
      expect(
        claim.pattern.test(ALTIMATE_BASE_DISCLOSURE),
        `the consent gate no longer states: ${claim.name}`,
      ).toBe(true)
    }
  })

  test("is a single sentence-per-term summary, not a wall of text", () => {
    // A gate nobody reads is worse than a short one. If it grows past this, the extra belongs in
    // the docs note instead.
    expect(ALTIMATE_BASE_DISCLOSURE.length).toBeLessThan(400)
  })

  test("does not repeat the per-installation identifier detail (#1268 — docs own it)", () => {
    expect(ALTIMATE_BASE_DISCLOSURE).not.toContain("per-installation identifier")
  })

  test("the docs note still discloses everything the gate summarises, plus the linkage detail", () => {
    // If this fails, the docs were trimmed below the gate — the wrong direction. The gate is the
    // summary; the docs must remain the superset.
    const docs = fs.readFileSync(DOCS, "utf8")
    for (const claim of REQUIRED) {
      expect(claim.pattern.test(docs), `the docs no longer state: ${claim.name}`).toBe(true)
    }
    expect(docs).toContain("per-installation identifier")
  })

  test("KNOWN DEVIATION: the gate hedges logging where the docs state it unconditionally", () => {
    // Accepted deliberately by the product owner. Recorded as a test rather than a comment so it
    // stays visible and cannot drift further by accident.
    //
    // Gate: "Your requests may be logged ..."   Docs: "Requests and responses are logged ..."
    //
    // If the gate is ever strengthened to match the docs, DELETE this test — do not relax it. If it
    // starts failing, someone changed the hedge without deciding what it should now say.
    const docs = fs.readFileSync(DOCS, "utf8")
    expect(docs).toContain("are logged")
    expect(ALTIMATE_BASE_DISCLOSURE).toContain("may be logged")
  })

  test("the picker hint stays short enough for one line", () => {
    expect(ALTIMATE_BASE_HINT.length).toBeLessThan(60)
  })
})
