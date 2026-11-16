// altimate_change - new file
//
// The `/rules` menu's pure helpers: how a shown decision is remembered, and why the skill and knowledge part is missing
// or short.
import { describe, expect, test } from "bun:test"
import { requestsProblem, shownKey } from "../../../src/plugin/tui/altimate/rules"

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
})
