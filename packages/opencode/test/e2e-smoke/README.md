# Analyst smoke suite

From the worktree root:

```sh
./scripts/analyst-smoke.sh
```

This opts into real ChatGPT subscription calls using `openai/gpt-5.6-sol`.
Ordinary `bun test` skips the suite. The wrapper prints a PASS/FAIL/SKIP row per
check and preserves its artifact directory. There are eight CLI conversations:
scenarios 1–6 and 9, plus the wide DuckDB case 2b. Checks 7 and 8 reuse scenario 1.
The runner never retries a scenario. The CLI's own provider retry policy still
applies. Reusing an artifact directory refuses any already-started conversation.

To check saved evidence after fixing a test bug, without new model calls:

```sh
ANALYST_SMOKE_REPLAY=/absolute/path/from/previous/run ./scripts/analyst-smoke.sh
```

To run only the local fixture/source preflight:

```sh
./scripts/analyst-smoke.sh --test-name-pattern '^0 '
```

To select cancellation, include its slow-query preflight:

```sh
./scripts/analyst-smoke.sh --test-name-pattern '^(0 |3 )'
```

The preflight runs the exact recursive SQLite query for 121 seconds using
`python3 -I`, then terminates and reaps it. The live cancellation check uses the
actual source CLI and requires a timeout near 15 seconds, a subsequent successful
query, normal CLI exit and an empty process group. SQLite's Python baseline and
Bun driver use separate SQLite builds.

Every conversation starts a source CLI subprocess from the worktree root:

```text
bun run --no-env-file --conditions=browser packages/opencode/src/index.ts run
  --dir <fresh-project> --model openai/gpt-5.6-sol --yolo --agent analyst
  --max-turns N --output <output.md> --format json --print-logs --log-level INFO --trace
```

The process has a clean HOME/XDG environment, telemetry disabled, pure mode and
`experimental.auto_mcp_discovery=false`. Only the existing OpenAI OAuth entry is
copied into its private auth store; that copy is removed after exit. The original
store is never changed. Set `ANALYST_SMOKE_AUTH_FILE` if it is outside the standard
XDG data location. Set `ANALYST_SMOKE_ARTIFACTS` to choose where evidence is kept.

Each run retains `command.json`, `started.json`, `run.json`, `events.jsonl`,
`cli.log`, `output.md`, its trace bundle and its synthetic project. Timeouts are
failures after 300 seconds; the process group is killed and the log attached.
The current SQL helper subprocesses inherit this group, so a group-liveness
check also detects helper processes left alive after CLI exit. No `ps` access is
required. Failure details include the full log in `failure-<id>.txt`.

The independent fixture oracle reads persisted rows, normalizes sensor IDs in
code and sums integer cents. It never uses the model's SQL. Short reading rows
exercise row limiting and preview clipping; the 100 KB DuckDB cell exercises
byte clipping. Reading a spill is optional, but a read that is attempted must
succeed. Source mode copies the repository's real `data-question` skill into the
temp project; this does not test compiled skill packaging.

The only capability skips are missing DuckDB/native binding (2b) and an absent
SQLite deadline implementation (3). These dynamic skips are recorded as SKIP in
`results.json` and the wrapper table; Bun itself counts their early return as a
pass. Missing OAuth, connectivity errors, startup failures and timeouts remain
FAIL. The wrapper rejects retry/watch flags and fails if no results were recorded.

Use the dedicated `bunfig.toml` for direct smoke invocations. It avoids the
package's unit-test preload, which imports product modules and installs mock
provider configuration before any smoke checks can run.
