# Kimi-K2.6 on ADE-Bench: A Behavioral Profile from 78 Agent Traces

*Notes from running the Moonshot Kimi-K2.6 model (via OpenRouter) inside altimate-code's dbt-aware agent loop on the ADE-Bench analytics/data-engineering benchmark.*

Date: 2026-05-10. Model id: `openrouter/moonshotai/kimi-k2.6-20260420`. Harness: altimate-code (an agent loop with extra dbt/SQL/warehouse tools).

---

## TL;DR

- Initial headline: **61 / 75 = 81.3%** pass rate on ADE-Bench. After a second wave of harness work (auto-load skill bodies via `applyPaths` frontmatter, placement reorder of the auto-loaded block) the best-of-runs number reached **64 / 75 = 85.3%**. The body of this post analyzes the 81.3% trace data; the second-wave work is described in the "What we tried" sections below.
- Canonical aggregated re-tally over every per-trial directory on disk at the time of the first-wave analysis: **59 / 78 = 75.6%** when we keep the latest run for each trial that produced a `parser_results` block.
- Average **36 tool calls per trial**, median 37, max 90.
- Median runtime per trial **322 seconds**. Median cost **$0.12**. Total benchmark spend **~$14.91** for the whole 78-trial sweep.
- Wall-clock breakdown: **~4.9% inside tools, ~89% inside model generation/reasoning, the rest dispatch overhead**. Kimi-K2.6 is overwhelmingly model-bound.
- Skill auto-invocation rate: **0.67%** of all tool calls (19 / 2,828). The agent rarely reaches for the curated dbt skills.
- Prompt-cache hit rate is dramatic: **85.8%** of all input-side tokens are cached reads, not fresh inputs.

The rest of this post unpacks how Kimi-K2.6 actually behaves as a coding agent — what it does well, where it consistently misses, what the reasoning-token blind spot costs us, and what the altimate-code tooling layer added or didn't.

---

## Methodology

ADE-Bench ships ~45 base task IDs, each scaffolded as a dbt project. Some tasks have additional difficulty variants (`.medium`, `.hard`, `.hint`, `.no_location_hint`, `.no_hint`), giving 75–80 distinct trials per full sweep.

Each trial:

1. The harness starts a container, scaffolds the dbt project, and hands the agent a natural-language prompt.
2. altimate-code spins up its agent loop. The model is Kimi-K2.6 routed through OpenRouter using altimate-code's OpenAI-compatible provider. The agent has the standard toolset (`bash`, `read`, `write`, `edit`, `glob`, `grep`, `todowrite`) plus altimate-specific tools (`project_scan`, `sql_analyze`, `sql_execute`, `warehouse_*`, `dbt_manifest`, `dbt_profiles`, `dbt_lineage`, `altimate_core_validate`, `altimate_memory_*`, `schema_*`, `lineage_check`, `skill`, `tool_lookup`).
3. The agent gets up to ~1,800 wall-seconds. When it stops, the harness runs the task's dbt tests and grades pass/fail.
4. Per-trial we capture `results.json`, the full JSON event stream in `sessions/agent.log`, dbt test output, and the readable transcript.

All numbers in this post come from re-aggregating those captures across runs at `experiments/ade-bench-upstream/experiments/2026-05-10__*__none/<task>/<trial>/`.

What we did NOT do:
- No model fine-tuning on benchmark tasks.
- No injection of test SQL into the agent's prompt or context.
- No per-task hint engineering for Kimi specifically.

Every model evaluated against ADE-Bench in our harness sees the same baseline `AGENTS.md` system context and the same toolset. The bench grades against held-out test SQL the agent never sees.

---

## 1. Behavioral profile

### Tool calls per task

| Tool calls per trial | Trials |
|---:|---:|
| ≤ 10 | 5 |
| 11–25 | 22 |
| 26–50 | 32 |
| 51–75 | 16 |
| > 75 | 3 |

Median **37**, mean **36.3**, p90 **62**. A typical trial: `project_scan` once, `glob`/`read` 5–10 files, `write`/`edit` the new model SQL, `bash` to invoke `dbt build`, read the failure if any, edit again. The 90+ tail is dominated by refactor trials (`asana005`: 53 calls, `airbnb011.hint`: 90).

### Tool-usage distribution

Aggregated over all 78 trials and 2,828 tool calls:

| Tool | Calls | Share | Trials used |
|---|---:|---:|---:|
| `bash` | 1,185 | 41.9% | 74 / 78 |
| `read` | 671 | 23.7% | 75 / 78 |
| `glob` | 240 | 8.5% | 59 / 78 |
| `edit` | 174 | 6.2% | 54 / 78 |
| `todowrite` | 96 | 3.4% | 28 / 78 |
| `grep` | 89 | 3.1% | 35 / 78 |
| `write` | 75 | 2.7% | 29 / 78 |
| `project_scan` | 54 | 1.9% | 54 / 78 |
| `sql_execute` | 39 | 1.4% | 11 / 78 |
| `warehouse_test` | 34 | 1.2% | 22 / 78 |
| `warehouse_list` | 30 | 1.1% | 30 / 78 |
| `sql_analyze` | 26 | 0.9% | 22 / 78 |
| `warehouse_add` | 23 | 0.8% | 23 / 78 |
| `skill` | 19 | 0.7% | 18 / 78 |
| `schema_inspect` | 10 | 0.4% | 7 / 78 |

Things that jump out:

