import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"

const ROOT = path.resolve(__dirname, "../../../")

// Regression guards for the trace-clearing-on-workspace-set bug.
//
// Bug shape (full chain):
//
//   1. SolidJS createEffect in `routes/session/index.tsx` watches
//      `session()?.workspaceID` but re-runs on every `session()` signal change
//      (message count, status, parts updated, …) — including the cascade at
//      agent-finish.
//   2. Each fire calls `sdk.setWorkspace(workspaceID)` via RPC.
//   3. `worker.setWorkspace` unconditionally calls `startEventStream`.
//   4. `startEventStream` calls `endTrace()` on every entry in `sessionTraces`
//      (fire-and-forget) and then `sessionTraces.clear()`.
//   5. On the next event for the same session, `getOrCreateTrace(sessionID)`
//      hits a cache miss, calls `Trace.create()` + `startTrace(sessionID, {})`,
//      which pushes a single root span into a freshly-empty `this.spans`.
//      `startTrace` then writes a snapshot — overwriting the rich on-disk trace
//      with a near-empty one.
//
// Observable: `/traces` waterfall view collapses to just the system-prompt
// span after every agent-finish.
//
// Two fixes lock the contract here:
//   - `worker.setWorkspace` is now idempotent on unchanged workspaceID.
//   - `createEffect` in `routes/session/index.tsx` uses `on(...)` so it only
//     fires when the projected `workspaceID` actually changes.

