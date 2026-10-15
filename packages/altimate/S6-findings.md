# S6 — completion decisions and composer controls

Date: 2026-10-15. Base: `d70120b7e1`, OpenCode v2.0.29. Bun: 1.4.2.

**Both patches pass their automated acceptance tests. Classification: U for each
missing upstream API.** Neither patch contains Altimate business logic.
All upstream additions are marked with `// ALT-P01` or `// ALT-P02`.
The patches and S8 have disjoint file sets; nothing is staged or committed.

## S6a / ALT-P01 — pre-completion finish decision

The Promise and Effect session APIs now expose `session.hook("finish", callback)`.
`finish` follows the existing lifecycle hook names (`prompt`, `context`, `retry`)
and describes a completion decision. `stop` could also describe interruption;
this hook only examines a clean model stop.

The runner calls the generic `PluginHooks` session dispatcher in the `Completed`
branch, after the step and assistant message are projected, before returning
`false` to the drain. The execution coordinator therefore cannot publish
`session.execution.succeeded` while the decision is pending. There is no new
model loop, durable event type, or post-success resumption.

The event contains `sessionID`, `agent`, `model`, the completed assistant
`message`, `continuations`, `maxContinuations`, and a mutable `decision`:

```ts
await ctx.session.hook("finish", (event) => {
  if (event.continuations === 0)
    event.decision = { continue: true, text: "Validate the result before finishing." }
})
```

The default decision is `{ continue: false }`. Returning a value is not the
decision API; callbacks mutate `event.decision`, as with the existing retry
hook. A continuation publishes the existing `session.synthetic` event, which
becomes user input in the next reloaded model request. It does not admit a new
user prompt or reset the continuation allowance. Provider-filtered registrations
use the existing generic hook mechanism. Without an applicable hook, the runner
does not load the finished message or configuration for this decision.

Only `finish === "stop"` with no existing tool continuation invokes the hook.
Tool continuation, failed/interrupted output, content filtering, and output
token-limit recovery retain their existing paths. Agent step limits still apply.

### Bound and configuration

The default maximum is **three accepted continuations per promoted prompt**.
Configuration goes through both the schema and normalizer:

```json
{ "experimental": { "finish_continuations": 3 } }
```

The value must be a non-negative integer; zero permits inspection but disallows
continuation. At the bound the callback may still allow completion. If it requests
another continuation, the runner raises `Session.StepFailedError` with
`error.type: "finish-limit"`, producing execution failure instead of falsely
accepting a rejected result. The same failure applies if the agent step limit
already prevents another step.

New promoted input resets the allowance. The existing transient continuation
object carries its count across Location move/reload handoffs. This is a
process-local execution allowance, like the current step counter; it is not a
durable quota across process crashes. No new durable accounting was introduced.

### Measured patch size and exact S6a commit files

Counts are additions/deletions against `d70120b7e1` (`git diff --numstat`);
new files use their line count. Documentation for both S6 patches is assigned
only to S6b below so the commit file sets remain disjoint.

| File | + | - |
| --- | ---: | ---: |
| `packages/core/src/config/normalize.ts` | 10 | 0 |
| `packages/core/src/plugin/hooks.ts` | 1 | 0 |
| `packages/core/src/session/runner/index.ts` | 2 | 1 |
| `packages/core/src/session/runner/llm.ts` | 59 | 6 |
| `packages/core/test/config/normalization.test.ts` | 14 | 0 |
| `packages/core/test/session-runner.test.ts` | 200 | 0 |
| `packages/plugin/src/effect/session.ts` | 15 | 0 |
| `packages/plugin/src/promise/session.ts` | 15 | 0 |
| `packages/schema/src/config/experimental.ts` | 4 | 0 |
| **Upstream subtotal: 9 files** | **320** | **7** |
| `packages/altimate/test/s6-finish.test.ts` | 104 | 0 |
| `packages/altimate/evidence/s6-finish-mutation.txt` | 36 | 0 |
| **S6a total: 11 files** | **460** | **7** |

`core/src/plugin/hooks.ts` already derives session registration and trigger types
from `SessionHooks`; its marker documents that wiring. The actual invocation and
explicit service dependency live in the runner. No parallel registry or special
Promise adapter was needed.

### Tests and ledger

- Eight upstream runner scenarios cover a suspended decision, synthetic feedback
  in the next actual model request, default/custom/zero bounds, allowing at the
  bound, reset after queued input, Location handoff, the agent step cap, and
  skipping tool/filtered finishes. They reuse the existing Effect/TestLLM harness.
- The normalization regression covers valid and invalid configured limits.
- Three Altimate SDK-host tests use real execution events: no success while the
  first decision is suspended; exactly one success after final completion;
  repeated rejection yields three synthetic messages and failure, with reset on
  the next prompt; a real config file with zero prevents continuation.
- The runner unit harness replaces `SessionExecution`, so event publication
  assertions deliberately live in the SDK integration tests.
- Removing the repeating validator's registration makes the SDK acceptance fail
  (exit 1, empty observed decisions instead of `[0, 1, 2, 3]`). Registration was
  restored before the passing suite. [Negative-control receipt](evidence/s6-finish-mutation.txt).

**Ledger ID:** ALT-P01.
**Contract:** inspect a settled clean-stop assistant message before execution
success; allow or inject bounded synthetic feedback; support Promise and Effect
plugins and provider filters.
**Upstream files:** the nine-file upstream subtotal above.
**Removal condition:** upstream releases an equivalent pre-completion decision
hook with bounded continuation and both plugin APIs; migrate the validator to
that contract and delete this patch plus its local ledger markers.

