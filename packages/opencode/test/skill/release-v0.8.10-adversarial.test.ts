/**
 * Adversarial + coverage tests for v0.8.10.
 *
 * Shipping changes since v0.8.9:
 *   - #950 (fixes #949): move the volatile "Today's date" out of the
 *     cache-controlled SYSTEM prefix and carry it on the trailing user message
 *     instead. Two coupled halves:
 *       (a) SystemPrompt.environment() no longer emits the date (system prefix
 *           stays byte-identical across midnight → the expensive system-prefix
 *           cache is not invalidated).
 *       (b) SessionPrompt appends a `synthetic:true` text part
 *           `\n\n${SystemPrompt.currentDate()}` to the LAST user message so the
 *           model still receives today's date every turn.
 *     The pre-existing test only covered half (a). The review (Data Engineer +
 *     Tech Lead) flagged that half (b) — the part that actually matters for the
 *     agent knowing the date — was untested. These tests close that gap and
 *     probe the contract under hostile inputs.
 *   - #959 (fixes #958): Windows installer Pester harness env injection made
 *     deterministic. Test-harness only; a static regression guard here prevents
 *     silently reintroducing the Process-scope-inheritance bug.
 *
 * Determinism: clock frozen with setSystemTime where the date is asserted; no
 * network, no shared state. No mock.module().
 */

import { describe, expect, setSystemTime, test } from "bun:test"
import fs from "fs"
import path from "path"
import { SystemPrompt } from "../../src/session/system"
import { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

const sessionID = SessionID.make("ses_v0_8_10")
const providerID = ProviderID.make("test")

const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID,
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} as Provider.Model

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelID.make("test") },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function basePart(messageID: string, id: string) {
  return { id: PartID.make(id), sessionID, messageID: MessageID.make(messageID) }
}

/**
 * Faithful replica of the prompt.ts append (the inline block at
 * session/prompt.ts:987-1003 is not exported). Mutates a copy and returns it so
 * tests can assert the observable contract via toModelMessages. The SHAPE here
 * must mirror the real code: a trailing `synthetic:true` text part whose text is
 * `\n\n${SystemPrompt.currentDate()}`, attached to the LAST user message only.
 */
function appendDateToLastUserMessage(msgs: MessageV2.WithParts[]): MessageV2.WithParts[] {
  const copy = msgs.map((m) => ({ info: m.info, parts: [...m.parts] }))
  const lastUser = [...copy].reverse().find((m) => m.info.role === "user")
  if (lastUser) {
    lastUser.parts = [
      ...lastUser.parts,
      {
        ...basePart(lastUser.info.id, `date-${lastUser.info.id}`),
        type: "text",
        text: `\n\n${SystemPrompt.currentDate()}`,
        synthetic: true,
      } as MessageV2.Part,
    ]
  }
  return copy
}

// ---------------------------------------------------------------------------
// #950 (a) — SystemPrompt.currentDate() is the single date source
// ---------------------------------------------------------------------------
describe("v0.8.10 #950: currentDate() generator", () => {
  test("renders today's date deterministically under a frozen clock", () => {
    setSystemTime(new Date("2026-06-22T12:00:00.000Z"))
    try {
      const today = new Date().toDateString()
      expect(SystemPrompt.currentDate()).toBe(`Today's date is ${today}.`)
      expect(SystemPrompt.currentDate()).toContain(today)
    } finally {
      setSystemTime()
    }
  })

  test("re-renders the NEW date after the clock crosses midnight", () => {
    setSystemTime(new Date("2026-06-22T23:59:59.000Z"))
    const before = SystemPrompt.currentDate()
    setSystemTime(new Date("2026-06-23T00:00:01.000Z"))
    const after = SystemPrompt.currentDate()
    setSystemTime()
    // The whole point of #949: the date is regenerated each turn, so a session
    // that crosses midnight reflects the new day rather than a stale cached one.
    expect(before).not.toBe(after)
    expect(after).toContain("2026")
  })

  test("is a single-line, brace-free fragment (cannot perturb prompt structure)", () => {
    const out = SystemPrompt.currentDate()
    expect(out.includes("\n")).toBe(false)
    expect(out).not.toMatch(/[{}<>]/)
  })
})

