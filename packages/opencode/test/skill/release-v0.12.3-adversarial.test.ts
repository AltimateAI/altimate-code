/**
 * Adversarial coverage for the v0.12.3 release payload (v0.12.2..HEAD): the Altimate Base
 * no-consent-gate PR (#1361, 429/49 tests of its own — see the entrypoint-late-notice-wiring
 * pin) plus the routing-pin fix, PLUS the two P0s and P1 found by this release's own
 * multi-persona review and fixed here:
 *
 *  - `altimate agent create` and `altimate review` never called `FreeTier.autoRegisterWithin()`
 *    before resolving a provider (Chaos Gremlin/Support Engineer persona, both P0): a fresh
 *    install's first `agent create` or `review` run failed with a raw upstream error / silently
 *    produced zero AI findings, because no provider had ever been registered.
 *  - `tui.ts`'s up-to-3s auto-register wait gave zero terminal feedback on a fresh install
 *    (End User persona, P1): reads as a hang on the very first launch.
 *
 * This file does NOT re-test PR #1361's own extensive coverage (stale-zen-cycle,
 * altimate-base-auto-register, altimate-base-headless-disclosure, routing-pin, etc. — all
 * re-run and confirmed green during this release's Step 5/5c). It targets only the NEW code
 * from this release's fixes, following the source-assertion pattern already established in
 * test/altimate/entrypoint-late-notice-wiring.test.ts for these same Effect-based / heavy CLI
 * command files.
 */
import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { join, resolve } from "path"

const cmdDir = resolve(import.meta.dir, "..", "..", "src", "cli", "cmd")

function read(file: string): string {
  return readFileSync(join(cmdDir, file), "utf-8")
}

describe("v0.12.3: agent.ts / review.ts auto-register ordering", () => {
  test("agent.ts registers Altimate Base BEFORE resolving/calling Agent.generate", () => {
    const source = read("agent.ts")
    const registerIdx = source.indexOf("autoRegisterWithin(")
    const generateIdx = source.indexOf("agentSvc.generate(")
    expect(registerIdx, "agent.ts must call autoRegisterWithin()").toBeGreaterThan(-1)
    expect(generateIdx, "agent.ts must call agentSvc.generate()").toBeGreaterThan(-1)
    // Registering AFTER the model/provider is already being resolved defeats the fix: a fresh
    // install would still hit the unregistered path on its first LLM call.
    expect(registerIdx, "registration must precede the generate() call, not follow it").toBeLessThan(generateIdx)
  })

  test("agent.ts's registration call is not swallowed inside the generate() error handler", () => {
    const source = read("agent.ts")
    // The existing `.catch((error) => { spinner.stop(...) ... })` on agentSvc.generate() must
    // stay scoped to the generate call only — folding registration into that same try/catch
    // would mask a registration failure as a generic "LLM failed to generate agent" message.
    const catchIdx = source.indexOf(".catch((error) => {")
    const registerIdx = source.indexOf("autoRegisterWithin(")
    expect(catchIdx, "the existing generate() catch handler must still be present").toBeGreaterThan(-1)
    expect(registerIdx).toBeLessThan(catchIdx)
  })

  test("review.ts registers Altimate Base BEFORE reviewPullRequest AND outside the latency timer", () => {
    const source = read("review.ts")
    const registerIdx = source.indexOf("autoRegisterWithin(")
    const reviewCallIdx = source.indexOf("await reviewPullRequest({")
    const timerIdx = source.indexOf("const startedAt = Date.now()")
    expect(registerIdx, "review.ts must call autoRegisterWithin()").toBeGreaterThan(-1)
    expect(reviewCallIdx, "review.ts must call reviewPullRequest()").toBeGreaterThan(-1)
    expect(timerIdx, "review.ts must still time the engine via startedAt").toBeGreaterThan(-1)
    expect(registerIdx, "registration must precede the review call").toBeLessThan(reviewCallIdx)
    // A registration wait folded into the timed region would inflate every review_run latency
    // metric on a fresh install (or after a credential rotation) with startup cost that has
    // nothing to do with the review engine itself.
    expect(registerIdx, "registration must be excluded from the engine latency timer").toBeLessThan(timerIdx)
  })

  test("review.ts's registration call runs even when --no-ai is set (matches R1: registers regardless of the caller's own model)", () => {
    const source = read("review.ts")
    const registerIdx = source.indexOf("autoRegisterWithin(")
    const noAiCheckIdx = source.indexOf("noAi:")
    expect(registerIdx).toBeGreaterThan(-1)
    // The registration call must be unconditional — not gated behind `!args.noAi` — so the
    // CI `--post --mode gate` deterministic-only path still benefits the NEXT invocation that
    // does use the AI lane. Asserted by requiring no `noAi`/`args.ai` reference appears between
    // the register call and its own closing brace.
    const blockEnd = source.indexOf("// altimate_change end", registerIdx)
    const between = source.slice(registerIdx, blockEnd)
    expect(between, "the registration block must not branch on noAi/args.ai").not.toMatch(/noAi|args\.ai\b/)
    expect(noAiCheckIdx).toBeGreaterThan(blockEnd)
  })
})

describe("v0.12.3: tui.ts startup-feedback timer", () => {
  function readTui(): string {
    return readFileSync(join(cmdDir, "tui.ts"), "utf-8")
  }

  test("the feedback timer is gated behind a short, non-zero delay (never fires instantly)", () => {
    const source = readTui()
    const match = source.match(/setTimeout\(\(\) => UI\.println\("Connecting to Altimate Base…"\), (\d+)\)/)
    expect(match, "tui.ts must set a delayed status line before autoRegisterWithin()").not.toBeNull()
    const delayMs = Number(match![1])
    // Zero (or missing) would flash on every launch, including the fast/already-registered
    // path this delay exists to protect; too long would defeat the "no feedback during a
    // fresh-install hang" fix End User flagged. Bounded to a sane window around the ~250-300ms
    // suggestion rather than pinned to one exact value.
    expect(delayMs).toBeGreaterThan(0)
    expect(delayMs).toBeLessThanOrEqual(500)
  })

  test("the feedback timer is always cleared, even if autoRegisterWithin() throws", () => {
    const source = readTui()
    const start = source.indexOf("const registerFeedback = setTimeout(")
    expect(start, "must find the registerFeedback timer declaration").toBeGreaterThan(-1)
    const scope = source.slice(start, start + 400)
    // Must be a try/finally around the await, not a bare await — a throw from
    // autoRegisterWithin() (it currently never throws, but must not be relied upon) would
    // otherwise leak the timer and could still print the status line after the process is
    // already tearing down.
    expect(scope).toMatch(/try\s*\{[\s\S]*?await FreeTier\.autoRegisterWithin\(\)[\s\S]*?\}\s*finally\s*\{[\s\S]*?clearTimeout\(registerFeedback\)/)
  })

  test("autoRegisterWithin() is still called with no arguments in tui.ts (unchanged contract: TUI renders its own onboarding, no headless callback)", () => {
    const source = readTui()
    // Regression guard: wrapping the call in a delayed-feedback block must not have also,
    // accidentally, started passing a headless disclosure callback — the TUI's own
    // useAltimateBaseDisclosureNotice() owns that surface; a second notice source here would
    // double-print.
    expect(source).toMatch(/await FreeTier\.autoRegisterWithin\(\)\s*$/m)
  })
})