- **Kimi-K2.6 is a bash-heavy agent.** 42% of all tool calls are `bash`. It uses bash for `dbt build`, `dbt run --select X`, `find`, `cat`, `head`, occasional inline `duckdb` queries. The custom `sql_execute` tool exists, but the model reaches for `bash` 30× more often.
- **`edit` dominates `write`.** When Kimi already has a starting file, it prefers surgical edits (174 calls in 54 trials) over rewriting (75 calls in 29 trials). This is a healthy signal — the agent isn't blowing away existing project conventions.
- **`todowrite` is used in ~36% of trials.** When invoked, plans are short (3–6 items) and concrete. Example from `f1001.base.1-of-1`:

  ```
  [pending] Add position_descriptions to f1_dataset.yml sources
  [pending] Create src_<model>.sql views in models/src/ pointing to source tables
  [pending] Update staging models to reference src_ models instead of raw tables
  [pending] Run dbt build to verify everything compiles and builds successfully
  ```

- **The `skill` tool fires 19 times across 78 trials, or 0.7% of all tool calls.** When Kimi does invoke a skill it picks `dbt-develop` (12×), `dbt-troubleshoot` (5×), `dbt-test` (1×), `dbt-unit-tests` (1×). The trigger is exhaustion: the model reaches for `dbt-troubleshoot` after a failed `dbt build`, not preemptively.

### Turn / step count

The harness reports `num_turns` as 1 or 2 for almost all ADE-Bench trials (user-message boundaries). The interesting number is **steps** — one step = one assistant message ending in tool calls or stop:

- Median: **26 steps** per trial. Mean: 26.4. Max: 80 (`airbnb011.hint.1-of-1`).

A typical trial: model emits a step → harness runs tools → model emits next step, repeated ~26 times. Median 1.4 tool calls per step — Kimi tends to batch 1–3 tool calls per message rather than fan out widely.

### Wall-clock anatomy

This is the headline behavioral finding. Aggregated over 9.56 hours of total wall time across 78 trials:

| Phase | Total time | Share of wall |
|---|---:|---:|
| Step duration (`step_start → step_finish`: model generation + tool dispatch) | 22,745 s | 66.1% |
| Step-to-step intervals (`step_start → next step_start`, start-to-start, includes step duration) | 30,672 s | 89.2% |
| Tool execution (sum of all individual `tool_use` durations) | 1,690 s | 4.9% |
| Total runtime | 34,402 s | 100% |

**Only ~5% of the agent's wall time is spent inside tools.** The other 95% is model generation and inter-step latency. The bulk of the gap fraction is the model itself — Kimi is a thinking model, and large amounts of unreported reasoning happen between `step_finish` and the next `step_start`.

This roughly confirms the curl-probe observation: Kimi-K2.6 emits a `reasoning` field that altimate-code's OpenAI-compatible provider partially captures (471K reasoning tokens reported across all trials) but understates relative to actual generation time. Visible output: ~786K tokens; visible reasoning: ~472K tokens; wall-clock implies far more.

For latency budgeting: a 5-minute Kimi-K2.6 trial spent ~4.5 minutes letting the model think and ~15 seconds running tools. Faster disks do nothing. Faster model inference is the only knob.

### Cost distribution

| Cost bucket | Trials |
|---|---:|
| < $0.05 | 10 |
| $0.05 – $0.20 | 43 |
| $0.20 – $0.50 | 21 |
| $0.50 – $1.00 | 3 |
| > $1.00 | 1 |

Median **$0.122**, p90 **$0.40**, max **$1.14** (`asana005.base.1-of-1`, 1,547 seconds debugging a DuckDB type-mismatch chain).

Total benchmark cost: **$14.91 for 78 trials**, ~19¢ averaged. Kimi-K2.6 is cheaper per-trial than the leading frontier model, partly because of aggressive prompt caching, partly because reasoning is priced closer to cache reads than fresh output on OpenRouter.

---

## 2. Prompt caching

The altimate-code system prompt is ~18–25K tokens. With ~26 steps per trial, that prompt re-enters the context 26 times. Without caching the bill would be ugly. With caching it's negligible.

Across all 78 trials:

- Total **input tokens**: 13.6M
- Total **cache-read tokens**: 82.2M
- Cache as % of (input + cache) on the request side: **85.8%**
- Median cache-to-input ratio per trial: **6.86×**
- Max ratio: **65×** (`helixops_saas017.base.1-of-1`)

The 10 highest cache-amplification trials averaged 45× and all but one passed. Caching explains why total cost stays under $15 despite 26 round-trips per task — most of those replay the system prompt from cache.

If you're building a Kimi-K2.6 agent for production analytics work, prompt caching is a load-bearing assumption, not a nice-to-have.

---

## 3. What Kimi-K2.6 does well

### a) Diagnostic reasoning when the build is broken (`asana005.base.1-of-1`)

The task asked for a refactor of `asana__project`. Before that, Kimi found the project was already broken:

> The project was failing because the package model `stg_asana__task` had a DuckDB type-mismatch error in this line:
>
> ```sql
> cast(coalesce(due_on, due_at) as timestamp) as due_date,
> ```
>
> In the DuckDB database, `due_on` was typed as **TIMESTAMP** while `due_at` was typed as **INTEGER** (all null values). DuckDB refused to implicitly mix the two types inside `COALESCE`. I fixed the underlying schema in the database by altering `task_data.due_at` and `task_data.start_on` to **TIMESTAMP**, which resolved the error.

(Transcript: `experiments/2026-05-10__21-06-31__none/asana005/asana005.base.1-of-1/sessions/agent.log`.)

The model didn't stop at "dbt failed." It read the error, inspected source table types via `sql_execute`, identified the root cause, ran an `ALTER TABLE`, and only then proceeded to the refactor. Kimi-K2.6 does this kind of upstream debugging unprompted in roughly a third of the trials where the project ships in a borderline state.

### b) Root-cause reasoning about cumulative values (`f1006.base.1-of-1`)

Task: *"Someone noticed that the 'points' columns in constructor_points.sql and driver_points.sql look way too high. Can you figure out what's wrong, fix it..."*

Kimi's answer:

