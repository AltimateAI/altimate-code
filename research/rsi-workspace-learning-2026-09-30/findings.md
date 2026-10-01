# RSI on Altimate workspaces — what we built, what we measured, what's missing

Date: 2026-09-30 → 10-01. Branch: `feat/rsi-workspace-learning` (local, not pushed).
Research inputs: `rsi-papers.md`, `rsi-practice.md`. Design and critique resolution: `design.md`.
Raw experiment report: `experiments/rsi-workspace/harness/runs/saas-v2/report.md` (git-ignored run data).

## TL;DR

- A self-improvement loop now runs **end-to-end and autonomously on the real Altimate SaaS** (tenant `anandtest1`, workspace 17):
  agent works → hidden CI verifier → `altimate-code learn reflect` → curated playbook → val gate →
  `learn promote` → `skill publish` → a **second real user** syncs it and works better.
- On 3 held-out dbt tasks × 3 runs (n = 9 per arm; Haiku 4.5 agent, Sonnet 4.6 reflector):

  | arm | held-out passes | checks passed | cost / run |
  |---|---|---|---|
  | no playbook (baseline) | 0/9 | 31/54 | $0.99 |
  | **learned playbook, author (A)** | **7/9** | **52/54** | $1.28 |
  | **learned playbook, teammate via workspace sync (B)** | **5/9** | **50/54** | $1.30 |
  | human-written gold playbook (upper bound) | 9/9 | 54/54 | $1.02 |
  | reflector without feedback (ablation) | 0/9 | 27/54 | $0.96 |

  Controls (2 tasks the playbook must not be over-applied to): 5/6 → 6/6 (A) / 5/6 (B); no over-application observed.
- **The external signal is what made it work.** The same reflector with no feedback learned only what the code already showed and scored like baseline — the literature's central result, reproduced.
- It is **not** a statistically powered result: n = 9 per arm, one model, one synthetic-but-realistic repo. It proves the mechanism works on real infrastructure, not real-world lift.

## What was built

### Product (`packages/opencode`)
`altimate-code learn` — `reflect | show | promote | rollback | reject`:
- **Reflector**: one in-process, tool-less, temperature-0 LLM call (`generateObject`) turning a session digest + external
  feedback (`verifier|ci|review|user`) into ACE-style deltas (ADD/EDIT/REMOVE/HELPFUL/HARMFUL). Prompt treats digest and
  feedback as untrusted data.
- **Curator** (deterministic): lint rejects shell commands, URLs, absolute/`..` paths, verification-weakening phrasing,
  secrets and prompt-injection markers; ≤3 ADDs per reflection; dedupe (Jaccard ≥ 0.6 → HELPFUL); 25-bullet cap;
  auto-remove only after HARMFUL from ≥2 distinct feedbacks.
- **Staging**: edits land in `.altimate-code/learn/<name>/candidate.md`; `promote` re-lints, shows a diff, needs
  confirmation (`--yes` for automation), archives the previous version; `--publish` (workspace pilot only) shares it.
- **Privacy**: the published `SKILL.md` carries bullets + counters only; session ids, feedback hashes and history stay
  in local `history.jsonl`.
- 164 unit tests (incl. 61 hardening regressions); typecheck and upstream-marker check clean; full `test/altimate`
  shows no new failures vs `main` beyond pre-existing network-timeout tests. Re-verified end to end with the hardened
  CLI on the real run's state (reflect → show → promote).

### Experiment harness (`experiments/rsi-workspace/`)
- `demo/`: dbt-duckdb "acme_shop" repo, 14 tasks (4 train / 4 val / 4 held-out / 2 control), hidden verifier
  outside every workdir. Two conventions are inferable from existing code; two (UTC macro, soft deletes) are not, and
  their CI messages report symptoms only ("returned 25 rows; reconciliation expects 22").
- `harness/`: isolated per-user HOME/XDG, agent sandboxed with `external_directory: deny`, autonomous `loop.py`
  (train → verify → reflect → gate on val → promote → publish → verify as teammate), `eval.py` arms, `report.py`,
  leak scan and playbook-in-prompt detection.
- `fake-backend/`: offline stand-in for the workspace API, kept only as a test fixture — **all reported numbers come
  from the real SaaS.**

## What the loop learned (verbatim, as published to workspace 17)

```
- Money columns sourced in cents must be converted using the {{ cents_to_dollars() }} macro and renamed without the _cents suffix ...
- Staging models must filter out soft-deleted rows (where the source soft-delete flag is true) so that deleted records never reach analytics.
- Staging SQL models must follow the source → renamed → final CTE pattern, declare a primary key column with unique and not_null tests ...
- Timestamp columns sourced without timezone info must be normalized to UTC using convert_timezone() or equivalent and renamed with a _at suffix ...
```

