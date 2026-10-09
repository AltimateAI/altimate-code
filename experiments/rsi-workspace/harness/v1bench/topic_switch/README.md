# Topic-switch sessions (benchmark item 4)

`tasks.json` lists 3 request-1 prompts (document a staging yml, explain a staging model read-only, add a README section)
and 6 request-2 tasks (the 4 heldout staging tasks + 2 controls); 18 sessions per arm.

## How request 2 is sent

Same workdir, same agent session, a second `run` invocation with `--session <id>`:

    <ALTIMATE_CMD> run --format json -m <model> --max-turns 40 --yolo --session <session_id> "<request 2 prompt>"

- `session_id` is `sessionID` of the first events line of request 1 (`common.parse_events(...)["session_id"]`, common.py:331).
- CLI option: `packages/opencode/src/cli/cmd/run.ts:305` (`--session`/`-s`), `:300` (`--continue`/`-c` = last root session
  in that data dir, not safe with parallel runs); resolved at `run.ts:562` (`baseID = args.continue ? ... : args.session`,
  `if (baseID) return baseID`). A resumed run sets `ALTIMATE_RUN_RESUMED=1` (`run.ts:452`, `cli/cmd/run/run-mode.ts:29`) so
  run mode pins the LATEST user instruction as the task instead of the first one.
- Existing precedent in the harness: `loop_corrections.py:136-166` (`followup()`: `--session rec["session_id"]`, same cwd,
  same user env, verifies `ev["session_id"] == rec["session_id"]`).
- Request 1 runs through `common.run_task` (setup, playbook install, env, stagger, db-lock retry); `run_topic_switch.py`
  gives it a synthetic task (request 1 prompt, request 2's `setup`, a no-op verifier). The project is identical for every
  task, so request 2's `setup` argv serves both.

## Scoring

Only request 2 is scored, by the unchanged verifier of the request-2 task on the final workdir
(`common.run_verify(task2, workdir)` -> `demo/verifier/check.py <workdir> <task2 id>`): heldout -> C1..C6, controls -> K1..K4.
Request 1 is not scored for verifier pass. It must complete successfully, without timeout
or runtime error, and emit a session ID. Request 2 must complete in that same session.
Any incomplete or non-resumed session gets a failed pass/overall score and an error record;
request-1 failures have no check scores. Summary rates exclude incomplete sessions. The doc/readme edits cannot disturb the checks (the checks read
the new billing/support model files, `stg_shop__customers` columns, `stg_shop__orders.sql` with comment-stripped, whitespace-normalized equality, and `analyses/payments_by_month.sql`). `explain-orders` is read-only (`stg_shop__orders.sql` must stay
unchanged for control K4; the prompt says not to change files).

Per-turn metrics: `turn1` and `turn2` hold tokens/cost/steps/duration. A resumed command
can replace the product trace, so the driver copies turn 1 before resuming and turn 2
after completion. `trace_paths.turn1` and `trace_paths.turn2` point to those separate
snapshots. Event and trace filenames include the unique workdir name, so retries keep their own evidence.
`t_req2_start` records the child launch time in epoch milliseconds, after acquiring the spawn lock;
`turn2.duration` measures from that launch through command completion, excluding lock-queue and verifier time.

The hardened driver has been checked with mocked, local self-tests only. Historical
`results-*.md` observations predate these completion and trace checks.
