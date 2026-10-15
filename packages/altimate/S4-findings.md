# S4 — telemetry through public plugin events and hooks

Date: 2026-10-15. Upstream: OpenCode v2.0.29. Bun: 1.4.2.

**Requested primary-step and local-tool acceptance passes. Classification: P\*.**
The adapter needs public-event correlation, and exact auxiliary-generation parity
still has **U** gaps. No upstream change or private core API was needed.

## Implementation

`src/telemetry.ts` exports `telemetry(exportRecord)` and `memoryTelemetry()`.
The test supplies the returned plugin to the real SDK host. The package's default
server does not automatically export telemetry: this spike supplies an in-memory
sink without inventing a deployment, consent, transport, or retention policy.

The plugin subscribes using `ctx.event.subscribe`, retaining per-Location state
and filtering by the public event's directory. It joins `session.step.started`,
`session.step.streamed`, and `session.step.ended`/`failed` by Session and message
ID. Started supplies agent/model identity and request dispatch time; the terminal
event supplies cost, usage, and finish reason. The model duration ends at the
streamed boundary, before waiting for a tool to finish.

`tool.hook("execute.before")` records a wall-clock start and the effective tool
name. `execute.after` records whether the ordinary hook completed. Public
`session.tool.success`/`failed` terminal events settle and export the record,
correlated by Session, assistant message, and tool-call ID. Interrupted tools
therefore remain observable when `execute.after` does not run.

The sink exports flat v1-style numeric counters. Inclusive input is reconstructed
as `input + cache.read + cache.write`. V2 separates visible output and reasoning;
the v1-style `tokens_output` is their sum, with `tokens_visible_output` also
included so the distinction remains explicit. Usage absent on a failed step
stays absent; it is not guessed.

## SDK acceptance and non-vacuity

`test/s4-telemetry.test.ts` runs one real Session with:

1. A model step calling `telemetry_complete`, with a delayed local tool result.
2. A final text step completing that execution.
3. A later prompt in the same Session calling an abortable tool, interrupted
   through `opencode.sessions.interrupt`. This is a third model step, separate
   from the requested two-step successful execution.

The scripted model has distinct nonzero token values and public model cost rates
of $2 input, $4 output, $0.50 cache read, and $3 cache write per million tokens.

| Step | Uncached / read / write input | Visible / reasoning output | Expected cost | Result |
| --- | --- | --- | --- | --- |
| Completed tool call | 10 / 6 / 4 | 5 / 3 | $0.000067 | PASS |
| Final text | 30 / 8 / 2 | 10 / 2 | $0.000118 | PASS |
| Interrupted tool call | 7 / 0 / 0 | 2 / 0 | $0.000022 | PASS |

All three records assert model identity, usage, cost, finish/outcome, and positive
model duration. Each duration is compared with the actual public durable log's
`streamed.created - started.started`; the model fixture delays each request.
Tool records assert name, message correlation, duration, success/interruption,
and exactly two terminal tool records. The interrupted tool's AbortSignal fires,
and its record has no `after_hook`, proving that the terminal-event path matters.

`S4.2` additionally executes real Code Mode code calling two nested tools. Their
hooks reuse the outer `execute` call ID. A regression test first failed with the
last inner tool's name exported ([before-fix receipt](evidence/s4-codemode-before.txt)).
The adapter now retains the first before-hook identity/start and accepts an
after-hook only for that name. The test verifies both inner calls ran and exactly
one outer `execute` record has the full duration and completed outcome.

Non-vacuity: temporarily replaced both exporter calls with no-ops in
`src/telemetry.ts`, ran the main test, and observed exit 1 at the bounded wait for
the expected records. The original source was restored in `finally`; the focused
test passed afterward. See [negative control](evidence/s4-export-mutation.txt).

## Exact v2.0.29 seams and gaps

All paths below are in the v2 worktree unless explicitly labeled v1.

