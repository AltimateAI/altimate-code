// altimate_change - new file
//
// Unit coverage for the workspace identity section: the
// model-facing statement of which Altimate Workspace (if any) this project is linked
// to. Tests the pure `render(outcome)` formatter directly, the same way
// `awareness.test.ts` exercises `systemSection` against a hand-built snapshot — the
// async `systemSection` wrapper is a thin pass-through to `state.ts`'s
// `resolveBindingOutcome` and is not re-tested here (that function already has its own
// coverage via the binding-cache tests in `test/altimate/plugin/workspace.test.ts`).
import { describe, expect, test } from "bun:test"
import { MAX_SECTION_CHARS, capSection, render } from "../../../src/altimate/workspace/identity"
import type { BindingOutcome } from "../../../src/altimate/workspace/state"

describe("bound — a specific Altimate Workspace is linked", () => {
  const boundOutcome: BindingOutcome = {
    status: "bound",
    binding: {
      datamateId: 4821,
      datamateName: "Foo Corp Data Team",
      repoRemote: "git@github.com:foo/bar.git",
      projectPath: null,
      linkedAt: 0,
    },
  }
  const boundOut = render(boundOutcome)

  test("names the workspace and forbids substituting another service's 'workspace' for an identity question", () => {
    expect(boundOut).toContain("## Altimate Workspace")
    expect(boundOut).toContain('"Foo Corp Data Team"')
    expect(boundOut).toContain("(id 4821)")
    expect(boundOut).toContain("linked to Altimate Workspace")
    expect(boundOut).toContain("never substitute")
    expect(boundOut).toContain("Databricks workspace")
  })

  test("does NOT tell the model to relabel/footnote every incidental mention of another service's workspace", () => {
    // Regression guard: an earlier draft made this an unconditional rule ("never call
    // it just 'the workspace'"), which reads as "always rename every Databricks
    // mention" — over-triggering the same way the unbound nudge did. The active
    // instruction must be scoped to an actual identity question.
    expect(boundOut).toContain("Outside such a question")
    expect(boundOut).toContain("no need to relabel or footnote every incidental mention")
  })

  test("sanitizes a hostile workspace name (control chars, quotes, length) via inertWorkspaceName", () => {
    const hostile = `evil"\nname` + "x".repeat(200)
    const outcome: BindingOutcome = {
      status: "bound",
      binding: {
        datamateId: 1,
        datamateName: hostile,
        repoRemote: null,
        projectPath: "/tmp/proj",
        linkedAt: 0,
      },
    }
    const out = render(outcome)
    // No raw newline from the name can appear in the rendered section — that would let
    // a customer-authored name start a new line (and so a new heading/role) in what the
    // model reads.
    expect(out.split("\n").length).toBeGreaterThan(1) // section itself is multi-line
    expect(out).not.toContain('evil"\nname') // raw hostile substring never appears verbatim
    expect(out).toContain("id 1")
    // JSON quoting alone would escape the newline and quote; it does NOT touch NEL,
    // the Unicode line separators or the length. Those are the sanitiser's job, and
    // this is what fails when it is skipped.
    const separators = "a\u0085b\u2028c\u2029d"
    const sep = render({ ...outcome, binding: { ...outcome.binding, datamateName: separators } })
    expect(sep).not.toMatch(/[\u0085\u2028\u2029]/)
    expect(sep).toContain('"a b c d"')
    const long = render({ ...outcome, binding: { ...outcome.binding, datamateName: "y".repeat(500) } })
    expect(long).toContain('"' + "y".repeat(79) + '…"')
    expect(long).not.toContain("y".repeat(81))
  })

  test("the label is budgeted on its ENCODED form, so no name can clip the instruction", () => {
    // 80 lone surrogates escape to six characters each; 80 quotes to two. Either
    // used to push the section past the cap and cut the instruction mid-sentence.
    const last = "or footnote every incidental mention of one."
    for (const name of ["\uD800".repeat(80), '"'.repeat(80), "\\".repeat(80), "🚀".repeat(80), "x".repeat(80)]) {
      const out = render({
        status: "bound",
        binding: { datamateId: Number.MAX_SAFE_INTEGER, datamateName: name, repoRemote: null, projectPath: "/p", linkedAt: 0 },
      })
      expect(out.endsWith(last)).toBe(true)
      expect(out.length).toBeLessThan(MAX_SECTION_CHARS)
      expect(out).toContain(`(id ${Number.MAX_SAFE_INTEGER})`)
      expect(out.isWellFormed()).toBe(true)
    }
    // Past the budget (80 escaped quotes plus a 16-digit id) the NAME is shortened
    // with an ellipsis and the id is kept whole, rather than the sentence being cut.
    const quoted = render({
      status: "bound",
      binding: {
        datamateId: Number.MAX_SAFE_INTEGER,
        datamateName: '"'.repeat(80),
        repoRemote: null,
        projectPath: "/p",
        linkedAt: 0,
      },
    })
    expect(quoted).toMatch(/\\"…" \(id 9007199254740991\)\./)
    // Under the budget nothing is shortened.
    const plain = render({
      status: "bound",
      binding: { datamateId: 1, datamateName: '"'.repeat(80), repoRemote: null, projectPath: "/p", linkedAt: 0 },
    })
    expect(plain).not.toContain("…")
  })
})

test("a name that sanitises to nothing does not erase a known identity", () => {
  // The id is the stable half of the identity; `""` reads as a bug.
  const out = render({
    status: "bound",
    binding: { datamateId: 42, datamateName: "\u0000\u0001", repoRemote: null, projectPath: null, linkedAt: 0 },
  })
  expect(out).toContain('"(unnamed)" (id 42)')
  expect(out).not.toContain('""')
})

