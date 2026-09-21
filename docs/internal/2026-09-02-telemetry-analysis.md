# Telemetry Analysis 2026-09-02 — How Are We Doing

**Verdict: the CLI cohort is steady and small; the datamates channel, which is nine in ten observed machine IDs, is failing most of its tasks.** The `completed` label on datamates fell from 57% of outcomes in mid-July to 20% in the (partial) week of Aug 30, while recorded errors rose from 22% to 60%. The Console rate limit on the free default model, first seen Aug 12, accounts for roughly half of the decline; sessions that were never rate-limited still fell from 57% to 31%. Everything else in this report matters less than fixing that channel.

Source: Azure Log Analytics `altimate-code-os` (`AppEvents`). Window **2026-08-19T00:00Z → 2026-09-02T00:00Z** (half-open, 14d, "now") vs **2026-08-05 → 2026-08-19** ("prior"); weekly series use `startofweek` (Sunday) UTC over 63 days. Unless stated, rows are restricted to release builds (`AppVersion` strict semver). Counts are distinct `Properties.machine_id` ("machine IDs", not people) or distinct `SessionId`; outcome percentages are over `agent_outcome` events. Queries are in the appendix file. Supersedes the 2026-08-05 fix list; its status is in §9.

## 1. Who is using it

Observed machine IDs, release builds, 14d. Rows are **not exclusive**: 8 IDs carry both `datamates` and `cli` events, and the side-channel sources ride on the same IDs. Unique union = 2,046.

| Segment | Machine IDs | Generated | Completed a task | Note |
|---|---:|---:|---:|---|
| datamates (dbt Power User extension) | 1,457 | 673 | **124** | 88% seen on one day only |
| cli humans | 166 | 60 | 49 | 30 active ≥3 days, 9 active ≥10 days |
| docker / user / config_rule / poweruser | 147 | 0 | 0 | side-channel events on IDs above |
| **internal fleet on `0.7.3`** | 198 | 166 | — | ours; Aug 27–29, one project, fresh ID per run |
| **CI review runners on `0.9.3` / `0.8.3`** | 198 | 0 | — | headless dbt PR review in customers' CI |
| Headline (naive dashboard) | 2,057 | | | prior fortnight 2,478 incl. the 690-ID shs-dx-it fleet |

Excluding the fleet and CI rows: **~1,630 IDs now vs ~1,790 prior (−7%)**; with 88% one-day IDs on datamates the week-to-week noise is larger than that, so I read it as no trend. Weekly cli IDs that generate (weeks of Jul 19, Jul 26, Aug 16, Aug 23, Aug 30): 48 / 69 / 46 / 41 / 43. Weekly datamates IDs that generate (Jul 19 → Aug 30): 357 / 456 / 412 / 337 / 379 / 338 / 223 (partial). Flat.

- OS (IDs with a `session_start`): datamates 605 win32 / 434 darwin / 195 linux; cli 27 / 23 / 22.
- Versions: 0.9.7 (707 IDs), 0.9.5 (630), 0.9.6 (362). **0.10.0 was published to npm today** (`latest`) and has not reached users (1 internal event).
- Providers by IDs with a session: `opencode/big-pickle` 991 (48% of all IDs), `altimate-backend` 190, `openrouter` 54, `github-copilot-enterprise` 22, `amazon-bedrock` 22, `openai` 19, `anthropic` 18.

## 2. P0 — the datamates channel is failing most tasks

### 2.1 Weekly decomposition

`completed` share of `agent_outcome` events on `source=datamates`, with three controls: excluding the `abandoned` label (which is mislabelled, see §4), excluding sessions that ever hit the rate limit, and the gateway (`altimate-backend`) cohort which never uses `big-pickle`.

