# `learn` v1 benchmark results

Date: 2026-10-02 → 03. Code: branch `feat/rsi-workspace-learning`; v1 arms on `cc543f4bfd`…`7891c95dd4`+`573b5d4be8`, post-fix arms on `c6c86a5395`. Old-behaviour baselines on `099ea68c90` (pre-v1). Harness: `experiments/rsi-workspace/harness/v1bench/` (in PR #1407, split out of the product PR) (`run_baselines.sh`, `run_all_v1.sh`, `run_fix_v1.sh`, `analyze_v1.py`). Full tables: `v1bench/results-before-fix.md`, `v1bench/results-fix-compare.md`.

## Setup

- **Agent:** `google-vertex/gemini-3.5-flash`. Claude on Vertex has been blocked by a GCP org policy since 2026-10-01, so all v1 numbers are Gemini; earlier Claude results (context-budget.md) are not directly comparable.
- **Reviewer / strong reflector:** `gemini-3.1-pro-preview`; **weak reflector:** `gemini-3.1-flash-lite`.
- **Tasks:** a dbt project (acme-shop). Held-out: 3 staging-model tasks reported in the headline (disputes, invoices, ledger-entries) + support-tickets reported separately (known naming ambiguity). Controls: an analysis that must keep integer cents (K4) and extending an existing model without restructuring it (K3). 18 runs per arm (held-out ×3 + controls ×3), unless noted.
- **Checks:** C1 location/name, C2 primary key + tests, C3 money (`cents_to_dollars`), C4 timestamps (`to_utc`, `_at`), C5 soft deletes, C6 build.
- **Lessons:** the 4 real lessons (money, timestamps, soft deletes, sources yml) hidden in pools of 50, 300 or 1,000 realistic lessons for other contexts; ~5% of the pool are "near" distractors that share staging vocabulary. Lessons ≤140 chars.
- **Retrieval recall:** for each run, the share of the lessons that task needs which were actually shown to the agent (from the per-session selection log `shown.jsonl`).
- **Scoring:** a run whose agent turn did not complete cleanly (exhausted turn budget, error, or missing session) scores as a failure on every check; denominators stay 9 held-out and 6 control runs per arm. The first version of these tables scored such runs on whatever files they left; 40 of 612 evaluations are incomplete, and 29 of them had received credit. Corrections were applied by rescoring the saved runs with the same verifier and task project; nothing was rerun. Held-out results moved by at most one run per arm; control results moved more (see below).
- **Spend:** 612 evaluations (topic-switch sessions count once), $409 agent cost, plus the drift learning-iteration sessions, reviewer, reflector and bootstrap calls.

## Headline results

| Question | Answer | Evidence |
|---|---|---|
| Do lessons help? | Yes | No lessons 2/9 held-out, 35/54 checks → 4 lessons 9/9, 54/54 |
| Does shortening lessons to ≤140 chars hurt? | No | 4 lessons: long 8/9 vs short 9/9 (baselines), long 9/9 vs short 8/9 (compression arms); every miss is an incomplete run. 50 lessons: 7/9 vs 7/9 |
| Does loading every lesson hurt quality? | Not on this model | All 50 / 300 / 1,000 lessons in the prompt: 9/9 each (one 50-lesson arm 8/9, an incomplete run) |
| What does loading everything cost? | Tokens on every call, growing with the pool | First call: 21.5k (4 lessons), 32.5k (300), 58.5k (1,000) on the pre-v1 prompt; $0.85/run at 1,000 vs $0.63 with retrieval |
| Does retrieval find the right lessons? | Yes up to 300; at 1,000 only after the fix | Recall 100% at 50 and 300; 80% → 100% at 1,000 after the fix |
| Does the file hook matter? | Most valuable single mechanism | Vague requests: recall 50% → 100%, held-out 5/9 → 9/9 |
| Do per-request additions fix topic switches? | Partly | Recall 43% → 60–77%; full pass noisy (4/9, 7/9); always-on 7/9 |
| Does learning retire outdated lessons? | Yes | Outdated lessons 0/9 → 9/9 after two learning iterations, strong and weak reflector |
| Does bootstrap work from history? | Yes | 8 past sessions → 5 corrections → 3 lessons → 9/9, $0.20, 54 s |
| Does retrieval over-apply lessons? | Sometimes | Analysis task that must keep cents: the staging cents lesson was applied there in 1 of 6 runs in 3 retrieval arms (file hook before and after the fix, 1,000 lessons before the fix) |

## 1. Baselines (old behaviour, pre-v1 code)

| Arm | Held-out | Checks | Support-tickets | Control |
|---|---|---|---|---|
| No lessons | 2/9 | 35/54 | 0/3 | 5/6 |
| 4 real, full length | 8/9 | 48/54 | 3/3 | 6/6 |
| 4 real, ≤140 chars | 9/9 | 54/54 | 2/3 | 4/6 |
| All 50 in prompt, full length | 9/9 | 54/54 | 2/3 | 6/6 |
| All 50 in prompt, ≤140 chars | 9/9 | 54/54 | 1/3 | 6/6 |
| All 50 in prompt (pool file) | 8/9 | 48/54 | 2/3 | 5/6 |
| All 300 in prompt | 9/9 | 54/54 | 2/3 | 6/6 |
| All 1,000 in prompt | 9/9 | 54/54 | 1/3 | 5/6 |

First-call input tokens and cost per run on this prompt: 4 lessons 21.5k / $0.60–0.67; 50 lessons 23.2k / $0.64; 300 lessons 32.5k / $0.72; 1,000 lessons 58.5k / $0.85.

Without lessons the agent misses money (C3 3/9) and soft deletes (C5 3/9).

## 2. Scale and retrieval (v1 code)

Core tier off (`core=0`), session-start retrieval 15, file hook on, unless noted.

| Arm | Held-out | Checks | Control | Recall | All needed shown | Shown/run | 1st-call tokens | $/run |
|---|---|---|---|---|---|---|---|---|
| 50 lessons | 9/9 | 54/54 | 4/6 | 100% | 12/12 | 19.4 | 21.3k | 0.68 |
| 300 lessons | 9/9 | 54/54 | 6/6 | 100% | 12/12 | 39.4 | 21.3k | 0.65 |
| 1,000 lessons (before fix) | 6/9 | 51/54 | 3/6 | 80% | 6/12 | 37.8 | 21.3k | 0.66 |
| **1,000 lessons (after fix)** | **9/9** | **54/54** | **4/6** | **100%** | **12/12** | 40.0 | 21.4k | 0.63 |
| 300, shipped defaults (core 15) | 9/9 | 54/54 | 4/6 | 97% | 11/12 | 40.0 | 21.6k | 0.65 |
| 300, text only (no path triggers) | 9/9 | 54/54 | 6/6 | 90% | 9/12 | 26.9 | 21.3k | 0.60 |
| 300, all in prompt | 9/9 | 54/54 | 6/6 | 100% | 12/12 | 300 | 26.7k | 0.70 |

- Before the fix, at 1,000 lessons the timestamp lesson was missed: its words do not match "add a staging model", and broad lessons (`models/**`, `**/*.yml`) filled the file hook's cap of 5. Ranking file-hook lessons by path specificity fixed recall (80% → 100%) and the held-out score (6/9 → 9/9).
- Retrieval keeps the first call at ~21.4k tokens whatever the pool size. Loading everything costs +5.4k tokens per call at 300 lessons (v1 prompt) and +37k at 1,000 (pre-v1 prompt); per run that is within noise at 300 but +34% at 1,000 ($0.85 vs $0.63), even with Gemini's prompt caching.
- Precision is low (~6% of shown lessons are needed) but cheap: ~40 short lessons ≈ 1.2k tokens.

## 3. Compression

| Arm | Held-out | Checks | Control |
|---|---|---|---|
| 4 real, full | 9/9 | 54/54 | 5/6 |
| 4 real, ≤140 chars | 8/9 | 48/54 | 4/6 |
| 50 (retrieval), full | 7/9 | 50/54 | 4/6 |
| 50 (retrieval), ≤140 chars | 7/9 | 51/54 | 6/6 |

No measurable loss from shortening: the one short-lesson miss is a run whose turn did not complete, which scores as a failure. (These 50-lesson retrieval arms ran before the file-hook fix; their misses are the retrieval issue in section 2, equal in both arms.)

## 4. Topic switch (two requests in one session; scored on the second)

| Arm | Held-out | Checks | Control | Recall | Shown before req. 2 | Added after req. 2 |
|---|---|---|---|---|---|---|
| No lessons | 0/9 | 22/54 | 6/6 | – | – | – |
| 4 real, always on | 7/9 | 42/54 | 6/6 | 100% | 100% | 0% |
| 300, session start only | 5/9 | 44/54 | 5/6 | 43% | 43% | 0% |
| 300, + per-request additions | 4/9 | 49/54 | 6/6 | 77% | 43% | 33% |
| 300, + per-request (after fix) | 7/9 | 49/54 | 6/6 | 60% | 43% | 17% |

- Per-request additions raise recall and checks but not reliably full passes; this is the weakest mechanism. Second requests share few words with the lessons they need.
- Even with the lessons always present, the second request scores lower (7/9) than a fresh session (9/9): a long first turn makes the second task harder regardless of lessons.

## 5. File hook (vague requests that never name the convention)

| Arm | Held-out | Checks | Control | Recall |
|---|---|---|---|---|
| No lessons | 3/9 | 42/54 | 4/6 | – |
| 4 real, always on | 9/9 | 54/54 | 6/6 | 100% |
| 300, file hook off | 5/9 | 45/54 | 5/6 | 50% |
| 300, file hook on (before fix) | 9/9 | 54/54 | 4/6 | 100% |
| 300, file hook on (after fix) | 9/9 | 54/54 | 4/6 | 100% |

The file hook is what makes retrieval work when the request is vague: the lessons arrive when the agent opens or writes the files they apply to.

## 6. Drift (outdated lessons, teammate corrections, 2 iterations)

| Arm | Held-out | Checks | Control |
|---|---|---|---|
| Outdated lessons, no learning | 0/9 | 3/54 | 5/6 |
| After learning, strong reflector | 9/9 | 54/54 | 5/6 |
| After learning, weak reflector | 9/9 | 54/54 | 5/6 |

Strong reflector: 6 corrections in iteration 1, 0 in iteration 2 (all first attempts approved); the 4 outdated lessons were edited in place (same ids, new text). Weak reflector: 6 and 6 corrections; it retired all 4 outdated lessons and added replacements over two iterations (final 5 lessons, 9/9). One reflection took 70 s with the strong model, 7–9 s with the weak one.

## 7. Bootstrap (from past sessions)

8 past sessions → 5 corrections found → 4 reflections → 3 candidate lessons (money, soft deletes, timestamps; the sources-yml lesson was not recovered) → promoted → **9/9 held-out, 54/54 checks, control 4/6**. Cost: 28k input + 6.7k output tokens, **$0.20**, 54 s.

## 8. PR review import (live, read-only, `--dry-run`)

`AltimateAI/altimate-code`, last 14 days, 10 merged PRs: 291 comments fetched → 17 kept after dropping bots, PR-author replies, duplicates and short "LGTM"-style comments. The first live run exposed that PR-author replies were being kept (72 signals); fixed before this run. Lesson quality from imported reviews was not scored: on this repository many "human" review comments are long AI-written review bodies posted by people, which import as review signals.

## 9. Cost

| Item | Measured |
|---|---|
| A lesson in the prompt | ≤140 chars ≈ ≤35 tokens |
| Session-start section (15 retrieved) | ~0.3–0.5k tokens on the first call; cached after |
| Loading 300 / 1,000 lessons instead | +5.4k / +37k tokens on every call; +$0.05 / +$0.22 per run |
| One reflection | ~7k input + ~1.7k output tokens (bootstrap average); ~$0.05 with Gemini 3.1 Pro |
| Bootstrap, 8 sessions | $0.20 |
| Agent run, retrieval arms | $0.60–0.73, independent of pool size |

## Control failures

Most control failures are runs whose turn did not complete (usually an exhausted turn budget), which score as failures on all four control checks; they occur with and without lessons (no lessons: 5/6 and 4/6). Over-application, where only K4 fails because a convention was applied to the analysis, appears in 1 of 6 runs in three retrieval arms and nowhere else.

## What works

- Harness-pushed lessons, retrieved per session, with path triggers and the file hook: 100% recall up to 1,000 lessons after the fix, held-out 9/9.
- Retiring outdated lessons through corrections, with strong and weak reflectors.
- Bootstrap from history, cheaply.
- Short lessons.

## What doesn't (yet)

- **Topic switches:** per-request additions recover only part of what a second, unrelated request needs. Pin critical lessons (always in core) or start a new session.
- **Over-application from keyword retrieval:** a lesson scoped to staging models can be retrieved for an analysis request that mentions the same word ("cents") and is sometimes applied there (1 of 6 control runs in 3 retrieval arms). Showing the lesson's scope reduced but did not remove it. Candidate follow-up: weaker framing for retrieved lessons than "Team rules for this request", or require path compatibility before showing a scoped lesson.
- **Retrieval vs loading everything:** on Gemini, loading all 1,000 lessons scored as well as retrieval; retrieval's value is cost (−26% per run at 1,000) and context headroom, not quality. Not measured on Claude (blocked).
- **One project, one model, 9 held-out runs per arm:** differences of one run are noise.
- **Verifier and fixtures are kept as run, with known weaknesses:** C3/C4 recognise the conventions by the macro call in SQL rather than by comparing every output value; some synthetic seed rows are inconsistent (for example refunds dated before their orders); and `to_utc` does not perform a real timezone conversion. Tightening any of these changes what passes, so it needs a rerun, not a rescore.
