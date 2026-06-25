# Secondary findings from WS4 (commands) + WS5 (traces)

These are surfaced by the command/trace verification. They are **fork-feature** issues, separate
from the merge-integration ship (which is green). Triaged by severity + regression-vs-pre-existing.

## 1. Tracing produces no artifacts — MERGE REGRESSION (top follow-up)
- **Symptom** (WS5): `altimate run ... --trace` (tracing is on by default) executes the task fine
  but writes **0 trace files**; `trace view <id>` then can't find the trace.
- **Root cause** (pinpointed): the tracer setup in `cli/cmd/run.ts` (~L597) calls `Config.get()`,
  which runs an Effect that requires `InstanceRef` (`effect/instance-state.ts:16` →
  `Effect.die("InstanceRef not provided")`). At that point in the CLI run flow the instance
  context isn't bridged into the Effect runtime, so it throws; the surrounding
  `try { ... } catch { return null }` swallows it → `tracer = null` → `startTrace`/`endTrace`
  are skipped → no artifact. (The separate `azure/claude-haiku-4-5` title-gen failure — an
  unresolved `${AZURE_RESOURCE_NAME}` URL in local config — is NOT the cause.)
- **Fix direction**: provide the instance to the tracer-setup `Config.get()` the same way the fork
  bridges Effect `InstanceRef` ↔ legacy ALS elsewhere (see `share-next.ts:319` `withInstance`,
  `tool-zod-compat.ts:257`), or move tracer creation to where the instance scope already exists.
  Non-trivial (client/server + Effect/ALS); deliberately not rushed onto the green build.

## 2. `skill list` fails with the SAME root cause — MERGE REGRESSION
- `altimate skill list` exits 1: `Error: Unexpected error` / `InstanceRef not provided`.
- Same `InstanceRef`-not-bridged gap as tracing; a single CLI instance-context fix likely covers both.
- Note: `mcp list`, `agent list`, etc. work (they run within a proper instance scope), so this is
  path-specific, not all CLI Effect commands.

## 3. `trajectory` command not registered — PRE-EXISTING (not a merge regression)
- `TrajectoryCommand` exists in `cli/cmd/trajectory.ts` but is not wired into `src/index.ts`.
- Verified: `git show main:.../index.ts` has 0 trajectory refs too — it was never registered. Out of
  scope for this PR; file as its own issue if the command is wanted.

## 4. `attach`/`run` help show `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME` + default user `opencode`
- The env-var NAMES are functional (the code reads `Flag.OPENCODE_SERVER_*`), so they're not pure
  branding. The default username `opencode` in `attach` help is a minor cosmetic leak. Low priority.

## Non-issues
- `completion --help` exits 1 / prints root help — a yargs built-in quirk; the actual completion
  script smoke works.
- `workspace-serve` prints root help — intentionally conditional on `InstallationLocal`, absent from
  this build.

## WS4 bottom line
87 commands enumerated, **78 OK**. Of the 9 "broken": 2 are the InstanceRef regression (#1/#2),
4 are the pre-existing unregistered `trajectory` (#3), 1 minor help-branding (#4), 2 non-issues.
The core CLI surface (run/serve/tui/mcp/agent/session/config/models/providers/db/stats/github/etc.)
works.
