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
Request 1 is not scored for pass (it only has to finish; record `turn1.timed_out`/errors; sessions where turn 1 produced
no session id are recorded as failures with `error`). The doc/readme edits cannot disturb the checks (the checks read
the new billing/support model files, `stg_shop__customers` columns, `stg_shop__orders.sql` byte-for-byte after comment
stripping, and `analyses/payments_by_month.sql`). `explain-orders` is read-only (`stg_shop__orders.sql` must stay
unchanged for control K4; the prompt says not to change files).

Per-turn metrics: `turn1` and `turn2` hold tokens/cost/steps/duration; the session trace
(`trace_path`) holds both turns' spans, split on `t_req2_start` (epoch ms) against each span's `startTime` (check the unit in a real trace first).

`run_topic_switch.py` has NOT been run against a model (the brief said not to run any); it was import-checked only.