describe("unbound — no Altimate Workspace is linked", () => {
  const outcome: BindingOutcome = { status: "unbound" }
  const out = render(outcome)

  test("says plainly that none is linked and offers to link one", () => {
    expect(out).toContain("## Altimate Workspace")
    expect(out).toContain("No Altimate Workspace is linked")
    expect(out).toContain("altimate-code link")
    expect(out).toContain("Link this project to a workspace")
  })

  test("does NOT forbid other services' own 'workspace' concepts — only nudges, and only on an identity question", () => {
    // Per explicit product decision: unlinked, there is no Altimate Workspace to
    // protect the bare word "workspace" for, so a Databricks workspace (etc.) can be
    // discussed normally. The requirement is a linking nudge, not a ban.
    expect(out).toContain("discuss them normally")
    expect(out).not.toContain("never any other")
  })

  test("does NOT nudge on every incidental mention of the word — only on a real identity question", () => {
    // Regression guard for the exact bug caught in review: an earlier draft said
    // 'Whenever "workspace" comes up ... also mention that no Altimate Workspace is
    // linked', which fires mid-conversation about something unrelated (e.g. a
    // Databricks workspace's IAM setup) and reads as nagging. The nudge must be
    // conditioned on the user actually asking a workspace-identity question.
    expect(out).not.toContain('Whenever "workspace" comes up')
    expect(out).toContain("with no linking pitch attached")
  })
})

describe("unknown — link status could not be verified this turn", () => {
  const outcome: BindingOutcome = { status: "unknown" }
  const out = render(outcome)

  test("asserts neither a specific workspace nor 'none linked'", () => {
    expect(out).toContain("could not be verified")
    expect(out).toContain("Do not name a specific Altimate Workspace")
    expect(out).toContain("do not say none is")
  })

  test("does not claim a workspace is linked or unlinked, and leaves other services alone", () => {
    expect(out).not.toContain("This project is linked to Altimate Workspace")
    expect(out).not.toContain("No Altimate Workspace is linked")
    expect(out).toContain("Databricks workspace")
  })
})

test("all three branches scope their active instruction to the same identity-question trigger, not to any mention of the word", () => {
  // Cross-branch regression guard: the over-triggering bug applied the same way to
  // all three states (an unconditional rule in "bound", an unconditional nudge in
  // "unbound") — assert all three now share one narrow, identically-worded condition
  // rather than drifting back to "whenever/always" phrasing independently.
  const trigger = 'asks a workspace-IDENTITY question — "workspace" unqualified, or'
  for (const outcome of [
    { status: "bound", binding: { datamateId: 1, datamateName: "X", repoRemote: null, projectPath: "/p", linkedAt: 0 } },
    { status: "unbound" },
    { status: "unknown" },
  ] satisfies BindingOutcome[]) {
    const out = render(outcome)
    expect(out).toContain(trigger)
    // The narrowing half of the trigger is what stops a passing mention of some
    // other service's workspace from counting; without it the prefix alone
    // still reads as "any mention".
    expect(out).toContain("used to ask what THIS project is connected to")
    expect(out).not.toContain("whenever")
    expect(out).not.toMatch(/\balways\b/i)
    // "every mention" may appear only inside the exemption ("no need to … every
    // incidental mention"), never as a condition for acting.
    for (const line of out.split("\n")) {
      if (/\b(every|any|each) (incidental )?mention\b/i.test(line)) expect(line).toContain("no need")
    }
    // Every active instruction — the answer, the link offer, the retry advice —
    // sits in the one sentence that opens with the trigger, so nothing can ask
    // for it unconditionally elsewhere.
    for (const line of out.split("\n")) {
      if (/offer to help link|say plainly|say link status|the answer is/.test(line)) {
        expect(line.startsWith("When the user's own message asks a workspace-IDENTITY question")).toBe(true)
      }
    }
  }
})

describe("capSection — the MAX_SECTION_CHARS hard ceiling", () => {
  // No `render()` call can currently produce output long enough to exercise this via
  // the public formatter alone (`inertWorkspaceName` already bounds the one variable
  // input — the workspace name — to 80 code points), so the cap's own contract is
  // tested directly rather than through a `render()` call that would silently pass
  // without ever actually clipping anything.
  test("leaves a short string untouched", () => {
    expect(capSection("short")).toBe("short")
  })

  test("clips a string past the cap to exactly MAX_SECTION_CHARS", () => {
    const long = "x".repeat(MAX_SECTION_CHARS + 500)
    const out = capSection(long)
    expect(out.length).toBe(MAX_SECTION_CHARS)
    expect(out).toBe("x".repeat(MAX_SECTION_CHARS))
  })

  test("a string exactly at the cap is left untouched (boundary)", () => {
    const exact = "x".repeat(MAX_SECTION_CHARS)
    expect(capSection(exact)).toBe(exact)
    expect(capSection(exact).length).toBe(MAX_SECTION_CHARS)
  })
})

test("render() output for realistic inputs stays comfortably under MAX_SECTION_CHARS without needing to clip", () => {
  // inertWorkspaceName caps the name to 80 code points, so even a pathological name
  // produces a bound section well inside the ceiling — documents that the cap in
  // capSection() is defense in depth, not something normal traffic relies on.
  const outcome: BindingOutcome = {
    status: "bound",
    binding: {
      datamateId: 1,
      datamateName: "x".repeat(5000),
      repoRemote: null,
      projectPath: "/tmp/proj",
      linkedAt: 0,
    },
  }
  const out = render(outcome)
  expect(out.length).toBeLessThan(MAX_SECTION_CHARS)
  // The 5000-char input was sanitized down (inertWorkspaceName's 80-code-point cap),
  // not passed through — proves the name really was bounded, not coincidentally short.
  expect(out.length).toBeLessThan(1000)
})
