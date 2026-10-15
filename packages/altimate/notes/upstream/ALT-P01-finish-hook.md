# [FEATURE]: Let plugins validate a clean completion before execution succeeds

Local draft only; duplicate search pending (offline). Open the feature issue and obtain design approval before opening a PR. The PR text describes an unapproved prototype.

## Feature issue body

### Feature hasn't been suggested before.

- [ ] I have verified this feature I'm about to request hasn't been suggested before.

### Describe the enhancement you want to request

A plugin that provides database tools may need to validate a generated query or result before the session execution is reported successful. Observing completion and sending another prompt happens too late for that decision.

Could the Promise and Effect plugin APIs expose `ctx.session.hook("finish", callback)` at the runner's clean-stop boundary, after the assistant message is projected and before execution success?

The proposed event includes `sessionID`, `agent`, `model`, the completed assistant `message`, `continuations`, `maxContinuations`, and mutable `decision`. The default is `{ continue: false }`; requesting another step uses:

```ts
await ctx.session.hook("finish", (event) => {
  if (event.continuations === 0)
    event.decision = { continue: true, text: "Validate the result before finishing." }
})
```

This publishes existing synthetic user feedback for the next step's reloaded history. Callback return values are not decisions. Only a clean `finish === "stop"` without an existing tool continuation invokes the hook.

The prototype permits three accepted continuations per promoted prompt, configurable with non-negative integer `experimental.finish_continuations`. Zero still permits inspection. At the bound, allowing completion succeeds; requesting another continuation fails with `finish-limit`. The agent step cap also applies. New promoted input resets the count; synthetic feedback does not. The count survives Location handoffs but is process-local, not a durable quota across restarts.

In v2.0.29, the hook inventories end without a completion decision (`packages/plugin/src/promise/session.ts:138`, `packages/plugin/src/effect/session.ts:138`). The runner returns `needsContinuation` directly (`packages/core/src/session/runner/llm.ts:273`); execution success is published after draining (`packages/core/src/session/execution.ts:119`).

#### Open questions for maintainers

- Does this boundary and `finish` name fit the plugin API?
- Should multiple validators share the existing ordered mutable-event behavior, or combine decisions differently?
- Is a configurable process-local allowance with failure on further rejection the desired limit policy?

## PR title

`feat(core): allow plugins to validate session completion`

## PR description

### Issue for this PR

No issue exists yet. This local draft awaits a feature issue and design approval.

### Type of change

- [ ] Bug fix
- [x] New feature
- [ ] Refactor / code improvement
- [ ] Documentation

### What does this PR do?

Adds a `finish` session hook to both plugin APIs so a plugin can inspect a settled clean-stop assistant message before execution succeeds. A continuation adds synthetic feedback to normal history. The runner enforces a configurable allowance, preserves it through Location handoffs, and fails further rejection at the limit without bypassing agent step limits.

### How did you verify your code works?

Recorded prototype runs passed 237 runner tests and 37 configuration tests, plugin tests, affected-package typechecks, and the root check. Tests cover a suspended decision, feedback in the next model request, default/custom/zero limits, allowing at the bound, prompt reset, Location moves, the agent cap, and tool/filtered finishes. SDK integration tests additionally assert no early success and exactly one final success. These results are historical; no tests were rerun while drafting.

Reviewer commands from `packages/core`: `bun run test test/session-runner.test.ts`, `bun run test test/config/normalization.test.ts`, and `bun typecheck`. Run `bun test` and `bun typecheck` from `packages/plugin`, then `bun run check` from the repository root.

### Screenshots / recordings

Not applicable; this changes the plugin API and runner behavior.

### Checklist

- [ ] I have tested my changes locally
- [ ] I have not included unrelated changes in this PR

## Local source verification (not part of the paste bodies)

Baseline references above were read from `git show v2.0.29:<path>`. Prototype-only references use commit `57ed6d7268`: `packages/plugin/src/promise/session.ts:139` and `packages/plugin/src/effect/session.ts:139` (API), `packages/core/src/session/runner/llm.ts:296` (decision/limit), `packages/core/test/session-runner.test.ts:988` (runner cases), and `packages/core/test/config/normalization.test.ts:515` (normalization). Test results were checked against the local findings' verification table. Keep checkboxes unchecked until the eventual upstream patch is verified.
