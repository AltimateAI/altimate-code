# Analyst smoke run report — 2026-10-11

**Completed: 1 PASS, 10 FAIL, 0 SKIP.** Fixtures and source preflight passed.
All eight conversations were launched exactly once. Each failed because this
environment could not connect to the ChatGPT endpoint, before any assistant
text or tool execution. Analyst behavior remains unverified; these are
connectivity failures, not demonstrated analyst regressions. A subsequent replay
checked saved evidence in 35 ms with no new CLI conversations or model calls and
reproduced the same results.

Artifacts: `/private/tmp/analyst-smoke-once-20261011/`. Each conversation retains
`run.json`, `events.jsonl`, `cli.log`, `output.md`, and its trace directory.

Previously there was no opt-in suite covering these analyst flows end to end →
the suite now generates synthetic databases, launches the source CLI, checks
events/output/logs/traces, enforces deadlines, checks process cleanup, and prints
PASS/FAIL/SKIP rows. Changes belong only to the smoke suite and wrapper; this
task makes no product-code changes.

Files: [analyst-smoke.test.ts](analyst-smoke.test.ts),
[fixtures.ts](fixtures.ts), [bunfig.toml](bunfig.toml), [README.md](README.md),
[analyst-smoke.sh](../../../../scripts/analyst-smoke.sh), and this report.

The wrapper launches from the worktree root using:

```text
bun run --no-env-file --conditions=browser packages/opencode/src/index.ts run
  --dir <fresh-project> --model openai/gpt-5.6-sol --yolo --agent analyst
  --max-turns N --output <output.md> --format json --print-logs --log-level INFO --trace
```

Every conversation gets isolated HOME/XDG directories and fixture copies,
`ALTIMATE_TELEMETRY_DISABLED=true`, `OPENCODE_PURE=1`, and
`experimental.auto_mcp_discovery=false`. Only the existing OpenAI OAuth entry is
copied into its private auth store and removed afterward. There are eight CLI
conversations, each launched at most once; checks 7 and 8 reuse scenario 1.
The CLI's own transport retries still apply. A 300-second scenario timeout is
a failure with retained logs. Replay rechecks existing artifacts without calls.

| Check | Expected | Observed | Status |
| --- | --- | --- | --- |
| 0: fixtures/source preflight | Deterministic fixtures, usable source CLI, slow SQL exceeds two minutes | Source help exit 0; slow query still running at 121,002.784 ms, then terminated and reaped; DuckDB fixture available | PASS |
| 1: cross-engine answer | Final `**Answer:**` average within 1e-6; SQL trace | Exit 1 after 61.418 s; API connection error; zero text/tool events; placeholder output | FAIL — connectivity |
| 2: truncation/spill/read | `Preview:` envelope, result path, exact JSONL returned-row count; successful read if attempted | Exit 1 after 61.505 s; same connection error; no SQL or spill | FAIL — connectivity |
| 2b: wide DuckDB cell | 100 KB cell clipped in preview, intact in spill | Driver available; exit 1 after 61.472 s; same connection error before SQL | FAIL — connectivity |
| 3: cancellation | Exact slow SQL times out near 15 s; next query succeeds; CLI and children exit | Exit 1 after 61.422 s; connection error before SQL. Deadline feature and >120 s baseline verified, but CLI cancellation not exercised | FAIL — connectivity |
| 4: subagent | `task` names `data-explorer`; child trace includes its SQL | Exit 1 after 61.520 s; no tool calls or child session | FAIL — connectivity |
| 5: skill | Successful `skill` call returns real `data-question` body | Exit 1 after 61.460 s; no skill call | FAIL — connectivity |
| 6: budget finalization | Exit 1 for budget exhaustion; final text; exactly one finalization generation | Exit 1 after 61.652 s, but reason is `error`, no text/finalization, output is placeholder | FAIL — connectivity |
| 7: JSON output | Scenario 1 output file contains numeric answer, not placeholder | Reused run contains `(no text output — tool-only response)` | FAIL — connectivity |
| 8: no stray MCP | Successful run with discovery disabled and no discovery/MCP-stderr log lines | Config is false and all eight logs have neither forbidden pattern; shared scenario 1 fails the successful-run prerequisite | FAIL — inherited connectivity; isolation evidence passes |
| 9: write denial | Explicit refusal/read-only error and unchanged sensors hash | Exit 1 after 61.456 s; no write attempt or refusal. Sensor hash unchanged | FAIL — connectivity |

The fixture oracle independently reads persisted rows, normalizes IDs in code,
and sums integer cents: **50,000 north-region readings; average 20.1170434**.
Saved database counts are 300 sensors and 200,000 readings. All eight runs exited
normally without a scenario timeout or surviving process-group member. Their
sensor hashes remained unchanged and all temporary OAuth copies were removed.
They saved root traces and emitted `termination.why_harness_stopped="error"`.
No SQL worker was exercised because no model response reached a tool call.
These observations are recorded in the artifact directory's `evidence-audit.json`.

Excerpt from scenario 1's `cli.log` (the connection cause, omitting request body):

```text
"name":"AI_APICallError","cause":{"code":"FailedToOpenSocket","path":"https://chatgpt.com/backend-api/codex/responses","errno":0}
```

Other retries recorded `ConnectionRefused`. The final JSON error was
`Cannot connect to API: Unable to connect. Is the computer able to access the url?`.
The SDK event labels its original URL `https://api.openai.com/v1/responses`;
the log's cause records the actual ChatGPT OAuth endpoint above. No assertion
was weakened to accept these failures.

Validation:

- Disabled smoke suite: **11 SKIP**, successful exit; no model calls.
- From `packages/opencode`, `bunx tsc --noEmit --strict --skipLibCheck --target ESNext --module Preserve --moduleResolution Bundler --types bun test/e2e-smoke/analyst-smoke.test.ts`:
  **PASS**.
- Package `bun run typecheck`: **PASS** on the final run; log at
  `/private/tmp/analyst-smoke-once-20261011/typecheck.log`. Earlier concurrent
  `sql-check` import/property errors resolved without edits from this task.
- `bash -n scripts/analyst-smoke.sh` and Prettier checks: **PASS**.
- Live command: `ANALYST_SMOKE_ARTIFACTS=/private/tmp/analyst-smoke-once-20261011 ./scripts/analyst-smoke.sh`;
  **1 PASS, 10 FAIL**, exit 1, 491.96 seconds. Exactly eight `started.json` records.
- Replay command: `ANALYST_SMOKE_REPLAY=/private/tmp/analyst-smoke-once-20261011 ./scripts/analyst-smoke.sh`;
  **same 1 PASS, 10 FAIL**, exit 1. Output retained in `replay.log`.

The remaining verification requires an environment that can reach the ChatGPT
OAuth endpoint. No analyst product regression can be concluded from this run.
No scenario was re-launched to seek a passing result, and no product code was
changed. Development fixes were limited to test assertions, isolation and
diagnostics. In particular, the sandbox forbids `ps`, so cleanup checks use the
CLI's isolated process group instead.

The Python SQLite baseline and Bun SQLite driver are different builds. Spill
reading is optional. The skill check uses the real repository skill copied into
the isolated project, so compiled skill packaging is outside this suite.
Capability skips are limited to unavailable DuckDB and an absent SQL deadline;
both capabilities are available in this run. Dynamic SKIPs are authoritative in
the wrapper table/results JSON even though Bun counts their early return as a
passed test.