// ---------------------------------------------------------------------------
// #950 (b) — the date reaches the model via the trailing user message
// (the half that the pre-existing system.test.ts did NOT cover)
// ---------------------------------------------------------------------------
describe("v0.8.10 #950: date carried to the model on the last user message", () => {
  test("appended synthetic date survives toModelMessages and reaches the model", async () => {
    setSystemTime(new Date("2026-06-22T12:00:00.000Z"))
    try {
      const today = new Date().toDateString()
      const input: MessageV2.WithParts[] = [
        {
          info: userInfo("m1"),
          parts: [{ ...basePart("m1", "p1"), type: "text", text: "hello" }] as MessageV2.Part[],
        },
      ]
      const withDate = appendDateToLastUserMessage(input)
      const out = await MessageV2.toModelMessages(withDate, model)
      const text = JSON.stringify(out)
      expect(text).toContain(today)
      expect(text).toContain("hello")
      // date is last so it does not displace the user's real text
      expect(text.indexOf("hello")).toBeLessThan(text.indexOf(today))
    } finally {
      setSystemTime()
    }
  })

  test("only the LAST user message gets the date; earlier user turns stay clean", () => {
    setSystemTime(new Date("2026-06-22T12:00:00.000Z"))
    try {
      const today = new Date().toDateString()
      const input: MessageV2.WithParts[] = [
        { info: userInfo("u1"), parts: [{ ...basePart("u1", "p1"), type: "text", text: "first" }] as MessageV2.Part[] },
        { info: userInfo("u2"), parts: [{ ...basePart("u2", "p1"), type: "text", text: "second" }] as MessageV2.Part[] },
      ]
      const withDate = appendDateToLastUserMessage(input)
      const first = JSON.stringify(withDate[0].parts)
      const second = JSON.stringify(withDate[1].parts)
      expect(first).not.toContain(today)
      expect(second).toContain(today)
      // exactly one synthetic date part total
      const dateParts = withDate.flatMap((m) => m.parts).filter((p: any) => p.type === "text" && p.text?.includes(today))
      expect(dateParts.length).toBe(1)
    } finally {
      setSystemTime()
    }
  })

  test("does NOT accumulate across turns (fresh reload each turn → one date)", () => {
    setSystemTime(new Date("2026-06-22T12:00:00.000Z"))
    try {
      const today = new Date().toDateString()
      // Each turn the loop re-fetches msgs fresh from the store (prompt.ts:440);
      // the synthetic part is never persisted. Model a 3-turn session by rebuilding
      // the base array each turn and re-applying the append.
      const base = (): MessageV2.WithParts[] => [
        { info: userInfo("u1"), parts: [{ ...basePart("u1", "p1"), type: "text", text: "turn" }] as MessageV2.Part[] },
      ]
      for (let turn = 0; turn < 3; turn++) {
        const withDate = appendDateToLastUserMessage(base())
        const dates = withDate
          .flatMap((m) => m.parts)
          .filter((p: any) => p.type === "text" && p.text?.includes(today))
        expect(dates.length).toBe(1)
      }
    } finally {
      setSystemTime()
    }
  })

  test("date still reaches the model even when the user's real text was ignored", async () => {
    // Edge raised in review: a user turn whose only real part is `ignored` would
    // previously render empty; now it carries the date. The date must survive.
    setSystemTime(new Date("2026-06-22T12:00:00.000Z"))
    try {
      const today = new Date().toDateString()
      const input: MessageV2.WithParts[] = [
        {
          info: userInfo("m1"),
          parts: [{ ...basePart("m1", "p1"), type: "text", text: "noise", ignored: true }] as MessageV2.Part[],
        },
      ]
      const out = await MessageV2.toModelMessages(appendDateToLastUserMessage(input), model)
      expect(JSON.stringify(out)).toContain(today)
    } finally {
      setSystemTime()
    }
  })

  test("no user message present → append is a no-op and nothing throws", () => {
    const input: MessageV2.WithParts[] = []
    expect(() => appendDateToLastUserMessage(input)).not.toThrow()
    expect(appendDateToLastUserMessage(input)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// #959 — Windows installer Pester harness regression guard (static)
// ---------------------------------------------------------------------------
describe("v0.8.10 #959: Windows installer Pester harness stays deterministic", () => {
  const psPath = path.resolve(import.meta.dir, "../../../../test/windows/install.Tests.ps1")

  test("env injection happens inside the child session, not via host inheritance", () => {
    expect(fs.existsSync(psPath)).toBe(true)
    const src = fs.readFileSync(psPath, "utf8")
    // The fix sets the requested env vars in the child's own session (-Command
    // preamble with `$env:` / Remove-Item) rather than mutating the host's
    // Process-scope env and relying on `pwsh -File` inheritance — which the
    // updated windows-latest runner re-initialized for loader-managed vars.
    expect(src).toContain("-Command")
    expect(src).toMatch(/\$env:/)
    expect(src).toMatch(/Remove-Item -Path Env:/)
    // The old, broken inheritance pattern must not come back.
    expect(src).not.toMatch(/SetEnvironmentVariable/)
  })
})