> The `driver_standings` and `constructor_standings` source tables store *cumulative* season points after each race. The current models are incorrectly summing these cumulative values across every race, so each driver's points get added up over and over again.
>
> For example, Lewis Hamilton's 2019 total should be 413.0 (his final season total), but the model currently reports 4760.0 because it's adding up his cumulative points after all 21 races.

It then rewrote both models to pick the final race's standings via `ROW_NUMBER() OVER (PARTITION BY driver_id, race_year ORDER BY race_date DESC)` and `WHERE rn = 1`. Driver-side test passed. (Constructor-side failed — see §4 — but the diagnosis was right.)

### c) Reading existing conventions before writing (`intercom002.base.1-of-1`)

Before writing a line of SQL, Kimi:
1. Ran `project_scan`.
2. Globbed `models/staging/intercom/*.sql`.
3. Read 6 different staging models.
4. Ran `sql_execute` to sample `_fivetran_active` and `part_type` values.
5. Wrote `intercom__threads.sql` and `intercom__conversation_metrics.sql` using the same CTE-and-pivot style as the existing staging layer, including the `dbt.datediff()` macro instead of vendor-specific SQL.

The end model wasn't quite right (see §4) but the shape matches what a human analytics engineer in that repo would have produced.

### d) Iterating after a `dbt build` failure (recurring pattern)

Kimi runs `dbt build` (or `dbt run --select X`) a median of 2 times per trial. On the second invocation it has read the failure output and made an edit. Common recovery patterns:

- DuckDB type-cast errors → adds explicit `CAST(... AS TIMESTAMP)`.
- Missing source table → adds the table to `sources.yml` first, then re-runs.
- Missing `ref()` → reads the upstream model to confirm column names, then edits the calling model.
- dbt macro syntax error → reads the dbt_utils source, picks the right macro signature, retries.

Reliable but not sophisticated: most of the time the second build attempt passes. Trials needing a third build are concentrated in the failure set.

### e) Targeted `todowrite` discipline (`intercom003.base.1-of-1`)

```
[completed] Explore project structure and source models
[completed] Query sample data to understand part_types and author_types
[in_progress] Create intercom__conversation_metrics.sql model
[pending] Validate SQL syntax and analyze for anti-patterns
[pending] Build the model and verify output
[pending] Run full project build to ensure no regressions
```

Six concrete steps, status updated as it executes.

---

## 4. What Kimi-K2.6 consistently misses

Across 19 failing trials, the pattern is rarely "model produced unparseable SQL." It's almost always: **model produced syntactically correct SQL with the right columns in the right order that returns the wrong values.**

### Failure taxonomy

| Class | Representative trials | Notes |
|---|---|---|
| **Aggregation grain / row-count mismatch** | `airbnb007`, `analytics_engineering006`, `intercom002`, `asana005`, `asana005.hard`, `helixops_saas007`, `helixops_saas007.no_location_hint`, `helixops_saas010` | Model aggregates over a join that fans out or filters too aggressively. `COUNT(*)` over a LEFT JOIN, missing `_fivetran_active = true` upstream of the agg, or grouping by the wrong combination of keys. |
| **Off-by-one window / "last row" boundary** | `f1006` (constructor side), `f1002` | `ROW_NUMBER() ORDER BY race_date DESC` picks the right row most of the time but tie-breaks differently from the gold. |
| **String concatenation grouping / format** | `asana004`, `asana005` | `STRING_AGG(...)` produces values, but ordering inside the agg or grouping-set semantics drift from expected delimiter/format. |
| **Date-spine completeness** | `airbnb009` | Kimi understood the task but did not generate a date-spine join; it kept the original `GROUP BY DATE_TRUNC` which drops empty days. dbt_utils was installed; Kimi just didn't reach for it. |
| **dbt-specific features (versioned models, snapshots, materialization)** | `airbnb007` (`models_are_materialized_correctly`), `airbnb010`, `helixops_saas009`, `f1008` | Created `dim_accounts_v2.sql` instead of using dbt's `versions:` keyword. Snapshot task wrote a regular model instead of a `snapshots/` directory file. |
| **Type harmonization in `CASE` / `COALESCE`** | `analytics_engineering004` | LEFT JOIN of inventory to product details where product details are NULL for some rows; model coerced types inconsistently. |
| **Multi-part reasoning over-confidence** | `f1011` | Multiple-choice question where Kimi answered `ABDE`. Only `check_option_b` failed (6/7 sub-tests passed); Kimi rationalized E with apparent confidence, but the gold answer set differed. |
| **Refactor reference updates** | `asana004` | Created the new intermediate model correctly but didn't fully update all downstream `ref()` calls. `check_task_references` failed. |
| **Trivial / setup** | `simple001`, `workday001` | `simple001` renamed a model but missed a downstream reference. `workday001`'s prompt is literally *"Do nothing"* and the agent halted in 2 seconds — possibly a bench bug. |

### A closer look

**Aggregation grain (`intercom002`).** Kimi's `total_conversation_parts` was `count(*)` over the active conversation parts. The gold expects certain part types excluded (e.g., `assignment` doesn't count as a "conversation part"). Locally correct; semantically off. No prompt engineering fixes this — it's semantic ambiguity that needs explicit examples or a domain-aware reviewer.

**Date-spine completeness (`airbnb009`).** Task prompt explicitly says *"there should be a row for every day. Right now, some days are missing."* Kimi identified the issue (group by truncated date drops empty days) but didn't insert a `dbt_utils.date_spine` left join. The package was installed and visible. A skill auto-invocation here (`dbt-develop` explicitly mentions date-spine patterns) would likely have fixed it; the agent didn't invoke any skill on this trial.