| Contract | Source | Classification |
| --- | --- | --- |
| Public start contains agent, model, assistant ID, and dispatch timestamp. | `packages/schema/src/session-event.ts:328`; core records dispatch at `packages/core/src/session/runner/step.ts:84`. | **P** |
| Streamed boundary precedes tool settlement; terminal events include usage and cost. | `packages/schema/src/session-event.ts:344`, `:355`, `:372`; `packages/core/src/session/runner/step.ts:149`, `:151`, `:246`. | **P\***: correlate events; terminal timestamp alone overcounts model duration. |
| Tool hooks have identity/input/outcome but no duration. | `packages/plugin/src/promise/tool.ts:38`. | **P\***: before-hook timestamp plus public terminal event. |
| Interrupted execution bypasses the after hook. | `packages/core/src/tool.ts:119` catches only `Tool.Error`, then calls after at `:137`/`:149`; interruption settlement is at `packages/core/src/session/runner/step.ts:216`, `:224`. | **P\***: terminal `session.tool.failed`, schema at `packages/schema/src/session-event.ts:551`, preserves an `aborted` outcome. |
| Code Mode inner tools reuse the outer tool context/ID. | `packages/core/src/tool.ts:240`; `packages/core/src/codemode/tool.ts:95`. | **P\*** for the outer `execute` record; the adapter preserves its first start/name. Independent nested-call records are outside this slice; hooks provide no distinct inner-call ID. |
| An interrupted step may retain usage and raw finish, but normal `tool-calls` is absent from its failed-step finish field. | `packages/core/src/session/runner/publish-llm-event.ts:428`, `:432`; failed schema at `packages/schema/src/session-event.ts:379`. | **U** for exact original normalized finish; adapter reports `finish_reason: error`, explicit `outcome: interrupted`, and preserves `raw_finish_reason`. |
| Missing usage counters become zero before publication. | `packages/core/src/session/usage.ts:8`, `:11`; fixed token schema at `packages/schema/src/token-usage.ts:6`. | **U** for distinguishing provider-omitted reasoning/cache counters from reported zero. |
| Plugin subscription filters events to the public manifest. | `packages/core/src/plugin/host.ts:258`; `packages/schema/src/event-manifest.ts:41`, `:71`; `packages/schema/src/session-event.ts:704`. | Defines the auxiliary visibility limits below. |

This adapter measures locally executed tools that traverse the tool hooks.
Provider-hosted tools have public terminal events but do not traverse those
hooks (`packages/core/src/session/runner/step.ts:122`); their duration/name join
would require the separate public input/called events. That extension was not
implemented or claimed by this slice. Registration after a step has already
started also cannot reconstruct a missed start without replay; tests subscribe
before admitting the first prompt.

## Diff against v1 emitted fields

V1 source: `/Users/anandgupta/codebase/altimate-code/packages/opencode/src/`.
Its generation schema is `altimate/telemetry/index.ts:262`, and actual generation
emission is `session/processor.ts:935`. Tool schema is
`altimate/telemetry/index.ts:305`.

| V1 field(s) | S4 result |
| --- | --- |
| `timestamp`, `session_id`, `message_id` | Present from public event envelope and data. |
| `model_id`, `provider_id`, `agent` | Present by joining step start to terminal. |
| `finish_reason`, `cost`, `duration_ms` | Present for completed primary steps. Duration now uses dispatch-to-response-body; v1 started its clock at SDK `start-step` (`session/processor.ts:900`) and stopped at `finish-step` (`:946`), so the boundaries are not byte-for-byte identical. |
| `tokens_input`, `tokens_input_total`, `tokens_output` | Present. Input total is derived; output combines visible output and reasoning for v1's inclusive output convention (`session/index.ts:856`, `:905`, `:907`). |
| Optional `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write` | Numeric values present. V1 conditional presence (`session/processor.ts:961`) cannot be recovered after v2 normalizes missing values to zero. |
| Tool `tool_name`, `status`, `duration_ms`, `error` | Present. Exporter adds `interrupted` to distinguish it from ordinary errors, plus `tool_call_id` and observed `after_hook`. |
| Tool `tool_type`, `tool_category` | Not emitted by this adapter. Can be supplied by plugin-owned taxonomy and public tool inventory; not a demonstrated need for core changes. |
| Tool `sequence_index`, `previous_tool`, `input_signature` | Not emitted by this adapter. Sequence and signature can be computed from hooks; no upstream gap claimed. |
| Envelope `cli_version`, `source`, `project_id`, `machine_id`, `launch_id` | Not emitted by the in-memory slice. V1 attaches these at `altimate/telemetry/index.ts:1936`; source/project metadata and privacy/identity policy belong to the exporter integration. |
| Active external trace correlation (`ai.operation.id`) | Not emitted. V1 stamps its own `TraceContext.activeTraceId` at `altimate/telemetry/index.ts:2264`; reproducing that cross-product contract is separate plugin/application work. |