**Draft upstream PR title:** `feat(core): allow plugins to validate session completion`

**Draft upstream PR body:**

> A plugin can observe a completed step today but cannot request corrective input
> before the execution is reported successful. Add a `finish` session hook to the
> Promise and Effect plugin APIs at the runner's clean-stop boundary. Plugins can
> inspect the settled assistant message and request a synthetic user message,
> which the next step reads through normal durable history.
>
> Continuations default to three per promoted prompt, can be configured with
> `experimental.finish_continuations`, and preserve their allowance through
> Location handoffs. Repeated rejection fails visibly at the bound and does not
> bypass agent step limits. Existing tool, error, and token-limit paths retain
> their behavior. Tests cover timing, feedback, limits, configuration, handoff,
> and prompt reset; SDK integration confirms execution success occurs only after
> the final allow decision.

## S6b / ALT-P02 — public prompt composer controls

`ui.composer.get()` returns the active draft's text snapshot, or `undefined` if
no composer is mounted. `set(text)` replaces the draft with plain text using
the existing `PromptRef.set` and `emptyPrompt()`; it clears attachments, mentions,
and pasted-content metadata and returns false if no composer is mounted.
`focus()` delegates to the active PromptRef and returns its actual focused state.
Every call resolves the current ref, including after unmount/remount.

The existing PromptRef provider already wraps the plugin provider, so no prompt
component changes were necessary. The public type deliberately exposes text
rather than host-only renderable/extmark objects. Submit middleware was omitted:
submission owns asynchronous admission, draft clearing, and navigation, so it
would be a separate, nontrivial patch.

### Measured patch size and exact S6b commit files

| File | + | - |
| --- | ---: | ---: |
| `packages/plugin/src/tui/context.ts` | 9 | 0 |
| `packages/tui/src/plugin/api.tsx` | 21 | 0 |
| `packages/tui/test/plugin-composer.test.tsx` | 131 | 0 |
| **Upstream subtotal: 3 files** | **161** | **0** |
| `packages/altimate/S6-findings.md` | 223 | 0 |

The combined findings file belongs to **S6b only**, after the S6a implementation.
It is not a file shared by both proposed commits.

### Tests and ledger

Two headless tests exercise real plugin-context construction, PromptRef registry,
keymap command dispatch, and OpenTUI textarea rendering with a PromptRef boundary
fixture. A plugin command reads the draft, replaces it, and focuses the editor;
the rendered text and cleared metadata are asserted. Missing/remounted composers
and a non-focusable editor are covered. This mirrors existing TUI plugin API
tests; it is not a live terminal or full Prompt component test.

**Ledger ID:** ALT-P02.
**Contract:** read active composer text, replace the complete draft with plain
text, and focus the composer through the public TUI plugin context.
**Upstream files:** the three-file upstream subtotal above.
**Removal condition:** upstream exposes equivalent composer controls and the
plugin can consume them directly; remove this adapter patch and ledger markers.

**Draft upstream PR title:** `feat(tui): expose prompt composer controls to plugins`

**Draft upstream PR body:**

> Expose `ui.composer.get/set/focus` on the public TUI plugin context so plugin
> commands can inspect or replace the active draft and focus its editor. The
> adapter resolves the current prompt on each call, reports unavailable composers,
> and explicitly clears attachment and mention metadata when setting plain text.
>
> Headless plugin API tests cover real keymap dispatch, rendered replacement
> text, metadata cleanup, missing/remounted prompt refs, and refused focus.
> Existing model, toast, select, and Markdown plugin suites and TUI/plugin
> typechecks pass.

## Verification and boundaries

Commands use the requested Bun 1.4.2 PATH prefix and installed dependencies.

| Command / directory | Result |
| --- | --- |
| `bun run test test/session-runner.test.ts` / `packages/core` | 237 pass, 0 fail; 1,177 assertions |
| `bun run test test/config/normalization.test.ts` / `packages/core` | 37 pass, 0 fail; 353 assertions |
| `bun typecheck` / `packages/core` | pass |
| `bun test` / `packages/plugin` | 9 pass, 0 fail |
| `bun run typecheck` / `packages/plugin` | pass |
| `bun test test/plugin-composer.test.tsx test/plugin-model.test.tsx test/plugin-toast.test.tsx test/plugin-select.test.tsx test/plugin-markdown.test.tsx` / `packages/tui` | 26 pass, 0 fail; 87 assertions |
| `bun run typecheck` / `packages/tui` | pass |
| `bun test` / `packages/altimate` | 49 pass, 1 existing live-gateway skip, 0 fail; 241 assertions |
| `bun run typecheck` / `packages/altimate` | pass |
| `bun run check` / repository root | pass; 1,353 existing lint warnings, 0 errors; 37/37 package typechecks |
| `git diff --check` | pass |

The [combined Altimate suite receipt](evidence/s8-suite.txt) is assigned to S8's
commit. No public Protocol or Server HttpApi definition was changed, so no client
generation was required. S8 uses neither S6 API and changes no upstream files.
The actual TUI launch/capture remains pending as specified by the user; see
[S8 findings](S8-findings.md). Full core/TUI test inventories were not run: the
relevant runner/configuration and plugin API suites were run alongside the
repository-wide lint/typecheck.

The default Obsidian copy could not be made: `/Users/anandgupta/obsidian/altimate`
is outside this session's writable roots and approval is unavailable. Both
canonical findings files remain in this worktree.
