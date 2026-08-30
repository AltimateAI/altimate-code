// harness plan / item 2 — pin the original task verbatim through compaction.
// Pure-function unit tests: pin-source selection (mode-aware, incl. the
// mid-session-redirect case), verbatim/head+tail+contract-card assembly,
// dynamic budget math with the livelock invariant, and the livelock guard
// that halves the pin after two consecutive failed compactions.
import { beforeEach, describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionCompaction } from "../../src/session/compaction"
import { Token } from "@/util/token"
import type { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "@/provider/provider"

let seq = 0
function nextID() {
  seq += 1
  return `msg_${String(seq).padStart(6, "0")}`
}

function userMsg(text: string, opts: { synthetic?: boolean; compaction?: boolean } = {}): MessageV2.WithParts {
  const id = nextID()
  const parts: any[] = []
  if (opts.compaction) parts.push({ id: nextID(), messageID: id, sessionID: "ses_test", type: "compaction" })
  if (text)
    parts.push({
      id: nextID(),
      messageID: id,
      sessionID: "ses_test",
      type: "text",
      text,
      ...(opts.synthetic ? { synthetic: true } : {}),
    })
  return { info: { id, role: "user", sessionID: "ses_test" }, parts } as unknown as MessageV2.WithParts
}

function assistantMsg(opts: { summary?: boolean; finish?: string; error?: unknown } = {}): MessageV2.WithParts {
  const id = nextID()
  return {
    info: {
      id,
      role: "assistant",
      sessionID: "ses_test",
      summary: opts.summary,
      finish: opts.finish ?? "stop",
      error: opts.error,
    },
    parts: [],
  } as unknown as MessageV2.WithParts
}

function model(input: { context: number; input?: number; output?: number }): Provider.Model {
  return {
    limit: { context: input.context, input: input.input, output: input.output ?? 4_096 },
  } as unknown as Provider.Model
}

function cfg(compaction?: Record<string, unknown>) {
  return { compaction } as any
}

const TASK_RUN = "Build the orders model in models/marts/orders.sql and verify row counts."
const TASK_REDIRECT =
  "Stop working on orders. Instead rename the output file to final_report.csv and do not touch models/marts/orders.sql again."

function historyWithRedirect() {
  const first = userMsg(TASK_RUN)
  const a1 = assistantMsg()
  const redirect = userMsg(TASK_REDIRECT)
  const a2 = assistantMsg()
  const marker = userMsg("", { compaction: true })
  const summary = assistantMsg({ summary: true })
  const cont = userMsg("Continue if you have next steps.", { synthetic: true })
  return { history: [first, a1, redirect, a2, marker, summary, cont], first, redirect, summary, cont }
}

describe("selectPinSource — mode-aware pin selection", () => {
  test("run mode pins the FIRST non-synthetic user message", () => {
    const { history } = historyWithRedirect()
    const source = SessionPrompt.selectPinSource(history, true)
    expect(source?.text).toBe(TASK_RUN)
  })

  test("interactive pins the MOST RECENT substantive instruction (mid-session redirect)", () => {
    const { history, redirect } = historyWithRedirect()
    const source = SessionPrompt.selectPinSource(history, false)
    expect(source?.id).toBe(redirect.info.id)
    expect(source?.text).toBe(TASK_REDIRECT)
  })

  test("interactive acknowledgements never replace the latest task-bearing instruction", () => {
    for (const acknowledgement of ["yes", "continue", "looks good", "Go ahead."]) {
      const task = userMsg(TASK_REDIRECT)
      const ack = userMsg(acknowledgement)
      expect(SessionPrompt.selectPinSource([task, ack], false)?.id).toBe(task.info.id)
    }
    expect(SessionPrompt.selectPinSource([userMsg("yes"), userMsg("continue")], false)).toBeUndefined()
  })

  test("run mode skips a leading acknowledgement and pins the first actual task", () => {
    const task = userMsg(TASK_RUN)
    expect(SessionPrompt.selectPinSource([userMsg("okay"), task], true)?.id).toBe(task.info.id)
  })

  test("synthetic-only and compaction-marker user messages are never pin sources", () => {
    const { history, cont } = historyWithRedirect()
    // interactive: latest substantive is the redirect, NOT the synthetic continue msg
    const source = SessionPrompt.selectPinSource(history, false)
    expect(source?.id).not.toBe(cont.info.id)
    // a history of only synthetic/marker messages yields no pin
    const empty = SessionPrompt.selectPinSource(
      [userMsg("", { compaction: true }), userMsg("continue", { synthetic: true })],
      false,
    )
    expect(empty).toBeUndefined()
  })

  test("framework-generated validator retries cannot replace the user's task pin", () => {
    const task = userMsg("Fix the checkout race and add a regression test.")
    const validatorRetry = userMsg("[altimate-validator: tests] validation failed", { synthetic: true })
    expect(SessionPrompt.selectPinSource([task, validatorRetry], false)?.id).toBe(task.info.id)
  })

  test("empty history yields no pin", () => {
    expect(SessionPrompt.selectPinSource([], true)).toBeUndefined()
  })
})

describe("taskPinText — compaction-gated assembly", () => {
  test("mid-session redirect: after compaction the interactive pin reflects the LATER instruction", () => {
    const { history, summary, cont } = historyWithRedirect()
    const visible = [summary, cont]
    const pin = SessionPrompt.taskPinText({
      history,
      visible,
      runMode: false,
      capTokens: 4_096,
      cardCapTokens: 500,
    })
    expect(pin).toBeDefined()
    expect(pin!).toContain("Original task — authoritative over any summary")
    expect(pin!).toContain(TASK_REDIRECT)
    expect(pin!).not.toContain(TASK_RUN)
  })

  test("run mode pins the ORIGINAL first task through the same compaction", () => {
    const { history, summary, cont } = historyWithRedirect()
    const pin = SessionPrompt.taskPinText({
      history,
      visible: [summary, cont],
      runMode: true,
      capTokens: 4_096,
      cardCapTokens: 500,
    })
    expect(pin).toBeDefined()
    expect(pin!).toContain(TASK_RUN)
  })

  test("skipped while the pin source is still visible verbatim in context", () => {
    const { history, redirect, summary, cont } = historyWithRedirect()
    const pin = SessionPrompt.taskPinText({
      history,
      visible: [redirect, summary, cont],
      runMode: false,
      capTokens: 4_096,
      cardCapTokens: 500,
    })
    expect(pin).toBeUndefined()
  })

  test("zero budget yields no pin", () => {
    const { history, summary, cont } = historyWithRedirect()
    const pin = SessionPrompt.taskPinText({
      history,
      visible: [summary, cont],
      runMode: true,
      capTokens: 0,
      cardCapTokens: 500,
    })
    expect(pin).toBeUndefined()
  })

  // altimate_change start — PR #1171 review (codex + cubic, two threads): the
  // `<system-reminder>` framing was added AFTER buildPinnedTask had spent the
  // whole cap, so the rendered pin exceeded the advertised hard cap and ate the
  // reserved working headroom the pin invariant depends on.
  test("the rendered pin — framing included — stays inside capTokens", () => {
    const { history, summary, cont } = historyWithRedirect()
    for (const capTokens of [200, 500, 1_000, 4_096]) {
      const pin = SessionPrompt.taskPinText({
        history,
        visible: [summary, cont],
        runMode: true,
        capTokens,
        cardCapTokens: 500,
      })
      if (!pin) continue
      expect(Token.estimate(pin)).toBeLessThanOrEqual(capTokens)
    }
  })

  test("a cap smaller than the framing itself yields no pin rather than an over-budget one", () => {
    const { history, summary, cont } = historyWithRedirect()
    const pin = SessionPrompt.taskPinText({
      history,
      visible: [summary, cont],
      runMode: true,
      capTokens: 5,
      cardCapTokens: 500,
    })
    expect(pin).toBeUndefined()
  })
  // altimate_change end
})

describe("buildPinnedTask — verbatim under cap, head+tail + contract card over cap", () => {
  const filler = Array.from({ length: 400 }, (_, i) => `Background paragraph ${i} with routine detail.`).join(" ")
  const longTask = [
    "Rebuild the daily channel sales mart.",
    `Output MUST go to reports/final_output.csv and the model lives in models/marts/fct_daily_channel_sales.sql.`,
    filler,
    "Use the column customer_lifetime_value and run `make verify` after every change.",
    'Do not modify the "legacy_billing" schema under any circumstances.',
    filler,
    "Finish by summarizing results.",
  ].join("\n")

  test("under cap: text is pinned verbatim, unmodified", () => {
    const out = SessionPrompt.buildPinnedTask({ text: TASK_RUN, capTokens: 4_096, cardCapTokens: 500 })
    expect(out).toBe(TASK_RUN)
  })

  test("over cap: verbatim head + tail, budget respected, contract card preserves mid-task literals", () => {
    const cap = 1_000
    expect(Token.estimate(longTask)).toBeGreaterThan(cap)
    const out = SessionPrompt.buildPinnedTask({ text: longTask, capTokens: cap, cardCapTokens: 500 })
    expect(out).toBeDefined()
    expect(Token.estimate(out!)).toBeLessThanOrEqual(cap)
    // verbatim head and tail
    expect(out!.startsWith("Rebuild the daily channel sales mart.")).toBe(true)
    expect(out!).toContain("truncated")
    // mid-task literals that middle-truncation alone would delete survive in the card
    expect(out!).toContain("Contract card")
    expect(out!).toContain("fct_daily_channel_sales")
    expect(out!).toContain("final_output.csv")
  })

  test("contract card entries are verbatim substrings of the task — never paraphrased", () => {
    const card = SessionPrompt.extractContractCard(longTask, 500)
    expect(card).not.toBe("")
    expect(Token.estimate(card)).toBeLessThanOrEqual(500)
    for (const line of card.split("\n").slice(1)) {
      const body = line
        .replace(/^- (files\/paths|identifiers|code\/commands|quoted terms): /, "")
        .replace(/^- constraints \(verbatim lines\):$/, "")
        .replace(/^ {2}- /, "")
      if (!body) continue
      for (const item of body.split(", ")) {
        if (!item) continue
        expect(longTask).toContain(item)
      }
    }
  })

  test("contract card is deterministic and extracts all literal families", () => {
    const a = SessionPrompt.extractContractCard(longTask, 500)
    const b = SessionPrompt.extractContractCard(longTask, 500)
    expect(a).toBe(b)
    expect(a).toContain("reports/final_output.csv")
    expect(a).toContain("customer_lifetime_value")
    expect(a).toContain("make verify")
    expect(a).toContain("legacy_billing")
    expect(a).toContain('Do not modify the "legacy_billing" schema under any circumstances.')
  })

  test("contract card respects a tiny cap by tail-truncating", () => {
    const tiny = SessionPrompt.extractContractCard(longTask, 30)
    expect(Token.estimate(tiny)).toBeLessThanOrEqual(30)
  })
})

describe("pinBudget — dynamic cap min(4k, fraction × usable) with the livelock invariant", () => {
  beforeEach(() => SessionCompaction.resetPinState())

  test("large window: capped at PIN_MAX_TOKENS (4k)", () => {
    // context 200k, default headroom 20k, safety fraction 0.65 → effective
    // threshold 110k; fraction cap 19,250 and invariant cap 108k → min is 4096.
    const budget = SessionCompaction.pinBudget({ cfg: cfg(), model: model({ context: 200_000, output: 8_192 }) })
    expect(budget).toBe(SessionCompaction.PIN_MAX_TOKENS)
  })

  test("mid window: fraction of the effective threshold wins over 4k", () => {
    // context 16k, output 2k, reserved 2k (config) → headroom 2k; effective
    // threshold min(14k, max(floor(16k × 0.65) − 2k, 4k)) = 8,400;
    // fraction cap floor(8,400 × 0.175) = 1,470; invariant cap 8,400 − 2k − 2k = 4,400.
    const threshold = SessionCompaction.overflowThreshold({ base: 16_000, headroom: 2_000, fraction: 0.65 })
    expect(threshold).toBe(8_400)
    const budget = SessionCompaction.pinBudget({
      cfg: cfg({ reserved: 2_000 }),
      model: model({ context: 16_000, output: 2_000 }),
    })
    expect(budget).toBe(Math.floor(threshold * SessionCompaction.PIN_WINDOW_FRACTION))
    expect(budget).toBeLessThan(SessionCompaction.PIN_MAX_TOKENS)
  })

  test("pin capacity comes from the SAME threshold isOverflow uses — 65,536/20,000 boundary case", () => {
    // context 65,536, reserved 20,000, output 8,192 → headroom 20,000.
    // Estimate-domain boundary: min(45,536, max(floor(65,536 × 0.65) − 20,000, 4,000)) = 22,598.
    // The threshold ALREADY excludes the reserved headroom, so the invariant is
    // pin + working slack < threshold (subtracting reserved again double-counted
    // it and shrank the pin to 598 here): fraction cap floor(22,598 × 0.175) =
    // 3,954 binds, below both PIN_MAX_TOKENS and the invariant cap 20,598.
    const threshold = SessionCompaction.overflowThreshold({ base: 65_536, headroom: 20_000, fraction: 0.65 })
    expect(threshold).toBe(22_598)
    const budget = SessionCompaction.pinBudget({ cfg: cfg(), model: model({ context: 65_536, output: 8_192 }) })
    expect(budget).toBe(Math.floor(threshold * SessionCompaction.PIN_WINDOW_FRACTION))
    // The livelock invariant holds against the ACTUAL trigger.
    expect(budget + SessionCompaction.PIN_WORKING_SLACK).toBeLessThanOrEqual(threshold)
  })

  test("small window: the invariant still admits a small pin instead of silently zeroing it", () => {
    // context 32k, output 4k → reserved default 20k, estimate-domain threshold
    // 4,000 (floor). Invariant cap 4,000 − 2,000 = 2,000; fraction cap
    // floor(4,000 × 0.175) = 700 binds. The old double-subtract arithmetic
    // (threshold − reserved − slack < 0) forced 0 on every window this size.
    const threshold = SessionCompaction.overflowThreshold({ base: 32_000, headroom: 20_000, fraction: 0.65 })
    const budget = SessionCompaction.pinBudget({ cfg: cfg(), model: model({ context: 32_000, output: 4_096 }) })
    expect(budget).toBe(Math.floor(threshold * SessionCompaction.PIN_WINDOW_FRACTION))
    expect(budget + SessionCompaction.PIN_WORKING_SLACK).toBeLessThanOrEqual(threshold)
  })

  test("degenerate window: pin is 0 when even slack exceeds the threshold (skip, never violate)", () => {
    // Force a threshold at/below the working slack via a tiny explicit reserved
    // buffer and window: base 5,000, reserved 4,000 → threshold min(1,000, …)
    // <= PIN_WORKING_SLACK → invariant cap <= 0 → no pin fits.
    const budget = SessionCompaction.pinBudget({
      cfg: cfg({ reserved: 4_000 }),
      model: model({ context: 5_000, output: 500 }),
    })
    expect(budget).toBe(0)
  })

  test("config overrides: pin_task=false disables; pin_max_tokens respected", () => {
    const m = model({ context: 200_000, output: 8_192 })
    expect(SessionCompaction.pinBudget({ cfg: cfg({ pin_task: false }), model: m })).toBe(0)
    expect(SessionCompaction.pinBudget({ cfg: cfg({ pin_max_tokens: 1_024 }), model: m })).toBe(1_024)
  })

  test("zero-context model yields no pin", () => {
    expect(SessionCompaction.pinBudget({ cfg: cfg(), model: model({ context: 0 }) })).toBe(0)
  })
})

describe("livelock guard — two consecutive failed compactions halve the pin", () => {
  beforeEach(() => SessionCompaction.resetPinState())
  const SID = "ses_livelock"

  function immediateRefire() {
    // a completed summary followed by only ONE finished non-summary assistant:
    // the previous compaction did not get the session below threshold.
    return [assistantMsg({ summary: true }), userMsg("continue", { synthetic: true }), assistantMsg()]
  }

  function normalProgress() {
    return [
      assistantMsg({ summary: true }),
      userMsg("continue", { synthetic: true }),
      assistantMsg(),
      assistantMsg(),
      assistantMsg(),
    ]
  }

  test("first compaction of a session never counts as a failure", () => {
    SessionCompaction.notePinCompaction(SID, [userMsg(TASK_RUN), assistantMsg()] as any)
    expect(SessionCompaction.pinScale(SID)).toBe(1)
  })

  test("two consecutive immediate re-fires halve the pin; budget scales down", () => {
    SessionCompaction.notePinCompaction(SID, immediateRefire() as any)
    expect(SessionCompaction.pinScale(SID)).toBe(1)
    SessionCompaction.notePinCompaction(SID, immediateRefire() as any)
    expect(SessionCompaction.pinScale(SID)).toBe(0.5)
    const budget = SessionCompaction.pinBudget({
      cfg: cfg(),
      model: model({ context: 200_000, output: 8_192 }),
      sessionID: SID,
    })
    expect(budget).toBe(SessionCompaction.PIN_MAX_TOKENS / 2)
  })

  test("a compaction after real progress resets the consecutive-failure count", () => {
    SessionCompaction.notePinCompaction(SID, immediateRefire() as any)
    SessionCompaction.notePinCompaction(SID, normalProgress() as any)
    SessionCompaction.notePinCompaction(SID, immediateRefire() as any)
    expect(SessionCompaction.pinScale(SID)).toBe(1)
  })

  test("further failure pairs keep halving; state is per-session", () => {
    for (let i = 0; i < 4; i++) SessionCompaction.notePinCompaction(SID, immediateRefire() as any)
    expect(SessionCompaction.pinScale(SID)).toBe(0.25)
    expect(SessionCompaction.pinScale("ses_other")).toBe(1)
  })

  // altimate_change start — PR #1171 review (codex P2 / cubic P2, two threads):
  // production never removed a pinState entry, so a long-lived server kept one
  // per session that ever compacted. Bounded LRU now, matching the starvation
  // and nudge stores added in the same change.
  test("the livelock map is bounded and evicts the LEAST-RECENTLY-USED session", () => {
    const prefix = "ses_pin_lru_"
    // Fill the table with distinct sessions.
    for (let i = 0; i < 128; i++) {
      SessionCompaction.notePinCompaction(`${prefix}${i}`, immediateRefire() as any)
      SessionCompaction.notePinCompaction(`${prefix}${i}`, immediateRefire() as any)
    }
    // Every one of them halved; reading the oldest entry refreshes its LRU age.
    expect(SessionCompaction.pinScale(`${prefix}0`)).toBe(0.5)
    // A new session evicts #1 (now the LRU), not #0.
    SessionCompaction.notePinCompaction(`${prefix}new`, immediateRefire() as any)
    expect(SessionCompaction.pinScale(`${prefix}0`)).toBe(0.5)
    expect(SessionCompaction.pinScale(`${prefix}1`)).toBe(1)
  })
  // altimate_change end
})

describe("summary-template addition", () => {
  test("is an addition constant, phrased as do-not-restate + pinned-task authority", () => {
    expect(SessionCompaction.PIN_SUMMARY_ADDITION).toContain("Do NOT restate")
    expect(SessionCompaction.PIN_SUMMARY_ADDITION).toContain("pinned")
    expect(SessionCompaction.PIN_SUMMARY_ADDITION).toContain("authoritative")
  })
})

describe("resolvePinRunMode — explicit run-mode value wins over the legacy fallback", () => {
  test("explicit ALTIMATE_RUN_MODE=0 wins even when ALTIMATE_NON_INTERACTIVE=1", () => {
    expect(SessionPrompt.resolvePinRunMode({ ALTIMATE_RUN_MODE: "0", ALTIMATE_NON_INTERACTIVE: "1" })).toBe(false)
  })

  test("explicit ALTIMATE_RUN_MODE=1 wins regardless of the fallback", () => {
    expect(SessionPrompt.resolvePinRunMode({ ALTIMATE_RUN_MODE: "1" })).toBe(true)
    expect(SessionPrompt.resolvePinRunMode({ ALTIMATE_RUN_MODE: "1", ALTIMATE_NON_INTERACTIVE: "0" })).toBe(true)
  })

  test("legacy fallback applies only when the marker is undefined or blank", () => {
    expect(SessionPrompt.resolvePinRunMode({ ALTIMATE_NON_INTERACTIVE: "1" })).toBe(true)
    expect(SessionPrompt.resolvePinRunMode({ ALTIMATE_RUN_MODE: "  ", ALTIMATE_NON_INTERACTIVE: "1" })).toBe(true)
    expect(SessionPrompt.resolvePinRunMode({})).toBe(false)
  })

  // `run --continue` / `--session` / `--fork` resume a session whose first user
  // message belongs to an EARLIER invocation. Run-mode selection would pin that
  // stale request as authoritative over the summary and the current prompt.
  test("a resumed run falls back to interactive selection", () => {
    expect(SessionPrompt.resolvePinRunMode({ ALTIMATE_RUN_MODE: "1", ALTIMATE_RUN_RESUMED: "1" })).toBe(false)
    expect(SessionPrompt.resolvePinRunMode({ ALTIMATE_NON_INTERACTIVE: "1", ALTIMATE_RUN_RESUMED: "1" })).toBe(false)
  })

  test("a fresh run is unaffected", () => {
    expect(SessionPrompt.resolvePinRunMode({ ALTIMATE_RUN_MODE: "1" })).toBe(true)
  })
})

describe("selectPinSource — resumed run sessions", () => {
  test("interactive selection picks this run's task, not the previous run's", () => {
    // A session resumed with `run --continue "<new task>"`: the earlier
    // invocation's task is still message #1.
    const previous = userMsg("Previous run: migrate the staging schema.")
    const current = userMsg("This run: add regression tests for the migration.")
    const history = [previous, current]
    // Run-mode selection would hand back the completed previous task.
    expect(SessionPrompt.selectPinSource(history, true)?.id).toBe(previous.info.id)
    // The resumed path resolves runMode=false and gets the current request.
    const source = SessionPrompt.selectPinSource(history, false)
    expect(source?.id).toBe(current.info.id)
    expect(source?.text).toContain("regression tests")
  })
})