- **Soft deletes** were inferred from symptom-only feedback (row-count mismatch) — genuine induction, C5 0/9 → 9/9.
- **The UTC bullet is subtly wrong**: the team rule is the `to_utc` macro; the loop learned "convert_timezone() or
  equivalent", and iteration 2 *reinforced* it (helpful 2 → 5) instead of fixing it, because the symptom-only feedback
  never names the macro. This is the whole A-vs-gold gap (C4 7/9 vs 9/9). It is the "plausible-but-wrong rule gets
  reinforced" failure mode from the literature, observed live.
- **Why the wrong rule was reinforced:** the reflector credits a bullet HELPFUL whenever the related check passes —
  even when the agent satisfied the check another way (e.g. found `to_utc` in `macros/` itself) or the bullet did not
  apply ("C5 … not applicable here but the check passed" → HELPFUL). Counters therefore measure "co-occurred with a
  pass", not "caused a pass". Fix direction: credit only when the digest shows the agent *followed* the bullet, and
  let the reflector read the repo so it can name the macro.

## Learning curve and gate (val split, 4 tasks × 2 runs, never shown to the reflector)

| iteration | current checks | candidate checks | action |
|---|---|---|---|
| 1 | 29 (0/8 pass) | 47 (7/8 pass) | promote |
| 2 | 44 (5/8 pass) | 46 (6/8 pass) | promote |

Train-split pass rate with the then-current playbook: 1/4 → 4/4.

## Integrity

- 90 final-arm runs, **0 leaks** after re-scan (two initial flags were the arm name "gold" inside the agent's own
  workdir path; scanner fixed and re-run over all saved events).
- Playbook present in the system prompt: 0/18 baseline, 18/18 in every playbook arm (checked on the saved traces;
  the first detector had a unicode-escaping bug and reported all False — fixed and re-run).
- Teammate arm: the skill arrived by the product's own sync in 18/18 runs; workdir sha == backend sha == A's promoted
  sha (`a3a0ccb0cb6b`).
- Benchmark defect: `heldout-support-tickets` scored 0 in every arm (even gold) because agents name the model
  `stg_support__tickets` and the verifier collapsed all checks on the file name. Excluded from the headline;
  verifier fixed (see "Fixes made while reviewing as a user"). Post-hoc re-verification of the saved workdirs with
  the fixed verifier (secondary, same rule for every arm): gold 0.83 ×3; learned 0.67/0.5/0.5; teammate
  0.67/0.67/0.5; no-feedback 0.5 ×3 — same ordering as the headline, but C2 still trips on a second naming ambiguity
  (`ticket_id` vs `support_ticket_id`), so the task stays out of the headline. The task prompt now names the entity.

## Fixes made while reviewing as a user / operator

