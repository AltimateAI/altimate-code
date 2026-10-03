# `learn` v1 (local mode) — implementation plan (rev 2)

Branch: `feat/rsi-workspace-learning`. Package: `packages/opencode`. Rev 2 folds in: retrieval tiers instead of loading every lesson, the Codex plan review, dbt-agnostic defaults, PR review import and the nudge in v1, configurable limits, and a docs section comparing learn with memory and a knowledge base.

## Goal

Corrections, repeated tool failures and PR review comments become short lessons; a person approves them; the harness (never the model) puts the lessons relevant to each session into its prompt. The store can grow without limit while per-session context stays small. Works without a workspace; `--publish` stays as optional sharing.

## How lessons reach a session (the scaling design)

| Tier | What | Default limit (configurable) | Selection |
|---|---|---|---|
| Core | High-confidence, project-wide lessons | `learn.core_lessons` = 15 | Ranked by net helpfulness; a person can pin a lesson to core |
| Retrieved | Lessons relevant to this session | `learn.retrieved_lessons` = 15 | Local BM25 over lesson text + tags against the session's first user message and the file paths in the project tree it mentions; computed once when the session starts its first turn, then frozen for the session |
| Archive | Everything else | store cap `learn.max_stored` = 1,000 | Never loaded; searchable with `learn search` |
| Graduated | Lessons turned into a check or skill | — | Leave the prompt entirely (v1: manual `learn graduate <id>` marks it; automatic check generation is v2) |

Total per-session budget `learn.budget_tokens` = 1,500 caps the session-start section (core + retrieved). All limits in config and env.

**As the session moves on (append-only, cache-safe):**
- Each new user message: retrieval re-runs on that message; lessons not yet shown are attached to that message as a short "Team rules for this request" note.
- The agent reads or edits a file: lessons whose identifiers or paths match that file are appended once to that tool result.
- Never removed mid-session; each lesson shown at most once; per-session cap `learn.session_max_lessons` = 40.
- Compaction rebuilds the system section from every lesson shown so far.

Why: Voyager, ExpeL, AWM, Mem0/Zep keep an unbounded store and put only task-relevant items in context (Mem0: >90% fewer tokens than full context); ACE keeps everything in context and depends on long context plus caching. Our measurement: model-pulled lessons were skipped in 17% of relevant runs, so selection is done by the harness. Frozen-per-session selection keeps the prompt prefix stable for caching.

## Behaviour changes (was → now)

| Area | Was | Now |
|---|---|---|
| Storage | One playbook skill file; curator capped at 25 | Whole-set snapshot store (one atomic file per state: `approved.json`, `candidate.json`, `versions/`) holding lesson records; store cap `max_stored`; curator cap removed in favour of tiered loading |
| Delivery | Playbook auto-loaded as a skill (always for non-dbt projects; via `dbt_project.yml` otherwise) | "Team rules" section built by the harness from core + retrieved tiers, frozen per session; the old managed skill is no longer loaded (see Migration) |
| Lesson format | ≤240 chars, markup in prompt | ≤140 chars for new lessons, rule + exact identifier; prompt shows text only. Existing longer lessons are kept and flagged for shortening at next edit; promote validation accepts them (grandfathered by id) |
| Reflection timing | End of `run` only | `run` end (as now); TUI: threshold (3 open signals, after the turn) and idle debounce (10 min, cancelled by new activity); graceful exit flushes signals only; startup recovery reflects leftover signals after the first idle, not during the first turn |
| Duplicate work | Lock prevents conflicting writes only | Cross-process claim per signal batch before any model call; at most one reflection in flight per project; startup recovery bounded (default 3 reflections, 5 minutes) with backoff on failure |
| Bootstrap | — | `learn bootstrap`: separate opt-in; shows the scope (sessions, date range, model/provider) and asks before sending anything; bounded traversal of this project's root sessions (default last 30 days, 200 sessions), chronological, dedupe by message id, batched reflection |
| PR reviews | Manual `signal add` | `learn import-reviews`: GitHub only; checks `gh` is installed, authenticated and can read the repo; GraphQL review threads (resolved status) and review bodies of merged PRs; human authors only (bots excluded by type, `[bot]` suffix and a configurable list); paginated with checkpoints, rate-limit backoff, `--since`/`--limit`; dedupe ids qualified by host/repo/type; redacted; no commit-heuristic |
| Opt-in | Env/config flags | `learn enable` / `learn disable` (project config); enable offers bootstrap and review import |
| Nudge | — | TUI only, interactive sessions only: after a session with ≥2 corrections while learning is off, one tip in the session view; once per project ever, ≤3 times across projects; never after enable or "don't show again"; never in `run`, JSON or CI. The correction counter runs in memory only; the only write is the nudge's own shown/dismissed state in the global state dir (documented as the single exception to "off writes nothing") |
| dbt | Default `applyPaths: dbt_project.yml` | No dbt assumption anywhere |
| Migration | — | First run imports an existing learn-managed playbook (any `--name`), its pending candidate, versions and pending replacements into the new store, idempotently, tolerating malformed files (quarantined with a message); the managed skill is then excluded from skill auto-loading (marker-based) and `--publish` exports it on demand only for the workspace |