| Week of | n | completed | error | completed excl. abandoned | non-rate-limited sessions: completed / error | big-pickle: completed / error | gateway: completed / error | cli completed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Jul 19 | 825 | 57.2% | 22.7% | 71.6% | 57.2 / 22.7 | 58.7 / 18.4 | 64.1 / 20.2 | 76.8% |
| Jul 26 | 1,209 | 53.3% | 17.0% | 75.9% | 53.3 / 17.0 | 56.2 / 11.2 | 59.3 / 13.9 | 77.2% |
| Aug 2 | 1,128 | 52.6% | 15.1% | 77.7% | 50.6 / 16.1 | 56.5 / 5.9 | 51.3 / 41.7 | 71.0% |
| Aug 9 | 784 | 38.5% | 34.8% | 52.5% | 40.4 / 36.5 | 42.1 / 27.6 | 31.1 / 57.4 | 75.9% |
| Aug 16 | 603 | 24.4% | 54.7% | 30.8% | 37.1 / 32.9 | 18.0 / 56.8 | 51.8 / 35.1 | 74.4% |
| Aug 23 | 643 | 25.2% | 52.1% | 32.6% | 33.6 / 35.6 | 23.6 / 51.4 | 41.9 / 41.0 | 76.8% |
| Aug 30 (3 days, preliminary) | 319 | **20.1%** | **59.9%** | 25.1% | 30.8 / 37.9 | 15.8 / 62.1 | 47.8 / 37.0 | 73.2% |

What the table supports:
- The collapse is not an artifact of the `abandoned` label (71.6% → 25.1% with it removed) and not a partial-week effect (weeks of Aug 16 and Aug 23 are full).
- Rate-limited sessions explain about half: sessions never rate-limited went 57% → 31% completed, 23% → 38% error. The rest is a broader rise in provider errors on datamates that I have not decomposed further; the error taxonomy is in §2.3.
- The cli cohort (`source=cli`, mostly BYO-key providers) is flat at 73–77% across the same weeks, so this is not a CLI-wide regression.
- Gateway completion has bounced between 31% and 64% since Aug 2; its errors are chronic (§2.2), not new.

### 2.2 Mechanism one: `big-pickle` rate limiting

- `APIError: Error from provider (Console): Rate limit exceeded` — **298 of the 975 datamates IDs on `big-pickle` (31%)** in 14 days; both the `error` event and the `agent_outcome.reason` give the same 298. It is the #1 error reason by a factor of four.
- Sessions that hit it (436 with any outcome): **410 error, 14 completed, 7 abandoned, 5 aborted.** 146 of them (33%) never got a generation through. Median time from `session_start` to the first hit: 86 s; 21% under 10 s.
- The rate is 5–13 hits per 100 generations in every UTC hour. That rules out a simple peak-hour pattern; it does not distinguish per-account throttling from a continuously saturated shared ceiling. Provider-side quota data would.
- Datamates IDs are seen on one day 88% of the time whether rate-limited or not, so churn from this is not separately measurable.
- First-session outcome for a datamates ID (554 IDs with an outcome): **93 completed, 346 error, 64 aborted, 51 abandoned** = 17% completed.
- Code (`packages/opencode/src/session/processor.ts:1187-1213`, `session/retry.ts:11`): on 429 the CLI retries the **same model** up to 5 times with backoff, then surfaces the error. There is no failover, no distinction between a transient 429 and a hard quota, and no message telling the user what to do. `big-pickle` becomes the default only when no credential exists (`provider/provider.ts:2082-2107`), which is exactly the fresh-datamates case. Unchanged in 0.10.0.

### 2.3 Mechanism two: chronic gateway `Not authenticated` and the rest of the error tail