No primary completed-generation numerical field in the requested acceptance is
missing. The unavailable optional-presence information and auxiliary per-call
telemetry below are API fidelity gaps, distinct from fields deliberately omitted
from this small exporter.

## Title and compaction usage: observed API coverage

This section is source inspection, not an executed title/compaction test.

**Title: U for direct per-generation telemetry.** Core accumulates usage and
publishes internal `session.usage.recorded` with `source: "title"` at
`packages/core/src/session/title.ts:57`, `:78`, and `:91`. Its schema is
`packages/schema/src/session-event.ts:155`, and it is excluded from the public
manifest at `:704`. `ctx.event.subscribe` therefore cannot see it. Public
`session.usage.updated` exposes combined totals (`:167`), not a titled
generation's individual outcome/model/usage. Core republishes these totals for
both primary and auxiliary usage at `packages/core/src/session/projector.ts:796`.
Subtracting counters during concurrent activity is not a reliable substitute.

**Compaction: P\* for aggregate usage, U for per-call parity.** Contrary to the
initial expected gap, `session.compaction.ended` publicly includes model, cost,
and tokens (`packages/schema/src/session-event.ts:604`); failed compactions also
include optional cost/tokens (`:623`). Core accumulates every compaction call,
including retries, in `packages/core/src/session/compaction.ts:610`, publishes
internal accounting at `:620`, and repeats the total in public outcomes at
`:633`/`:644`. Aggregate cost/tokens and operation duration are recoverable.
Individual call usage, normalized finish reason, and per-call duration are not
public; a failed compaction terminal also omits model identity. The exporter in
this slice handles primary steps only and does not export compaction totals.

`session.hook("model.request")` identifies `kind: title|compaction|primary|generate`
(`packages/plugin/src/promise/session.ts:57`), so auxiliary starts are visible,
but that hook has no terminal usage/outcome. It does not close the missing
per-call contract.

## Receipts and scope

- Focused S4 tests: **2 pass / 0 fail, 25 assertions**;
  [test output](evidence/s4-tests.txt).
- Package typecheck: exit 0; [typecheck](evidence/s4-typecheck.txt).
- Negative control: expected exit 1; [mutation output](evidence/s4-export-mutation.txt).
- Shared scripted model adds optional usage/delay fields; existing defaults stay
  unchanged. The root task records final combined-suite verification separately.
- No upstream files changed, no Protocol/HttpApi change, no staged files or
  commits. No Obsidian copy: the explicit write boundary permits only the two
  package trees.


## Final round-3 verification

After formatting and all fixes, with the requested Bun 1.4.2 PATH prefix:

- `cd packages/altimate && ALTIMATE_LIVE=0 bun test`: **42 pass, 1 skip, 0 fail,
  190 assertions**, 43 tests across 9 files. The live test was explicitly kept
  disabled. [Full per-test output](evidence/round3-tests.txt).
- `cd packages/altimate && bun run typecheck`: **exit 0**.
  [Package typecheck](evidence/round3-typecheck.txt).
- Repository-root `bun run check`: **exit 0**, 1,353 existing lint warnings,
  zero errors; **37/37 package typechecks successful**.
  [Canonical check output](evidence/round3-root-check.txt).
- `git diff --check`: clean. Git index empty; every changed/new source, test,
  report, and receipt is under `packages/altimate/**`. No upstream edits,
  dependency installs, generated-client edits, or commits.

New slice totals: **S2 11 passing tests**, **S3 4 passing tests**, **S4 2 passing
tests**. All **25 pre-existing tests** also pass. Each slice has a restored,
expected-failing negative-control receipt. Work completed within the 40-minute
round budget (approximately 22 minutes).
