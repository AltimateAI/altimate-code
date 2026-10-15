# [FEATURE]: expose per-call usage for auxiliary generations

> Local draft only. Nothing has been posted. Network access is unavailable; an upstream duplicate search is still required before filing. This proposal needs design approval before an implementation PR.

### Feature hasn't been suggested before.

- [ ] I have verified this feature I'm about to request hasn't been suggested before.

### Describe the enhancement you want to request

A telemetry plugin can correlate primary step events, but cannot obtain equivalent per-call records for title and compaction generations. Please expose a small public completion event with call identity, Session, request kind, model, timing, usage/cost when available, normalized/raw finish reason, and outcome. Retries should be distinguishable; a hook-supplied result that skips the model should not look like a model call.

Two related details would keep these records accurate:

- Preserve the model's finish reason independently of execution outcome. A model can finish with `tool-calls` before the user interrupts the tool; the execution is interrupted, but the completed model response still has a finish reason.
- Preserve whether a token counter was reported. An omitted reasoning/cache count is unknown, not necessarily zero. Optional reported counters or presence metadata could coexist with today's normalized totals.

Existing coverage is useful: compaction completion already exposes aggregate model, cost and tokens; failure exposes optional aggregate cost/tokens. Title usage already contributes to internal accounting and public Session totals. The missing part is per-call attribution, including retries and failures. Subtracting Session totals during concurrent activity cannot reliably supply it.

### Code references (v2.0.29)

- `packages/plugin/src/promise/session.ts:61`: `model.request` identifies request kind, but has no terminal usage.
- `packages/core/src/session/title.ts:57`, `:78`, `:91`: title usage accumulation and internal publication. `packages/schema/src/session-event.ts:704` excludes that accounting event from the public inventory; `packages/core/src/plugin/host.ts:258` filters subscriptions to public events.
- `packages/core/src/session/compaction.ts:610`: accumulates calls; `packages/schema/src/session-event.ts:604` and `:623` expose aggregate outcomes.
- `packages/core/src/session/runner/publish-llm-event.ts:432` and `packages/schema/src/session-event.ts:379`: failed steps retain only `content-filter` as normalized finish.
- `packages/core/src/session/usage.ts:9` and `:11` normalize absent counters to zero; `packages/schema/src/token-usage.ts:6` requires numeric counters.

The interruption case was exercised in a local scripted Session fixture. Auxiliary-generation coverage above is source inspection, not an executed title/compaction test. Suggested checks: title success/failure, compaction with multiple calls, interruption after a `tool-calls` response, and omitted versus explicit-zero counters.

### Open questions for maintainers

- Should per-call records be public ephemeral events or a plugin hook?
- Would optional reported usage alongside normalized totals fit the existing contract?