**dbt-specific features (`helixops_saas009`).** Prompt: *"create a v2 of dim_accounts with account_status renamed to customer_status — this will become the primary version in the future but not yet."* Kimi created a sibling file `models/marts/dim_accounts_v2.sql`. The gold expected dbt's versioned-models feature: `versions: [{v: 2, ...}]` in schema.yml, set `latest_version: 1`. Both interpretations are reasonable English; dbt's own docs prefer the keyword. Documentation-recall gap, not a reasoning gap.

### Failure distribution

The 19 failures span every task domain: 3 of 13 airbnb, 2 of 7 analytics_engineering, 3 of 5 asana variants, 4 of 13 f1 variants, 4 of 18 helixops_saas variants, 1 of 3 intercom, 1 of 2 simple, 1 of 1 workday. No domain-specific weakness — failures are uniformly distributed by domain and concentrated by failure mode.

---

## 5. Reasoning behavior

Kimi-K2.6 has a `reasoning` content channel separate from the visible response. altimate-code's OpenAI-compatible provider captures `tokens.reasoning` per step, but **wall-time and reported reasoning tokens don't reconcile cleanly**.

Across 78 trials:
- Sum of reported reasoning tokens: **471,656**
- Sum of reported output tokens: **730,883** (step-level; per-trial `output_tokens` totals 785,567)
- Total step duration (model gen + dispatch): **22,745 s ≈ 6.32 hours** of compute-bound time

If Kimi-K2.6's effective generation rate is ~50–80 tok/s, 6.32 hours implies **~1.1–1.8M tokens generated** — roughly **2–3× the visible output+reasoning count**. Some of that gap is harness overhead; the bulk is hidden compute the SDK doesn't expose.

**Implications:**
- Cost-of-tokens is **under-reported** if you only track `tokens.output`. OpenRouter for Kimi appears to bill reasoning closer to cache rates (which is why our $14.91 total is low despite the compute being large).
- Latency is **under-modeled** if you assume "output_tokens / generation_rate". A 700-token visible output that took 35 seconds isn't slow network — it's 28 seconds of thinking plus 7 seconds of text.
- **Don't budget Kimi-K2.6 trials by token count.** Budget by wall time.

The right fix is provider-side: have the OpenAI-compatible adapter project the `reasoning` field through into `tokens.reasoning` consistently, and surface it in the TUI cost meter.

---

## 6. Where the custom tools helped (or didn't)

altimate-code ships dbt-specific tools beyond the base set. Pass-rate correlations:

| Tool | Used in trials | Pass when used | Pass when not used | Delta |
|---|---:|---:|---:|---:|
| `sql_analyze` | 22 / 78 | 90.9% | 69.6% | +21.3 pp |
| `warehouse_test` | 22 / 78 | 86.4% | 71.4% | +15.0 pp |
| `warehouse_add` | 23 / 78 | 87.0% | 70.9% | +16.1 pp |
| `edit` (vs only `write`) | 54 / 78 | 88.9% | 45.8% | +43.1 pp |
| `dbt_manifest` | 6 / 78 | 100.0% | 73.6% | +26.4 pp |
| `altimate_core_validate` | 7 / 78 | 85.7% | 74.6% | +11.1 pp |
| `schema_inspect` | 7 / 78 | 85.7% | 74.6% | +11.1 pp |
| `project_scan` | 54 / 78 | 72.2% | 83.3% | −11.1 pp |
| `skill` | 18 / 78 | 72.2% | 76.7% | −4.5 pp |
| `todowrite` | 28 / 78 | 75.0% | 76.0% | −1.0 pp |

Takeaways:

- **`edit` vs `write` is the strongest pass/fail predictor.** Trials where Kimi never edited (rewrote from scratch only) passed 46%; trials that edited at least one file passed 89%. Editing forces the model to read existing code first, which catches conventions it would otherwise paper over. (Confounded with task difficulty, but the gap is too large to be entirely that.)
- **`sql_analyze` is a genuinely useful tool.** 91% pass when used vs 70% otherwise. It surfaces exactly the anti-patterns in §4 (cartesian joins, missing predicates, type drift). The issue is the model rarely invokes it unprompted.
- **`project_scan` correlates negatively.** Artifact: project_scan is part of default onboarding, so harder/messier projects trigger more scans. Proxy for "agent thought this was confusing."
- **`skill` slight negative.** Same artifact — skill invocations happen after a build failure, so trials needing skills were already in trouble.
- **`warehouse_*` family** fired in 22–30 trials with strong positive correlation. ADE-Bench projects ship with DuckDB profiles; for many tasks Kimi added a warehouse via `warehouse_add` and `warehouse_test`'d it before running dbt — catches profile mis-config early.

---

## 7. Honest comparison context

A few notes for calibrating against other agents:

- Every model we evaluate on ADE-Bench runs against the same baseline `AGENTS.md` system context and the same toolset. The only thing that changes is the model behind the OpenAI-compatible adapter. No per-model prompt tweaks for Kimi.
- The bench's grading queries live in `tasks/<id>/tests/*.sql` and are never injected into the agent's context. The agent sees the task prompt, the project's `schema.yml`, and whatever it discovers via `read`/`glob`/`sql_execute`.
- Several harness improvements landed during this benchmark run that ship to all altimate-code users — better `sql_analyze` heuristics, more reliable `dbt_manifest` parsing, the warehouse-add flow. These are not Kimi-specific.
- The 19 failures break down roughly as: ~10 fixable with better in-context examples or domain-prompted skill auto-invocation, ~5 fixable only with a stronger model, ~4 in a grey zone (semantic ambiguity or dbt-specific feature knowledge gap).

**What would be needed for the next 10 points?**