`APIError: Forbidden: {"detail":"Not authenticated"}` on `altimate-backend / altimate-default`: **62 datamates IDs in 14 days**, one in three of the 190 gateway IDs, and none of the 62 completed a task later in the window. It is not new: 25–36 IDs every week since mid-July on every version from 0.9.1 to 0.10.0. Hypothesis, not proven: a stale or revoked key. Code: the provider takes a static API key from `~/.altimate/altimate.json`, falling back to the TUI auth store (`provider/provider.ts:335-378`); there is no expiry check, refresh, or credential validation on 401/403 during chat (the Anthropic plugin at `altimate/plugin/anthropic.ts:80-106` checks expiry and refreshes proactively; this provider has nothing analogous). The raw `{"detail":…}` reaches the user because `provider/error.ts` does not read FastAPI's `detail`.

Other datamates error reasons this fortnight (IDs): Google Vertex location missing 10; `"undefined/chat/completions" cannot be parsed as a URL` 8 (flagged Aug 5, still present); `Forbidden: request was blocked by a gateway or proxy` 8; AWS credential failures 6+4; `Failed to process error response` 10; `Service Unavailable` 5.

### 2.4 Bedrock: 22 IDs, 0 completed

35 outcomes by cause: bundling break `config6.parseKnownFiles is not a function` 8 outcomes / 8 IDs; bad or expired security token 8 / 5; no credentials found 6 / 4; account not enabled for the model 2 / 2; bad model id 2 / 1; non-error 2. The bundling bug (flagged Aug 5) is the largest single cause but only a third of the IDs; the rest is credential setup. Code: `fromNodeProviderChain` at `provider/provider.ts:505`; `@aws-sdk/credential-providers` is bundled rather than externalized (`script/build.ts:338-362`). No fix between 0.9.7 and 0.10.0. A credential preflight with a clear message would cover both halves.

## 3. P0 — telemetry sends content the published policy says it never sends

`docs/docs/reference/telemetry.md:151-163` promises no SQL, no file paths, no tool arguments, and that error messages are "scrubbed of file paths before sending." Production rows on 0.9.5–0.9.7 contradict all three:

- `core_failure.error_message` carries raw absolute paths with home-directory usernames (`File not found: /Users/<first.last>/…`, `C:\Users\<corp-id>\…`): 297 of 1,072 rows on 0.9.7 (53 IDs); `masked_args` the same on 33 IDs.
- `masked_args` preserves SQL text and arbitrary unquoted strings by design: the tests expect `SELECT * FROM users` and table names to survive (`packages/opencode/test/telemetry/telemetry.test.ts:1996`). `sql_execute_failure.masked_sql` likewise carries full column names.

Code: `Telemetry.maskString` (`altimate/telemetry/index.ts:1414-1436`) redacts API keys, bearer tokens, emails and internal hosts, and `maskArgs` applies it recursively — but the sanitizer has no rule for paths, identifiers, or free text, so everything else passes. Every standard tool's error reaches it via `tool/tool.ts:131-227`. A real path scrubber exists (`redactPaths()` in `altimate/tools/sample-setup.ts:273-289`) but only for model-visible output. The last commits to `maskString` predate July 30. This is a gap between policy and code, not a decision.

Fix shape: stop sending `masked_args` values (send an allow-listed structural signature — `input_signature` already exists); strip `$HOME` and identifiers from `error_message`; audit `masked_sql`; decide what to do about rows already in Azure.

## 4. P0 — measurement: what the dashboards are getting wrong

