// altimate_change - new file
//
// The `/rules` menu's pure helpers: how a shown decision is remembered, and why the skill and knowledge part is missing
// or short.
import { describe, expect, test } from "bun:test"
import { combinedToast, decisionToast, decisionToaster, requestsProblem, shownKey } from "../../../src/plugin/tui/altimate/rules"

describe("rules TUI", () => {
  test("a decision is remembered by kind, id and status: a rule and a skill with one id do not hide each other", () => {
    expect(shownKey({ public_id: "x", status: "active" })).toBe("rule:x:active")
    expect(shownKey({ kind: "skill", public_id: "x", status: "active" })).toBe("skill:x:active")
    expect(shownKey({ kind: "rule", public_id: "x", status: "active" })).toBe(shownKey({ public_id: "x", status: "active" }))
  })

  test("a slow, failed, refused or partial listing says so; a whole one, or one the header explains, does not", () => {
    expect(requestsProblem("slow")?.title).toContain("did not load in time")
    expect(requestsProblem(undefined)?.title).toContain("could not be loaded")
    expect(requestsProblem({ ok: true, review_status: "failed", review_error: "Gateway \u001b[1mdown" })).toEqual({
      title: "Your skill and knowledge requests could not be loaded",
      description: "Gateway  [1mdown",
    })
    expect(requestsProblem({ ok: true, review_status: "account_changed" })?.title).toContain("not shown")
    expect(requestsProblem({ ok: true, review_status: "ok", review_complete: false })?.title).toContain("most recent")
    expect(requestsProblem({ ok: true, review_status: "ok" })).toBeUndefined()
    expect(requestsProblem({ ok: true, review_status: "not_linked" })).toBeUndefined()
    expect(requestsProblem({ ok: true, review_status: "unsupported" })).toBeUndefined()
  })

  const approved = { kind: "skill" as const, public_id: "a", text: "cost-guard", status: "active", reviewer: "Olive" }
  const rejected = { kind: "knowledge" as const, public_id: "b", text: "Glossary", status: "rejected", reviewer: "Olive", reason: "Too broad" }

  test("one decision reads as before; a rule status this version does not show makes no toast", () => {
    expect(decisionToast(approved)).toEqual({
      variant: "success",
      message: 'Your skill "cost-guard" was approved by Olive. It now reaches the workspace.',
      duration: 10000,
    })
    expect(decisionToast(rejected)?.message).toBe('Your knowledge base "Glossary" was rejected by Olive — Too broad')
    expect(decisionToast({ public_id: "r", text: "x", status: "superseded" })).toBeUndefined()
    expect(combinedToast([approved])).toEqual(decisionToast(approved))
    expect(combinedToast([])).toBeUndefined()
  })

  test("decisions that arrive together are one toast, a warning when any is a rejection or a removal", () => {
    expect(combinedToast([approved, rejected])).toEqual({
      variant: "warning",
      message: '2 decisions on your requests: skill "cost-guard" approved by Olive · knowledge base "Glossary" rejected by Olive — Too broad',
      duration: 15000,
    })
    const removed = { ...approved, public_id: "c", status: "retired", reason: "Old" }
    expect(combinedToast([approved, removed])?.message).toContain('skill "cost-guard" removed by Olive — Old')
    expect(combinedToast([approved, { ...approved, public_id: "d", text: "naming" }])?.variant).toBe("success")
    // Many at once (a TUI that was closed): five are named, the rest counted.
    const many = Array.from({ length: 8 }, (_, i) => ({ ...approved, public_id: `m${i}`, text: `skill-${i}` }))
    const message = combinedToast(many)!.message
    expect(message.startsWith("8 decisions on your requests: ")).toBe(true)
    expect(message).toContain('skill "skill-4" approved')
    expect(message).not.toContain("skill-5")
    expect(message.endsWith(" · and 3 more (see /rules)")).toBe(true)
  })

  test("the toaster shows decisions held together once, and tells Sync now one was shown since it started", () => {
    const shown: string[] = []
    let clock = 1000
    const toaster = decisionToaster((t) => shown.push(t.message), 60_000, () => clock)
    expect(toaster.shownSince(0)).toBe(false)
    toaster.push(approved)
    toaster.push(rejected)
    // Held, not yet shown: Sync now must still not cover it with its summary.
    expect(toaster.shownSince(1000)).toBe(true)
    toaster.flush()
    expect(shown).toEqual([combinedToast([approved, rejected])!.message])
    expect(toaster.shownSince(1000)).toBe(true)
    clock = 2000
    expect(toaster.shownSince(1500)).toBe(false)
    // Only a status with no toast: nothing shown, nothing claimed.
    toaster.push({ public_id: "r", text: "x", status: "superseded" })
    expect(toaster.shownSince(1500)).toBe(false)
    toaster.flush()
    expect(shown).toHaveLength(1)
    toaster.dispose()
  })
})