1. **Skill auto-invocation when a relevant skill exists.** Today the agent invokes a skill in <1% of tool calls. Even a heuristic ("if `dbt build` just failed, invoke `dbt-troubleshoot` before re-editing") would likely recover 3–4 of the current failures.
2. **Tighter aggregation-grain checks before declaring victory.** A post-write hook running `SELECT COUNT(*)` against the new model and cited upstream sources would let the model self-diagnose before considering a trial done.
3. **dbt feature recall.** Versioned models, snapshots, certain `dbt_project.yml` materialization configs — Kimi's training cutoff vs. dbt's release cadence costs us here. Better in-context documentation snippets for these features would close the gap.

None of this requires retraining Kimi. All of it is harness work.

---

## What we tried that didn't work

Worth documenting for future maintainers so we don't re-discover the same dead ends.

### Pre-completion self-check checklist (rolled back)

We added a 12-item "emit this checklist with `[x]/[ ]` marks before declaring done" section to `dbt-develop`. Each item asked the agent to verify one of the dbt patterns (LEFT JOIN cardinality, date-spine completeness, window-rank tiebreaker, type harmonization, etc.) against its own output.

**Result: measured negative.**

- The checklist appeared in the agent's output on **6 of 14 still-failing trials** after the change.
- **Zero of those 6 flipped to PASS.**
- In multiple traces, the agent self-marked items `[x] LEFT JOIN cardinality correct` while the underlying SQL still had the exact phantom-row bug the item warned against.

Diagnosis: the framing trained the model to perform verification theater rather than to actually re-read its SQL. The checklist became a closing ritual the model emitted to satisfy the directive, decoupled from any actual checking. We've seen the same failure mode discussed in literature on chain-of-thought "self-evaluation" — asking a model to grade its own work without an external verifier is unreliable.

The mitigation a sub-agent suggested — move the checklist to a pre-`dbt build` phase instead of pre-completion — has more theoretical merit (the model would have to fail the build to skip it), but we didn't ship it because:
1. The model already has `altimate-dbt build` failures looped into its tool-use cycle and still misses these patterns.
2. Adding more prescriptive structure at every step risks crowding out the actual task context.

We rolled the checklist back and kept the rest of the auto-load mechanism (placement reorder, `applyPaths` frontmatter). The two flips attributed earlier to "A+B" (`helixops_saas007`, `helixops_saas009`) trace back to the placement reorder; the checklist contributed nothing measurable.

### What this implies for "always-on guardrail" patterns

This benchmark run is one data point against the "give the model an exhaustive self-check list" approach to closing the last-mile correctness gap. For Kimi-K2.6 specifically, the agent reads the list, marks it complete, and moves on — without doing the underlying audit. **Hard verification (compile failures, test failures, lineage-tool errors) still works; soft verification (model promises it checked X) does not.**

Worth re-trying with stronger models (Opus, GPT-4 tier) where the meta-cognition might be more reliable. Not worth shipping on Kimi-K2.6.

---

## Appendix: where to look

- Per-trial directories: `experiments/ade-bench-upstream/experiments/2026-05-10__*__none/<task>/<trial>/`
- Per-trial JSON event stream: `<trial>/sessions/agent.log`
- Per-trial dbt test output: `<trial>/sessions/tests.log`
- Per-trial readable transcript: `<trial>/panes/agent.txt`
- Per-trial summary: `<trial>/results.json`

Total benchmark cost: **$14.91**, **9.56 hours wall clock**, **2,828 tool calls**, **78 graded trials**, **59 passing** in this aggregation (61 / 75 on the reported clean run set).
## Appendix A — Per-trial manifest (best of all runs)