1. **Internal fleets carry release version numbers.** 198 darwin IDs ran `AppVersion=0.7.3` on Aug 27–29 from one internal project (the same `project_id` runs `0.0.0-*` dev builds and `0.10.0`), one session each, providers `genlocal` / `google-vertex*`. Those provider IDs are not in the shipped defaults, so this is an internal config, not a customer. They pass the semver filter and were 10% of the headline machine count, and they produced two of the fortnight's "top errors" that no user saw (`Timed out opening DuckDB database`, 48 IDs; `temperature and top_p cannot both be specified`, 24). The fix is a `run_context=internal|ci|interactive` dimension, not faking the version.
2. **Customer CI runs the headless review on pinned versions.** 177 IDs on 0.9.3 and 21 on 0.8.3 emit only `native_call` (`altimate_core.check / column_lineage / review_ai_prompt / equivalence …`), a fresh ID and a `first_launch` per run. An exact action ref (`@v0.9.3`) installs exactly that version (`github/review/action.yml:68`); only non-semver refs resolve `latest`. The marker that arms `first_launch` is written by the shell installer (`install:504`) on every run. The CI telemetry gate is deliberately not keyed on `CI`/`GITHUB_ACTIONS` (`telemetry/index.ts:50-64`) because CI review is a product surface — right call, but install and WAU counts need a CI dimension. Effect: 67 of 160 "new cli installs" this fortnight are CI runs. Estimated headless review invocations per week (distinct IDs emitting `altimate_core.review_ai_prompt`, a proxy): 16 → 26 → 34 → 73 → 54 → **89** — growing, and invisible in `review_run` (27 events, none from these IDs) until customers move their pins.
3. **Dev builds dwarf production.** Non-release events this fortnight: **1.27M events, 5,621 IDs, 30,272 sessions** — 78% of raw volume (the `0.0.0-worktree-unsloth_integration` fleet alone is 4,541 IDs). Release builds: 365K events, 2,057 IDs.
4. **`abandoned` is misclassified.** `session/prompt.ts:1861-1868`: `abandoned` = zero cost **and** zero tool calls. Cost is 0 for `github-copilot-enterprise`, `alibaba-token-plan`, `opencode`, `altimate-backend`, so on those providers any text-only answer is booked as `abandoned` (reason hard-coded to `no_tools_invoked`). 732 cli "abandoned" outcomes on 34 IDs this fortnight are mostly this; every completion rate here understates the true answer rate on the free and gateway paths.
5. **The Aug 5 ACP P0 was a test artifact.** Every `source=acp` row in 90 days is `cli_version=local` / `provider_id=test` (286 CI IDs). Closing it.
6. datamates machine-ID churn is unchanged: 1,284 of 1,464 IDs (88%) seen one day; median sessions per ID = 1.

## 5. Activation, now instrumented

Fresh `first_launch` on cli 0.9.5–0.9.7 this fortnight: 102 IDs. The stages below are *reach* counts, not an ordered funnel (`model_picker_shown` also fires outside onboarding):

| Reached | IDs |
|---|---:|
| first_launch | 102 |
| onboarding_started | 12 |
| model_picker_shown | 13 |
| provider_selected | 8 |
| onboarding_completed | 6 (5 abandoned at `provider_setup`) |
| any session_start | 33 |
| any generation | 28 |
| any completed task | 19 |

69 of 102 never start a session; 45 of those emit only `native_call` (headless lint/safety/grade from scripts or CI), so interactive activation is roughly 33 of ~57. Retention with proper exposure: of the **52 installs at least 7 days old**, 15 ever started a session, 9 were active on days 1–6, **5 were active on day 7 or later** (10% of installs; a third of those who started). The onboarding flow is seen by one in eight fresh installs.

## 6. P1 — reliability and product