describe("trace-clearing-on-workspace-set regression", () => {
  test("worker.setWorkspace short-circuits when workspaceID is unchanged", async () => {
    const workerSrc = await fs.readFile(path.join(ROOT, "src/cli/cmd/tui/worker.ts"), "utf-8")

    // A `currentWorkspaceID` tracker is declared at module scope.
    expect(workerSrc).toMatch(/let currentWorkspaceID:\s*string\s*\|\s*undefined/)

    // The setWorkspace handler must guard on equality with the tracker before
    // calling startEventStream. Match either a strict-equality early return or
    // the same pattern wrapped in a block.
    expect(workerSrc).toMatch(
      /async setWorkspace\(input: \{ workspaceID\?: string \}\)\s*\{[\s\S]{0,400}if \(input\.workspaceID === currentWorkspaceID\) return/,
    )

    // After the guard, the tracker must be updated to the new value, otherwise
    // a subsequent same-value call wouldn't short-circuit.
    expect(workerSrc).toMatch(
      /if \(input\.workspaceID === currentWorkspaceID\) return\s*\n\s*currentWorkspaceID = input\.workspaceID/,
    )
  })

  test("session route's workspaceID effect uses `on()` so it only fires when workspaceID actually changes", async () => {
    const routeSrc = await fs.readFile(path.join(ROOT, "src/cli/cmd/tui/routes/session/index.tsx"), "utf-8")

    // The previous shape (`createEffect(() => { if (session()?.workspaceID) ... })`)
    // re-runs on every session() signal change. The fixed shape uses `on()` with
    // an explicit projector returning workspaceID, so SolidJS dirty-tracks only
    // that value.
    expect(routeSrc).toMatch(/createEffect\(\s*on\(\s*\(\)\s*=>\s*session\(\)\?\.workspaceID/)

    // Reject the three bug-equivalent spellings the reviewers flagged. Each
    // pattern is bounded so it can't span across unrelated createEffect bodies
    // elsewhere in the file (the route file has many createEffects).
    //
    // Inline expression: `createEffect(() => session()?.workspaceID && ...)`
    // Inline ternary:    `createEffect(() => session()?.workspaceID ? ... : ...)`
    expect(routeSrc).not.toMatch(/createEffect\(\s*\(\s*\)\s*=>\s*session\(\)\?\.workspaceID\s*[&?]/)
    // Block body with `if (session()?.workspaceID)` — `[^{}]*?` prevents the
    // match from crossing into other blocks.
    expect(routeSrc).not.toMatch(/createEffect\(\s*\(\s*\)\s*=>\s*\{[^{}]*?if\s*\(session\(\)\?\.workspaceID/)
  })

  // The real root cause: a session.status=idle handler that called endTrace +
  // sessionTraces.delete after every turn. `idle` fires on busy→idle transition
  // (i.e. after every agent turn finishes), not at session-end. Each fire
  // destroyed the Trace instance; the next event in a later turn forced a fresh
  // Trace.create() whose 1-span initial snapshot clobbered the rich on-disk
  // trace. Also explains the "What was asked / No prompt recorded" symptom —
  // metadata.prompt was captured on the destroyed instance, never on the
  // replacement. The handler is now a no-op; finalization happens on worker
  // shutdown and MAX_TRACES eviction only.
  test("worker does NOT call endTrace+delete on session.status=idle", async () => {
    // Idle handling lives in the shared TraceConsumer now; the destructive
    // shape must not exist there (nor anywhere the worker delegates).
    const workerSrc = await fs.readFile(path.join(ROOT, "src/cli/cmd/tui/worker.ts"), "utf-8")
    const consumerSrc = await fs.readFile(path.join(ROOT, "src/altimate/observability/trace-consumer.ts"), "utf-8")

    // The destructive shape must not exist in either file.
    for (const src of [workerSrc, consumerSrc]) {
      expect(src).not.toMatch(/status === "idle"[\s\S]{0,200}sessionTraces\.delete/)
      expect(src).not.toMatch(/status === "idle"[\s\S]{0,200}trace\.endTrace\(\)/)
    }
  })

  // Defense-in-depth: `getOrCreateTrace` on cache miss must try to load an
  // existing on-disk trace before falling back to startTrace. Otherwise a
  // worker restart or MAX_TRACES eviction recreates the trace empty and
  // the next snapshot clobbers the rich file.
  test("getOrCreateTrace prefers rehydrateFromFile over startTrace on cache miss", async () => {
    // The per-session trace logic was extracted into the shared TraceConsumer
    // (so `altimate serve` traces too); the worker delegates to it.
    const workerSrc = await fs.readFile(path.join(ROOT, "src/altimate/observability/trace-consumer.ts"), "utf-8")
    // `rehydrateFromFile` is async (off-loads disk I/O from the event-stream
    // hot path per cubic P2 review on tracing.ts:515) so the call must be
    // awaited inside getOrCreateTrace.
    expect(workerSrc).toMatch(
      /if \(!\(await trace\.rehydrateFromFile\(sessionID\)\)\)\s*\{\s*\n\s*trace\.startTrace\(sessionID, \{\}\)\s*\n\s*\}/,
    )
  })

  // User-text-part branch must accept parts that have no `time.end` (user input
  // never has a meaningful processing-end) and must capture the prompt via
  // `setPrompt` — NOT `setTitle`. Otherwise the user text races the
  // title-agent's auto-generated title from `session.updated` and overwrites
  // it (e.g. "Greeting" → "hi"). See codex review feedback this round.
  test("user text part is captured via setPrompt, drops time.end precondition, never touches title", async () => {
    const workerSrc = await fs.readFile(path.join(ROOT, "src/altimate/observability/trace-consumer.ts"), "utf-8")

    // The old shape gated on `part.time?.end` for the entire user/assistant
    // branch — that shape must not be present anymore, because user-input
    // parts never have `time.end` set.
    expect(workerSrc).not.toMatch(/if \(part\.type === "text" && part\.time\?\.end\)/)

    // Broader guard: no `part.time?.end` check is permitted INSIDE the
    // user-text branch (identified by `sessionUserMsgIds.get(...).has(...)`).
    // Catches a nested `if (part.time?.end)` shape that would re-introduce
    // the same drop.
    expect(workerSrc).not.toMatch(
      /sessionUserMsgIds\.get\(part\.sessionID\)\?\.has\(part\.messageID\)[\s\S]{0,400}part\.time\?\.end/,
    )

    // The user-text branch must call setPrompt (not setTitle) so the auto-
    // generated session title from Path C isn't overwritten by raw user text.
    expect(workerSrc).toMatch(
      /sessionUserMsgIds\.get\(part\.sessionID\)\?\.has\(part\.messageID\)[\s\S]{0,200}trace\.setPrompt/,
    )
    // The user-text branch must NOT call setTitle.
    expect(workerSrc).not.toMatch(
      /sessionUserMsgIds\.get\(part\.sessionID\)\?\.has\(part\.messageID\)[\s\S]{0,200}trace\.setTitle\(text/,
    )
  })

  // Major #1 from the multi-LLM consensus review (codex-verified). The user-text
  // branch must NOT feed `setPrompt`/`logUserMessage` from synthetic or ignored
  // parts — `Session.createUserMessage` (prompt.ts) attaches MCP resource banners,
  // decoded file contents, retry/reminder text, and plan-mode reminders as
  // `synthetic: true` text parts that share the user's `messageID`. Without the
  // gate, `metadata.prompt` ends up holding the LAST synthetic part (typically
  // a file blob) and the chat tab renders one fake "▶ You" bubble per synthetic
  // span — defeating the two display surfaces this PR fixes.
  test("user-text branch skips synthetic/ignored parts before calling setPrompt+logUserMessage", async () => {
    const workerSrc = await fs.readFile(path.join(ROOT, "src/altimate/observability/trace-consumer.ts"), "utf-8")
    // The synthetic+ignored gate must build the `isAuthoredText` predicate
    // from BOTH flags. Stronger than just searching for the literal anywhere.
    expect(workerSrc).toMatch(/const\s+isAuthoredText\s*=\s*!part\.synthetic\s*&&\s*!part\.ignored/)
    // Both write paths must sit inside the user-text branch (gated on the
    // `sessionUserMsgIds...has(...)` membership check) AND inside an
    // `if (text)` body whose contents don't cross block boundaries.
    // The `[^{}]` bounds on the inner spans prevent the match from extending
    // past the closing brace of the `if (text)` body, so unrelated
    // `trace.setPrompt` / `trace.logUserMessage` calls elsewhere in the file
    // can't satisfy this assertion — exactly what the previous loose regex
    // allowed and what CodeRabbit flagged.
    expect(workerSrc).toMatch(
      /sessionUserMsgIds\.get\(part\.sessionID\)\?\.has\(part\.messageID\)[\s\S]{0,400}if\s*\(\s*text\s*\)\s*\{[^{}]*trace\.setPrompt[^{}]*trace\.logUserMessage/,
    )
  })

  test("Trace.setPrompt exists and only mutates metadata.prompt", async () => {
    const tracingSrc = await fs.readFile(path.join(ROOT, "src/altimate/observability/tracing.ts"), "utf-8")
    // Method must exist with the documented signature.
    expect(tracingSrc).toMatch(/setPrompt\(prompt: string\)\s*\{[\s\S]{0,200}this\.metadata\.prompt = prompt/)
    // Must NOT touch metadata.title.
    expect(tracingSrc).not.toMatch(/setPrompt\(prompt: string\)\s*\{[\s\S]{0,300}this\.metadata\.title/)
  })
})