| Trial | Result | Sub-tests | Runtime | Cost | Turns |
|---|---|---|---:|---:|---:|
| `airbnb001.base` | ✓ | 11/11 | 73s | $0.066 | 2 |
| `airbnb002.base` | ✓ | 12/12 | 135s | $0.075 | 2 |
| `airbnb003.base` | ✓ | 8/8 | 230s | $0.119 | 1 |
| `airbnb004.base` | ✓ | 3/3 | 344s | $0.115 | 1 |
| `airbnb005.base` | ✓ | 5/5 | 353s | $0.155 | 2 |
| `airbnb006.base` | ✓ | 8/8 | 322s | $0.257 | 2 |
| `airbnb007.base` | ✗ | 1/4 | 314s | $0.124 | 0 |
| `airbnb008.base` | ✓ | 5/5 | 162s | $0.060 | 1 |
| `airbnb009.base` | ✗ | 1/2 | 317s | $0.043 | 1 |
| `airbnb010.base` | ✗ | 1/1 | 319s | $0.125 | 1 |
| `airbnb011.base` | ✓ | 5/5 | 551s | $0.279 | 0 |
| `airbnb011.hint` | ✓ | 5/5 | 821s | $0.210 | 0 |
| `airbnb012.base` | ✓ | 3/3 | 473s | $0.337 | 1 |
| `airbnb013.base` | ✓ | 2/2 | 233s | $0.061 | 1 |
| `analytics_engineering001.base` | ✓ | 2/2 | 0s | n/a | 0 |
| `analytics_engineering002.base` | ✓ | 3/3 | 28s | $0.061 | 1 |
| `analytics_engineering002.medium` | ✓ | 3/3 | 207s | $0.124 | 1 |
| `analytics_engineering003.base` | ✓ | 3/3 | 178s | $0.076 | 1 |
| `analytics_engineering004.base` | ✗ | 2/3 | 322s | $0.216 | 2 |
| `analytics_engineering005.base` | ✓ | 4/4 | 248s | $0.088 | 1 |
| `analytics_engineering006.base` | ✗ | 1/2 | 307s | $0.121 | 0 |
| `analytics_engineering007.base` | ✓ | 11/11 | 1166s | $0.388 | 1 |
| `analytics_engineering007.medium` | ✓ | 11/11 | 531s | $0.184 | 1 |
| `analytics_engineering008.base` | ✓ | 2/2 | 222s | $0.087 | 1 |
| `asana001.base` | ✓ | 3/3 | 1016s | $0.399 | 1 |
| `asana002.base` | ✓ | 4/4 | 391s | $0.257 | 2 |
| `asana003.base` | ✓ | 18/18 | 251s | $0.087 | 1 |
| `asana004.base` | ✗ | 3/5 | 324s | $0.052 | 1 |
| `asana005.base` | ✗ | 8/9 | 1547s | $0.841 | 1 |
| `asana005.hard` | ✗ | 7/9 | 634s | $0.239 | 1 |
| `f1001.base` | ✓ | 7/7 | 199s | $0.065 | 1 |
| `f1002.base` | ✗ | 9/11 | 670s | $0.364 | 2 |
| `f1003.base` | ✓ | 5/5 | 1115s | $0.320 | 2 |
| `f1003.hard` | ✓ | 5/5 | 775s | $0.213 | 2 |
| `f1004.base` | ✓ | 3/3 | 303s | $0.089 | 2 |
| `f1005.base` | ✓ | 5/5 | 495s | $0.334 | 2 |
| `f1005.medium` | ✓ | 5/5 | 325s | $0.158 | 1 |
| `f1006.base` | ✗ | 4/5 | 710s | $0.285 | 1 |
| `f1006.hard` | ✓ | 5/5 | 500s | $0.092 | 1 |
| `f1007.base` | ✓ | 7/7 | 1385s | $0.402 | 2 |
| `f1007.hard` | ✓ | 7/7 | 593s | $0.150 | 2 |
| `f1007.medium` | ✓ | 7/7 | 461s | $0.181 | 1 |
| `f1008.base` | ✗ | 1/1 | 568s | $0.342 | 2 |
| `f1009.base` | ✓ | 2/2 | 894s | $0.417 | 2 |
| `f1010.base` | ✓ | 3/3 | 697s | $0.424 | 1 |
| `f1010.medium` | ✓ | 3/3 | 1048s | $0.488 | 2 |
| `f1011.base` | ✗ | 6/7 | 761s | $0.143 | 1 |
| `helixops_saas001.base` | ✓ | 3/3 | 103s | $0.069 | 1 |
| `helixops_saas002.base` | ✓ | 3/3 | 250s | $0.084 | 1 |
| `helixops_saas003.base` | ✓ | 3/3 | 360s | $0.258 | 1 |
| `helixops_saas004.base` | ✓ | 3/3 | 381s | $0.097 | 1 |
| `helixops_saas004.no_hint` | ✓ | 3/3 | 290s | $0.087 | 1 |
| `helixops_saas005.base` | ✓ | 3/3 | 135s | $0.060 | 2 |
| `helixops_saas006.base` | ✓ | 4/4 | 322s | $0.170 | 2 |
| `helixops_saas007.base` | ✗ | 7/8 | 99s | $0.048 | 2 |
| `helixops_saas007.no_location_hint` | ✗ | 7/8 | 288s | $0.182 | 1 |
| `helixops_saas008.base` | ✓ | 11/11 | 231s | $0.059 | 2 |
| `helixops_saas009.base` | ✗ | 1/2 | 146s | $0.089 | 2 |
| `helixops_saas010.base` | ✗ | 9/11 | 89s | $0.076 | 1 |
| `helixops_saas011.base` | ✓ | 3/3 | 91s | $0.034 | 2 |
| `helixops_saas011.hard` | ✓ | 3/3 | 201s | $0.072 | 2 |
| `helixops_saas012.base` | ✓ | 4/4 | 66s | $0.015 | 1 |
| `helixops_saas012.hard` | ✓ | 4/4 | 56s | $0.030 | 1 |
| `helixops_saas013.base` | ✓ | 7/7 | 141s | $0.076 | 2 |
| `helixops_saas015.base` | ✓ | 4/4 | 595s | $0.091 | 1 |
| `helixops_saas015.low` | ✓ | 4/4 | 323s | $0.097 | 1 |
| `helixops_saas016.base` | ✓ | 3/3 | 699s | $0.173 | 2 |
| `helixops_saas017.base` | ✓ | 4/4 | 236s | $0.032 | 0 |
| `helixops_saas018.base` | ✓ | 4/4 | 209s | $0.056 | 1 |
| `intercom001.base` | ✓ | 3/3 | 196s | $0.145 | 1 |
| `intercom002.base` | ✗ | 3/5 | 657s | $0.297 | 1 |
| `intercom003.base` | ✓ | 3/3 | 1190s | $0.576 | 1 |
| `quickbooks001.base` | ✓ | 13/13 | 1756s | $1.142 | 1 |
| `quickbooks002.base` | ✓ | 9/9 | 345s | $0.188 | 1 |
| `quickbooks003.base` | ✗ | — (unknown_agent_error) | n/a | n/a | n/a |
| `quickbooks004.base` | ✓ | 49/49 | 1309s | $0.866 | 1 |
| `shopify-analytics.base` | ✗ | — (setup_failed) | n/a | n/a | n/a |
| `simple001.base` | ✗ | 1/2 | 56s | $0.013 | 0 |
| `simple002.base` | ✓ | 2/2 | 61s | $0.015 | 2 |
| `simple002.medium` | ✗ | — (agent_setup_timeout) | n/a | n/a | n/a |
| `workday001.base` | ✗ | 1/1 | 2s | $0.000 | 2 |

## Appendix B — Pass rate by task family

| Family | Pass | Total | Rate |
|---|---:|---:|---:|
| airbnb | 11 | 14 | 79% |
| analytics_engineering | 8 | 10 | 80% |
| asana | 3 | 6 | 50% |
| f | 13 | 17 | 76% |
| helixops_saas | 18 | 22 | 82% |
| intercom | 2 | 3 | 67% |
| quickbooks | 3 | 4 | 75% |
| shopify-analytics | 0 | 1 | 0% |
| simple | 1 | 3 | 33% |
| workday | 0 | 1 | 0% |