| Found by | Problem | Fix |
|---|---|---|
| First SaaS run | Gate rejected a +16-check candidate over one 2/2→1/2 dip (no power at n=2) | Regression = task total drops or a check goes N/N → 0/N |
| UX review | Reflector marked bullets HARMFUL when the session predated them or feedback was unrelated; two such marks auto-deleted good bullets | Prompt requires evidence the bullet was *followed* and caused failure; auto-remove needs ≥2 distinct feedbacks |
| UX review | Safety layer invisible (rejections not printed), `--feedback -` printed help, no concept docs, dead-end empty states | Per-delta output lines, feedback-injection notice, stdin fix, one-line option errors, `learn --help` epilogue, next-step hints |
| Real SaaS | Harness assumed an `attached_datamate_ids` field (only the fake had it) | Attachment verified via `GET /skills?datamate_id=17` (the sync's own query; filter verified honoured) |
| Real run | Leak scan / in-prompt detector false results | Fixed + `rescore.py` re-applied to all saved runs |
| Real run | Verifier collapsed every check on a naming deviation | C1 strict, C2–C6 evaluated on the model actually built; prompt names the entity |
| Independent code review | Hand-edited candidate could publish unlinted text; `rollback` resurrected the bad version; ReDoS in secret redaction (160 KB → 138 s); lint bypasses (zero-width, homoglyphs, `//host`, emails, `ses_` ids); CRLF dropped every bullet; duplicate ids lost text; HELPFUL/EDIT/REMOVE unbounded; no model timeout | Strict promote validation + canonical serialization, candidate cleared on promote/rollback, linear redaction with clip-first, NFKC + control-char stripping + link/scheme/email/id rules, `\r?\n` parsing, re-id duplicates, per-reflection budgets, 120 s abort, atomic writes |

## Gaps in the workspace / harness (to implement)

**Workspace product**
1. **Memory is not a team channel.** Workspace memory is mirrored per user (`visibility: "private"`,
   `memory-api.ts:52`), while the memory tool text says "team's memory". Team learning can only flow through skills today.
2. **No review/approval state for shared learnings.** A published skill is live for every member on the next sync
   (≤5 min poll). Needs pending → approved, with owner review, like Devin/CodeRabbit learnings.
3. **Prompt-injection surface.** Any uploader's `alwaysApply`/`applyPaths` skill lands in every member's system prompt
   with no size cap (`system.ts:141-160`, pilot-approved in `skill-sync.ts:15-34`). Add a load-time byte cap and
   provenance display for workspace-managed skills.
4. **Only the workspace owner can publish** (`skill-publish.ts:882`). A teammate's learnings can't flow back without
   ownership transfer — blocks multi-author team learning.
5. **No merge for concurrent learners.** A teammate running `learn` creates a project skill that shadows the workspace
   copy (`skill/index.ts:165-181`) and the fleet diverges. v1 policy: one maintainer checkout.
6. **`link` needs a TTY.** No non-interactive bind for CI/automation; the demo created and bound the workspace
   through the API directly.
7. Published skills come back `privacy: "private"` yet are readable by another tenant member via the workspace
   attachment — semantics worth confirming with the backend team.

**Harness**
1. **No session-end hook.** `session.idle` fires per turn; learning must be triggered explicitly (`learn reflect`).
2. **`trajectory` command is defined but not registered** in `src/index.ts`, so `trajectory export` prints help.
3. **No in-product eval/gate harness.** The gate lives in `experiments/`; real users have no verifier. Real signals
   to wire next: CI failures on the PR, PR review comments, explicit user corrections — each already supported as a
   `--feedback-kind`, but nothing captures them automatically.
4. **Reflector is ungrounded.** It sees the digest + feedback, not the repo. Letting it read (not write) the project
   — e.g. list `macros/` — would likely have fixed the `to_utc` miss.
5. Outcome telemetry (`agent_outcome`) goes to analytics, not a local store the learner can query.
6. Two parallel `run`s for the same user occasionally hit `database is locked` at startup.

## Comparison with codex-engineer's RSI

codex-engineer (AltimateAI/codex-engineer) learns from real use, not from a verifier:

| | altimate-code `learn` (this demo) | codex-engineer RSI |
|---|---|---|
| Signals | Any external text via `--feedback-kind verifier\|ci\|review\|user`, but only **passed in by hand** (the demo used a CI verifier) | **Captured automatically by hooks**: `user_correction` (each prompt checked by `correction_reason`), `review_correction` (PR review feedback), `retry_threshold` (≥3 consecutive measured tool failures); the audit then reads the whole transcript, with user messages as the strongest evidence |
| Trigger | Explicit `learn reflect` | Batched audit at task boundaries (`rsi audit`), reused when evidence is unchanged; owner lock against duplicates |
| What changes | Prose bullets in one playbook skill | Framework code, routed context modules and tests, each owned by a configured repository |
| Gate | A/B on held-out validation tasks (outcome lift) | Per-repair before/after regression test receipt (`candidate verify`); structural additions need 2 useful, actually-used trials; weekly pruning of stale or low-use entries |
| Distribution | `skill publish` → workspace sync | Auto-commit and fast-forward push to the owner repo, then the safe updater installs it |
| Safety | Curator lint, caps, no provenance in published file | Hook-free worker, isolated worktrees, no force-push, receipts verified by the launcher |

Takeaways for altimate-code:
1. **Feedback does not have to be CI.** The highest-volume real signal is the user correcting the agent mid-session, then PR review comments, then repeated tool failures. All three can be captured in altimate-code with existing plugin hooks (`chat.message`, `tool.execute.after`, `event`), recorded as typed signals, and fed to `learn reflect` at session end.
2. **Gating without a verifier.** Where no CI or verifier exists, use codex-engineer's trial rule (promote only after N real sessions where the lesson was used and nothing was corrected) plus pruning, and reserve the held-out A/B for teams that have tests.
3. **Learn more than prose.** codex-engineer repairs code and tests; the altimate analogue is skills that ship scripts or dbt tests, which are checkable rather than advisory.
4. **What codex-engineer lacks:** it proves each repair passes its own test, not that the agent got better overall. The held-out A/B here is the complementary measurement.

## Recommended next steps

1. Wire **automatic signal capture**: PR review comments + CI failure logs → `learn reflect --feedback-kind review|ci`
   (the highest-trust real-world signal; GitHub action or `altimate-code pr` hook).
2. Add **pending/approve** state for published learnings in the backend + a "Review learnings" view in the workspace app.
3. **Ground the reflector** with read-only repo access and require each new bullet to cite a file/macro it saw.
4. Re-run with more tasks, 2+ models and 5 runs/arm before quoting percentages externally.

## Cost

~150 real agent runs + ~20 reflector calls ≈ $160 of model spend (Vertex: Haiku 4.5 agent, Sonnet 4.6 reflector).
