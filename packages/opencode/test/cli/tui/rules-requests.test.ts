// altimate_change - new file
//
// The `/rules` menu's pure helpers: how a shown decision is remembered, and why the skill and knowledge part is missing
// or short.
import { describe, expect, test } from "bun:test"
import { announceWhenClear, combinedToast, decisionToast, decisionToaster, requestActionsTitle, requestsProblem, shownKey } from "../../../src/plugin/tui/altimate/rules"
import type { WorkspaceRequest } from "../../../src/plugin/tui/altimate/rules"

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

  test("a request sent back for changes is a warning with the comment and how to send it again", () => {
    const sentBack = { ...approved, status: "changes_requested", reason: "Name the table" }
    expect(decisionToast(sentBack)).toEqual({
      variant: "warning",
      message:
        'Changes requested on your skill "cost-guard" by Olive — Name the table. Change the skill, then send it again with `altimate-code skill publish cost-guard` (or from your IDE).',
      duration: 20000,
    })
    expect(decisionToast({ public_id: "r", text: "Name tables", status: "changes_requested", reviewer: "Olive", reason: "Which schema?" })?.message).toBe(
      'Changes requested on your rule by Olive: "Name tables" — Which schema? Open /rules to see what you can do.',
    )
    expect(combinedToast([approved, sentBack])).toMatchObject({ variant: "warning" })
    expect(combinedToast([approved, sentBack])?.message).toContain('skill "cost-guard" sent back for changes by Olive — Name the table')
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

describe("the activity line waits for decision toasts", () => {
  const run = (busy: boolean[], disposedAfter = Infinity) => {
    let checks = 0
    const shown: string[] = []
    const result = announceWhenClear({
      busy: () => busy[Math.min(checks++, busy.length - 1)],
      wait: async () => {},
      waits: 3,
      disposed: () => checks >= disposedAfter,
      show: () => shown.push("line"),
    })
    return result.then((ok) => ({ ok, shown, checks }))
  }

  test("shows once the toast is gone", async () => {
    expect(await run([true, true, false])).toEqual({ ok: true, shown: ["line"], checks: 3 })
  })

  test("never shows over a toast that is still up: it gives up, so the line comes next time", async () => {
    expect(await run([true])).toEqual({ ok: false, shown: [], checks: 4 })
  })

  test("shows nothing once the TUI is closing", async () => {
    expect(await run([true, false], 1)).toEqual({ ok: false, shown: [], checks: 1 })
  })
})

describe("requestActionsTitle", () => {
  const request = (over: Partial<WorkspaceRequest> & { kind?: "skill" | "knowledge" }): WorkspaceRequest & { kind: "skill" | "knowledge" } => ({
    kind: "skill",
    public_id: "c-1",
    name: "demo-naming",
    status: "pending",
    actions: ["withdraw"],
    ...over,
  })

  test("a request sent back carries the reviewer's whole comment and how to send it again", () => {
    const comment = "Also cover mart models (fct_ / dim_), and say whether snapshots follow this too"
    expect(requestActionsTitle(request({ status: "changes_requested", reviewer: "Local Admin", reason: comment }))).toBe(
      `Your skill "demo-naming": changes requested by Local Admin — ${comment}. Change the skill, then send it again with \`altimate-code skill publish demo-naming\` (or from your IDE).`,
    )
    expect(
      requestActionsTitle(request({ kind: "knowledge", name: "Glossary", status: "changes_requested", reviewer: "Ann", reason: "Add ARR" })),
    ).toBe(`Your knowledge base "Glossary": changes requested by Ann — Add ARR. Change the knowledge base, then send it again from the workspace's Knowledge tab.`)
    // A name that is not a plain slug is quoted, so the printed command runs as written.
    expect(requestActionsTitle(request({ name: "cost guard", status: "changes_requested" }))).toBe(
      `Your skill "cost guard": changes requested. Change the skill, then send it again with \`altimate-code skill publish "cost guard"\` (or from your IDE).`,
    )
  })

  test("a comment that already ends a sentence gets no second stop", () => {
    expect(requestActionsTitle(request({ status: "rejected", reviewer: "Ann", reason: "Which column?" }))).toBe(
      `Your skill "demo-naming": rejected by Ann — Which column?`,
    )
  })

  test("a waiting or rejected request says its status, with no resend hint", () => {
    expect(requestActionsTitle(request({}))).toBe(`Your skill "demo-naming": pending review.`)
    expect(requestActionsTitle(request({ status: "rejected", reviewer: "Ann", reason: "Covered elsewhere" }))).toBe(
      `Your skill "demo-naming": rejected by Ann — Covered elsewhere.`,
    )
  })
})