- **Warehouse drivers: fixed in 0.10.0, not yet in users' hands.** `driver not installed. Run: npm install …` still hit snowflake 12 IDs, databricks 4, duckdb 4, bigquery 3, pg 2 (Aug 5: 23/13/–/13/3). Root cause (`import()` inside the compiled binary resolving against bunfs) is fixed by #1122 (`packages/drivers/src/resolve.ts`). It only helps IDs that upgrade — next item.
- **Datamates self-upgrade fails for half the machines and sticks.** 211 datamates IDs attempted an upgrade (233 events): 110 succeeded only, **100 failed only**, 1 both — 47% failure, all `Upgrade failed for curl (exit code 1)`. Of 105 IDs (all sources) with a failed upgrade, 10 later reached 0.9.7. cli upgrades: 30 ok / 4 error. Code: the message means the `altimate.sh/install` script itself exited 1 (`installation/index.ts:175,186-217`); method detection (`installation/index.ts:262-270`) classifies anything under `.altimate/bin` as a curl install by design, and the telemetry `method` field collapses curl/yarn/pnpm/scoop/choco/unknown to `other` (`:436-440`). The extension-managed binary lives in that path, so the auto-updater (`cli/upgrade.ts:138-163`) runs the curl script against it. Cheapest containment: the extension sets `ALTIMATE_CLI_DISABLE_AUTOUPDATE=1` (or `autoupdate: "notify"`, `cli/upgrade.ts:94,149`) and owns its binary; durable fix is an installer-owner marker instead of path guessing.
- **Tools with at least one observed execute-time error, by IDs** (call-level rates in brackets; schema-validation failures happen before the error wrapper at `tool/tool.ts:276` and are not captured): `schema_inspect` 43 of 57 IDs (155 of 1,435 calls, 11%; `No warehouse configured` 17 IDs, drivers 10, `Schema ? does not exist` 7, `Invalid table ID` 6); `sql_explain` 12 of 12 (14 of 18 calls); `sql_fix` 5 of 5 (6 of 6); `altimate_core_semantics` 5 of 6 (6 of 7); `webfetch` 17 of 28 (56 of 204, mostly a hallucinated `altimate.ai/config.json`). `sql_explain` and `sql_fix` are registered unconditionally (`tool/registry.ts:417-419`) even with no warehouse.
- **Runaway emitters.** `memory_operation` (58K) + `memory_injection` (52K) = **30% of release telemetry from ~35 IDs**; injection fires on every agentic step (`session/prompt.ts:1447`), operations come from the memory tools (48,587 project-scope update writes across 835 sessions). `filetime_drift` still 22K events / 651 IDs; `file/time.ts:81-89` untouched since Aug 5. Buffer is 200 events, FIFO drop, no per-type cap (`telemetry/index.ts:68-69, 1800-1806`); overflow on 11 IDs. One ID is 17% of all release events.
- **Review.** 27 interactive `review_run`s on 9 IDs. 20 show `verdict=COMMENT` against `ideal_verdict=REQUEST_CHANGES`: that is comment mode doing what it promises (`review/verdict.ts:71-73`; default in `github/review/action.yml`). Findings per run: **full-tier runs median 26 (p90 31, one outlier at 3,946); degraded runs (17 of 27) median 114, p90 212.** `severity_threshold` defaults to `suggestion` and nothing caps count (`review/orchestrate.ts:1416-1420` dedupes only). The degraded path is the noisy one; fix its rules or cap per file before touching the global threshold.
- **Ripgrep.** `JSON record exceeded 65536 bytes` 16 IDs (from 84), all pre-0.9.7; fixed by #1094 (16 MiB cap, bad record skipped). `RipgrepDownloadFailedError` 4 IDs.
- **Permission friction.** bash user-denied on 47 IDs, rule-denied 31; `task` denied by customer rule 232 times on 5 IDs. The rule-dump message is still `[{?:?,?:?,?:?},…]` (824 events).
- **`invalid` tool.** 76 calls / 37 IDs; the attempted name is in `params.tool` (`session/llm.ts:265-284`) and never reaches telemetry.
- **MCP.** `dbt` server errors 10 IDs, `azure-devops` 9, `github` 7 (was 99).
- **Cost** is still 0 for `opencode`, `github-copilot-enterprise`, `alibaba-token-plan`, `altimate-backend`.

## 7. What is working