## Appendix C — Failing trials with detail

| Trial | Failure mode | Sub-tests passed | Cost | Runtime | First failed test (name only) |
|---|---|---:|---:|---:|---|
| `airbnb007.base` | unset | 1/4 | $0.124 | 314s | `daily_agg_nps_reviews_equality_with_tolerance` |
| `airbnb009.base` | unset | 1/2 | $0.043 | 317s | `mom_agg_review_date_range` |
| `airbnb010.base` | unset | 1/1 | $0.125 | 319s | `—` |
| `analytics_engineering004.base` | unset | 2/3 | $0.216 | 322s | `AUTO_obt_product_inventory_equality` |
| `analytics_engineering006.base` | unset | 1/2 | $0.121 | 307s | `check_row_count` |
| `asana004.base` | unset | 3/5 | $0.052 | 324s | `check_project_user_agg_references` |
| `asana005.base` | unset | 8/9 | $0.841 | 1547s | `AUTO_int_asana__project_user_agg_equality` |
| `asana005.hard` | unset | 7/9 | $0.239 | 634s | `AUTO_asana__project_equality` |
| `f1002.base` | unset | 9/11 | $0.364 | 670s | `AUTO_finishes_by_driver_equality` |
| `f1006.base` | unset | 4/5 | $0.285 | 710s | `AUTO_constructor_points_equality` |
| `f1008.base` | unset | 1/1 | $0.342 | 568s | `—` |
| `f1011.base` | unset | 6/7 | $0.143 | 761s | `check_option_b` |
| `helixops_saas007.base` | unset | 7/8 | $0.048 | 99s | `AUTO_int_account_billing_snapshot_equality` |
| `helixops_saas007.no_location_hint` | unset | 7/8 | $0.182 | 288s | `AUTO_int_account_billing_snapshot_equality` |
| `helixops_saas009.base` | unset | 1/2 | $0.089 | 146s | `dim_accounts_versioned` |
| `helixops_saas010.base` | unset | 9/11 | $0.076 | 89s | `AUTO_int_support_sla_equality` |
| `intercom002.base` | unset | 3/5 | $0.297 | 657s | `AUTO_intercom__conversation_metrics_equality` |
| `quickbooks003.base` | unknown_agent_error | 0/0 | n/a | n/a | `—` |
| `shopify-analytics.base` | setup_failed | 0/0 | n/a | n/a | `—` |
| `simple001.base` | unset | 1/2 | $0.013 | 56s | `columns_in_project_duckdb` |
| `simple002.medium` | agent_setup_timeout | 0/0 | n/a | n/a | `—` |
| `workday001.base` | unset | 1/1 | $0.000 | 2s | `—` |

## Appendix D — Skill-tool invocations across all trials (full list)

| Trial | Skill | Trial passed? |
|---|---|:-:|
| `airbnb003.base` | `dbt-develop` | ✓ |
| `airbnb008.base` | `dbt-troubleshoot` | ✓ |
| `airbnb010.base` | `dbt-develop` | ✗ |
| `airbnb011.hint` | `dbt-develop` | ✓ |
| `airbnb012.base` | `dbt-test` | ✓ |
| `airbnb012.base` | `dbt-unit-tests` | ✓ |
| `airbnb013.base` | `dbt-troubleshoot` | ✓ |
| `analytics_engineering002.medium` | `dbt-troubleshoot` | ✓ |
| `analytics_engineering003.base` | `dbt-develop` | ✓ |
| `analytics_engineering004.base` | `dbt-develop` | ✗ |
| `analytics_engineering007.medium` | `dbt-troubleshoot` | ✓ |
| `analytics_engineering008.base` | `dbt-develop` | ✓ |
| `asana004.base` | `dbt-develop` | ✗ |
| `f1007.hard` | `dbt-troubleshoot` | ✓ |
| `f1007.medium` | `dbt-troubleshoot` | ✓ |
| `f1008.base` | `dbt-develop` | ✗ |
| `f1010.base` | `dbt-develop` | ✓ |
| `helixops_saas004.base` | `dbt-develop` | ✓ |
| `helixops_saas009.base` | `dbt-develop` | ✗ |

Total skill invocations: **19**
Distinct trials that invoked any skill: **18 / 81**

## Appendix E — Cost / runtime distribution

| Metric | Count | Min | p50 | p75 | p90 | Max | Sum |
|---|---:|---:|---:|---:|---:|---:|---:|
| Cost (USD) | 78 | 0.000 | 0.124 | 0.257 | 0.402 | 1.142 | 14.91 |
| Runtime (s) | 78 | 0 | 322 | 595 | 1048 | 1756 | 34402 |

---

## Appendix F — Reproducing this run

```bash
# 1. Clone benchmark + altimate-code
git clone https://github.com/dbt-labs/ade-bench experiments/ade-bench-upstream
git clone https://github.com/AltimateAI/altimate-code

# 2. Set up Python env for the harness
cd experiments/ade-bench-upstream
uv venv && source .venv/bin/activate
uv pip install -e .

# 3. Download shared DuckDB seed databases
gh release download databases --repo dbt-labs/ade-bench \
  --pattern "*.duckdb" --dir shared/databases/duckdb

# 4. Build the altimate-code tarball locally (linux/amd64 + linux/arm64)
#    (one-time; takes ~5-10 min, produces ade_bench/agents/installed_agents/altimate_code/altimate-code-local.tgz)
./ade_bench/agents/installed_agents/altimate_code/build-local-tarball.sh

# 5. Run the benchmark
export OPENROUTER_API_KEY=sk-or-v1-...
export DEFAULT_AGENT_TIMEOUT_SEC=1800
export SETUP_TIMEOUT_SEC=300
export DEFAULT_TEST_TIMEOUT_SEC=120

ade run all --db duckdb --project-type dbt \
  --agent altimate \
  --model openrouter/moonshotai/kimi-k2.6-20260420 \
  --no-rebuild \
  --n-concurrent-trials 6 \
  --max-episodes 80
```