Unchanged: capture → reflect → curate (lint, redaction, dedupe, overlap/supersede/coexist, replacement step, verification flags) → promote/reject/rollback with the reviewed-hash check; locking; default-off.

## Implementation order

1. Snapshot store with lesson records + migration + skill exclusion.
2. Tiered, frozen-per-session injection with config limits.
3. `learn enable/disable`, config schema.
4. One recoverable scheduler (threshold, idle debounce, startup recovery) with claims and cost limits.
5. `learn bootstrap`.
6. `learn import-reviews`.
7. Nudge.
8. Docs.

## Docs (`docs/learn.md` + `research/.../learn-v1-results.md`)

User guide: what it does, quick start (`learn enable`), commands, config and limits, how lessons are selected, cost (tokens per lesson, per-session cost cached/uncached, reflection cost), privacy (what is stored, redaction, what is sent to which model), limitations, troubleshooting. Benchmark details: setup, arms, results tables, what works and what does not. A dedicated section, **"Learn vs memory vs a knowledge base"**:

| | Learn (lessons) | Memory | Knowledge base |
|---|---|---|---|
| What it holds | Short behavioural rules learned from corrections and review ("do X, not Y") | Facts and notes the agent chooses to save (configs, decisions) | Reference material: docs, schemas, runbooks |
| Who writes it | The learn pipeline from evidence, approved by a person | The agent, when it decides to | People, or ingestion of existing docs |
| How it reaches the agent | Harness selects relevant lessons each session | Injected by score, or read via a tool | Searched or retrieved on demand |
| Quality control | Lint, contradiction handling, human approval | Model judgement | Editorial process |
| Changes behaviour? | Yes, that is its purpose | Sometimes, indirectly | No, it informs |
| When to use | "Stop making this mistake" | "Remember this fact" | "Look this up" |

## Proof

- Tests for every behaviour row: default-off (no learn files, no model calls; nudge state only), store migration (custom names, malformed, interrupted, idempotent), atomic promote and reviewed hash, tier selection and limits, frozen selection across turns and resumed sessions, scheduler with fake timers (threshold, debounce cancel, exit flush, startup recovery bounds, claims across two processes), bootstrap bounds and dedupe, import-reviews with a fake `gh` (pagination, bots, resolved threads, rate-limit backoff, dedupe), nudge limits.
- Full CI-equivalent gates, no new failures vs main.
- Benchmark (all results saved in `learn-v1-results.md` and summarised in `docs/learn.md`), Gemini agent unless Claude access returns, 18 runs per arm unless noted:
  1. Baselines: no lessons; the 4 real lessons always loaded (old behaviour).
  2. Scale and retrieval: 4 relevant lessons hidden among 50, 300 and 1,000 lessons; measure retrieval recall (was each relevant lesson shown?), held-out pass, tokens per call, cache reads; compare with loading everything (300 only).
  3. Compression: the same lessons at full length vs compressed (≤140 chars).
  4. Topic switch: a two-request session where the second request needs a lesson unrelated to the first; with and without per-request additions.
  5. File hook: vague requests ("fix the failing build") whose lesson is only reachable through the touched file; with and without the file hook.
  6. Drift: outdated lessons + teammate corrections, 2 iterations, on the new store (strong and weak reflector).
  7. Bootstrap: lessons mined from the earlier benchmark sessions' history, then held-out pass with those lessons.
  8. Review import: lessons from a real repo's merged-PR review comments (read-only), reviewed by hand for quality; no pass rate claimed.
  9. Cost: reflection tokens and dollars per reflection, per bootstrap, per import.
- Real-CLI smoke: enable → correct in TUI → threshold reflection → show → promote → next session retrieves and follows the lesson; bootstrap preview; import-reviews against a real repo (read-only); nudge appears once.