- **Windows grep is fixed.** `? is not recognized as an internal or external command`: 63 IDs prior fortnight → **0** (#1074, 0.9.5).
- **`task` tool**: model-resolution and `promptOps` failures gone; residual errors are customers' own deny rules.
- **cli completion** steady at 73–77%. Sessions that compact complete at 73% vs 65% for those that do not. Median completed task: 4.1 min, 9 tool calls.
- **Onboarding funnel events** live on 0.9.5+; `upgrade_attempted.error` populated; `general` intent share 55% → 48%.
- **Skills.** `dbt-troubleshoot` 292 IDs (dominant), `dbt-develop` 35, `query-optimize` 28, `dbt-test` 13, `sql-review` 13. Datamates intent is overwhelmingly `debug_dbt` (756 IDs).
- **Review in CI is growing** (~89 invocations last week) even though we do not count it. `self-hosted error: no healthy upstream` (51 IDs Aug 5–18) cleared.

## 8. Recommended order of work

1. **Contain the rate limit on `big-pickle`.** Distinguish hard quota from a transient 429; stop the five futile retries on hard quota; show a clear message with the two ways out (connect the gateway, or BYO key); add a circuit breaker per session. Fail over automatically only to a model the user already has credentials for, or with explicit consent. Track datamates completion weekly with the §2.1 decomposition.
2. **Gateway auth.** Instrument the 401/403 path (which credential source, key age), validate the key once on failure and prompt a re-connect, parse FastAPI `detail`. 62 IDs, none recover.
3. **Telemetry policy.** Stop sending `masked_args` values; strip `$HOME` and identifiers from `error_message`; audit `masked_sql`; decide on the existing rows. Then re-verify against `docs/docs/reference/telemetry.md`.
4. **Datamates upgrade.** Extension sets `ALTIMATE_CLI_DISABLE_AUTOUPDATE=1` now; installer-owner marker next. This is also how 0.10.0's driver fix reaches datamates.
5. **Bedrock.** Externalize or fix the AWS credential bundle; add a credential preflight with an actionable message.
6. **Measurement.** `run_context` dimension (internal / CI / interactive) kept with the real version; `ci=true` under `GITHUB_ACTIONS` excluded from install/WAU counts; record the attempted name on `invalid`; make `abandoned` independent of cost.
7. **Volume.** Delete `filetime_drift`; sample `memory_injection` or move it off the per-step path; per-type buffer cap.
8. **Review noise.** Fix the degraded-path rules or cap per file/category; count headless runs once pins move.

## 9. Status of the 2026-08-05 fix list

| Aug 5 item | Now |
|---|---|
| P0-0 CI pollution (`provider_id=test`) | gate shipped in 0.9.5; pinned-version CI runners and semver-tagged internal fleets bypass it (§4) |
| P0-1 Windows grep cmd.exe | **FIXED** |
| P0-2 `task` 73% failure | **FIXED** (residual = customer deny rules) |
| P0-3 acp 0% completion | **was a test artifact** (§4.5); closing |
| P0-4 builder completion | cli ~75% (ok); datamates 20% (**worse**, §2) |
| P0-5 drivers not bundled | fixed in 0.10.0 (#1122); awaiting upgrades |
| P0-6 PII masker shreds diagnostics | swung the other way: sends paths, SQL and args (§3); rule dumps still 824 events |
| P1-1 `filetime_drift` noise | **NOT DONE** (22K events) |
| P1-2 buffer overflow / runaway emitters | **WORSE** (memory_* now 30% of volume) |
| P1-3 upgrade diagnostics | error text populated; method still `other`; 47% fail on datamates |
| P1-4 bash permission friction | unchanged |
| P1-6 GitHub MCP | 7 IDs (was 99) — improved |
| P1-7 `schema_inspect` / `sql_explain` errors | unchanged |

## Appendix

All KQL used, with the batch/query name that produced each figure, is in `docs/internal/2026-09-02-telemetry-queries.md`. Queried 2026-09-02 23:30Z – 2026-09-03 01:30Z. Rate-limit sessions = any `error` event whose message has `Rate limit exceeded`; gateway cohort = `session_start.provider_id == "altimate-backend"`; big-pickle cohort = `provider_id == "opencode"`.