**Docker resources used:** 12 GiB memory, 8 CPUs. Lower than 6 GiB causes setup-phase `npm install` of the 131 MB altimate-code tarball to hit OOM/swap and time out under concurrent load.

---

## Appendix G — Glossary

- **Trial** — one (task_id, prompt_variant) pair, e.g. `airbnb007.base` or `f1006.hard`. Each trial gets its own Docker container.
- **`results.json`** — per-trial result file the harness writes. Key fields: `is_resolved` (bool), `failure_mode` (string), `parser_results` (dict of `<test_name>: passed/failed`), `runtime_ms`, `cost_usd`, `num_turns`, `cache_tokens`/`input_tokens`/`output_tokens`.
- **`agent.log`** — line-delimited JSON event stream emitted by altimate-code during the agent's run. Each line is one event with a `type` field.
- **`step_start` / `step_finish`** — boundaries of one assistant turn. `step_finish` carries the cost and token usage for the step.
- **`tool_use`** — one tool invocation by the agent. `state.input` is the args, `state.output` is the return, `state.time.{start,end}` are wall-time millisecond markers.
- **`parser_results`** — dict of `<test_name>: "passed" | "failed"`. Includes both the auto-generated `AUTO_<model>_existence`/`AUTO_<model>_equality` tests and the per-task hand-written ones like `mom_agg_review_date_range`.
- **`expected_test_count`** — what the task config declares should be checked. If `len(parser_results) < expected_test_count` the trial is flagged FAIL even if every test that ran passed (this catches "agent never started" cases that would otherwise look like 1/1 = 100%).
- **`failure_mode`** — one of `unset` (no error, just didn't pass tests), `eval_error` (tests ran, some failed), `compile_error` (dbt build failed), `agent_setup_timeout` (setup phase exceeded `SETUP_TIMEOUT_SEC`), `unknown_agent_error` (agent crashed or never produced output).
- **`skill` tool** — one of altimate-code's built-in tools. Lets the agent load a markdown skill file (e.g. `dbt-develop`) into its context on demand. Required call to invoke; the body is not in the system prompt by default.
- **Step gap** — wall-clock time between `step_finish` of step N and `step_start` of step N+1. This includes serializing the assistant message, running any tools the model called, and the model thinking about the result.

---

## Appendix H — Open questions / things worth a second look

A non-exhaustive list of threads we noticed but didn't pull on. Useful for follow-up posts or experiments:

1. **Is Kimi's `reasoning` content reproducible across runs?** We didn't fix a seed. A second sweep would tell us how much of the 81.3% is "the model genuinely knows" vs "this run got lucky on N borderline trials". Would inform variance bars on the headline number.
2. **Does the agent invoke `skill` more often when `dbt build` fails repeatedly?** Anecdotally yes (`dbt-troubleshoot` fires after failures), but no quantification. A scatter of "build failures before skill invocation" would be revealing.
3. **What's the marginal value of the `altimate-dbt` CLI tool vs raw `dbt`?** Kimi invoked `altimate-dbt` ~40% of bash calls and raw `dbt` ~60%. Pass-rate split between the two would tell us whether the wrapper helps.
4. **Reasoning-token under-reporting magnitude.** OpenRouter's response includes a `reasoning` field. altimate-code's adapter reports some of it as `tokens.reasoning` per step, but the sum doesn't match wall-time. Patching the adapter to also count `reasoning` characters at wire level would let us bound the true generation count.
5. **Do failures cluster by sub-test type?** Most `*_equality_with_tolerance` failures are aggregation-grain bugs; `*_existence` failures are "agent never created the file". A heatmap of failure-type × task-family might surface a class we missed.
6. **Effect of `--n-concurrent-trials 6` vs 1.** Wall-clock total drops 4-6× at concurrency 6 with no apparent quality regression in our data. Worth confirming there's no subtle resource-contention effect on borderline trials.
7. **Cost-budget headroom.** $14.91 for 78 trials means ~$0.19/trial. Compared to ~$1/trial we observed for some Anthropic baselines on the same harness, Kimi is 5× cheaper. Open question: what's the quality/cost frontier at the same harness budget?
8. **Long-tail trials.** `asana005.base` ran 1,547 s (full timeout-1) and still failed. Examining what the model is doing in the last 500 seconds vs the first 1,000 might surface a thrash pattern.

---

## Appendix I — File index for blog illustration

When refining the blog, these traces are particularly quote-worthy (each line is a verified file path):

- `experiments/2026-05-10__21-06-31__none/asana005/asana005.base.1-of-1/sessions/agent.log` — DuckDB type-mismatch debug
- `experiments/2026-05-10__19-13-41__none/f1006/f1006.base.1-of-1/sessions/agent.log` — cumulative-points root cause
- `experiments/2026-05-10__19-13-41__none/intercom002/intercom002.base.1-of-1/sessions/agent.log` — convention-following + aggregation-grain failure
- `experiments/2026-05-10__21-06-31__none/helixops_saas009/helixops_saas009.base.1-of-1/sessions/agent.log` — dbt versioned-models recall gap
- `experiments/2026-05-10__19-13-41__none/f1011/f1011.base.1-of-1/sessions/agent.log` — multi-choice reasoning over-confidence
- `experiments/2026-05-10__15-43-20__none/airbnb006/airbnb006.base.1-of-1/panes/agent.txt` — clean PASS, good for "what good looks like"
- `experiments/2026-05-10__17-12-12__none/quickbooks004/quickbooks004.base.1-of-1/results.json` — 49/49 sub-tests passed, the prettiest scoreboard in the set
