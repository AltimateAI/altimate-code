# S1 data-tools spike findings

Date: 2026-10-15. Upstream: OpenCode v2.0.29. Bun: 1.4.2.

**Partial acceptance: a, b1–b4, d, and e pass. Native cancellation (c) fails.**
The normal suite reports 11 pass, 1 explicit TODO, 0 fail. The TODO has a real
SDK test body and was temporarily enabled as a normal test to prove its failure.
No upstream source files were modified, and nothing was staged or committed.
The existing `bun.lock` modification and scaffolded `package.json` were preserved.

## Implementation

- `src/server.ts`: Promise `Plugin.define`, Location/project-scoped registry,
  persisted warehouse definitions, and `warehouse_add`, `sql_execute`, and
  `schema_inspect`. Each tool sets `codemode: false`. Native DuckDB loads in-process.
- `src/sql-classify.ts`: minimal v1 classifier port with conservative handling
  where the optional v1 AST parser is unavailable.
- `tsconfig.json`: mirrors the plugin package, including tests in typechecking.
- `test/lib/{environment,host,scripted-model,provider-fixture}.ts`: isolated SDK
  host with persistent SQLite DB, temporary global paths, and scripted tool/text
  responses through public provider and AI SDK hooks.
- `test/s1-data-tools.test.ts`: requested acceptance scenarios, including the
  runnable native cancellation TODO.
- `test/sql-classification.test.ts`: four SDK regressions for row limits and
  SQL permission classification.
- `../drivers/src/duckdb.ts:319`: explicitly closes its connection before the
  database, awaits both callbacks, and propagates failures. Removed the old
  500 ms timer that could report cleanup complete before native completion.

Structured output is returned using the tool's output schema and repeated in
metadata because durable session tool events expose content and metadata, rather
than a separate output field. Model-facing content contains a readable text table.
Big integers become decimal strings for JSON output. Warehouse definitions persist;
`:memory:` table contents intentionally do not persist across hosts.

## Commands and results

All commands used this Bun executable prefix:

```sh
export PATH=/private/tmp/claude-501/-Users-anandgupta-codebase-altimate-code/a3ba8813-c4f4-4234-9efe-d5c7103ee560/scratchpad/bun142/bun-darwin-aarch64:$PATH
cd /Users/anandgupta/codebase/altimate-code-v2-spike/packages/altimate
bun test
bun run typecheck
```

`bun test`: exit 0, **11 pass / 1 TODO / 0 fail**, 28 assertions.
`bun run typecheck`: exit 0 (`tsgo --noEmit`, source and tests).

| Test | Result |
| --- | --- |
| a. sql_execute SELECT returns structured rows and a text table | PASS |
| b1. configured deny prevents write execution | PASS |
| b2. plain reject ends the step and prevents write execution | PASS |
| b3. reject with feedback returns a tool failure and prevents write execution | PASS |
| b4. once approval executes the write and the table can be read | PASS |
| c. native DuckDB cancellation prevents a running query from committing | FAIL when enabled; retained as TODO |
| d. schema_inspect lists the created table and its columns | PASS |
| e. warehouse definitions persist across hosts sharing DB and storage | PASS |
| sql_execute applies the requested row limit and reports truncation | PASS |
| a read followed by a write is denied before executing the SQL batch | PASS |
| EXPLAIN ANALYZE cannot bypass write permission | PASS |
| comment-looking string cannot bypass write permission | PASS |

The canonical root `bun run check` also passed: zero lint errors, 1,353 warnings,
zero SDK documentation problems, and 37/37 successful package typechecks.
See [test output](evidence/test-results.txt), [package typecheck](evidence/typecheck.txt),
and [root check](evidence/root-check.txt).

Permission assertions preserve v1's action `sql_execute_write`, SQL-prefix
resources (first 200 characters), and `save: ["*"]`. Tests use public
`permission.list` / `permission.reply`. Plain rejection consumes no further
model response; rejection with feedback produces the canonical
`permission.rejected` tool failure and allows continuation. Each rejected write
is followed by a public SQL read verifying the table was never created.

## Non-vacuity proof

Temporarily commented out the entire `sql_execute` registration and ran:

```sh
bun test --test-name-pattern '^a\.'
```

It failed with exit 1: no successful result existed for the scripted SELECT.
Restored registration in a `finally` block; the final full suite passes.
See [mutation output](evidence/registration-mutation.txt).

## Native driver blockers

The installed `duckdb@1.4.4` binding cannot implement the requested interrupt:

- `packages/drivers/node_modules/duckdb/src/connection.cpp:19` registers the
  Connection methods without `interrupt`. Runtime inspection confirms it is absent.
- `packages/drivers/node_modules/duckdb/src/database.cpp:261` implements
  `Database::Interrupt` by immediately returning `this`; it does no work.
- A native diagnostic called `db.interrupt()` at 53 ms while running a bounded
  100-million-row aggregation. The query succeeded at 577 ms with no error.

The public SDK reproduction waits for `session.tool.progress`, then interrupts
a bounded `CREATE TABLE ... AS SELECT sum(sin(...)) FROM range(100000000)` query.
The tool records `aborted`, interruption returns promptly, and a subsequent SDK
query succeeds. However, that query finds the newly committed `after_abort`
table. Native execution survived interruption. This is an unmet acceptance
criterion, not a successful cancellation implementation.

Temporarily changing the single `test.todo` to `test` and running
`bun test --test-name-pattern '^c\.'` produces exit 1; it was restored afterwards.
See [cancellation failure](evidence/cancellation-gap.txt). To inspect the TODO
without changing the file, run `bun test --todo --test-name-pattern '^c\.'`;
Bun prints the failed assertion but still counts it as TODO and exits 0.

Connection cleanup is improved, but deterministic file-lock release has another
native limitation: `packages/drivers/node_modules/duckdb/src/statement.cpp:621`
leaves the statement reset commented out in `FinishTask::DoWork`. Prepared
statements can retain the database until garbage collection. Diagnostics showed
close callbacks completing, queries on the closed connection rejecting, and
idempotent close succeeding. A file with prior queries could still retain its
lock; explicit GC released it in a diagnostic. No GC workaround or dependency
patch was added.

These are dependency API gaps, not missing OpenCode plugin hooks. A supported
DuckDB binding with a real connection interrupt and deterministic resource
release is required before c can pass. No upstream patch was attempted.

## Workarounds and scope

- OpenCode captures XDG roots at import time
  (`packages/util/src/global-roots.ts:5`). Its default paths caused HTTP 500 on
  location initialization under the sandbox. The test process sets isolated
  XDG roots before importing the SDK and removes them at process exit.
- `agents.title.disabled: true` prevents background title calls from consuming
  scripted responses. The provider fixture exports a `create*` SDK factory;
  the language hook assigns `event.language` rather than returning a model.
- The optional `@altimateai/altimate-core` parser is not installed. The fallback
  conservatively requests permission for `WITH`, `EXPLAIN`, and comment markers,
  including read-only instances. This avoids known fallback write bypasses but
  does not claim full AST classification parity. V1's hard-deny patterns remain.
- File paths retain the copied driver's existing-file requirement; the tool
  does not silently create a database for a mistyped path.
- No Obsidian copy was made: this task's explicit write boundary permits only
  `packages/altimate` and `packages/drivers`.

Wall-clock work began at 09:03:41 UTC and finished at 09:21:53 UTC,
approximately 18 minutes, within the 40-minute budget.

## S1b — interruptible DuckDB binding (2026-10-15, round 2)

**The native cancellation blocker above is resolved.** All original S1 scenarios,
including the former TODO (c), pass with `@duckdb/node-api@1.4.4-r.1` on darwin-arm64
and Bun 1.4.2. Classification: **P\*** for the binding/driver adaptation; the v2
plugin interfaces themselves are **P**, with no upstream extension point or patch
required for this slice.

### Changes and behavior

- Rewrote `packages/drivers/src/duckdb.ts` against the installed Node API. Its
  async instance/connection/query APIs replace callback-based legacy `duckdb`.
  Existing path guards, explicit read-only opening, lock-error fallback,
  configurable open timeout, binds, limits, and schema operations remain behind
  the same `Connector` interface.
- `ExecuteOptions.signal` is optional, so existing callers remain compatible.
  `packages/altimate/src/server.ts:116` forwards the tool's `context.signal`.
  The driver calls the real `DuckDBConnection.interrupt()`, awaits native query
  settlement, and removes the listener in `finally`.
- Queries sharing a connection are admitted serially. A reproduced concurrent
  case showed why this is necessary: attaching a queued query's signal directly
  to the connection interrupted its predecessor, while the cancelled queued
  write still committed. The pre-admission abort check now prevents that write
  from starting and leaves its predecessor running.
- Close interrupts active work, waits for tracked queries, then calls connection
  `closeSync()` followed by instance `closeSync()`. No timers, forced garbage
  collection, or native dependency patches are used to release file locks.
- Removed the legacy `duckdb` declaration from both package manifests and updated
  the optional-driver package map to `@duckdb/node-api`. The pre-existing root
  `bun.lock` edit was left untouched; no install or lockfile regeneration ran.

### Cancellation evidence

Test (c) creates a real database and a committed baseline table, registers it via
SDK `warehouse_add`, starts a billion-row cross-join CTAS aggregate, waits for tool
progress plus 50 ms, then calls public `sessions.interrupt` and `sessions.wait`.
It asserts interruption under two seconds, `session.tool.failed` with `aborted`,
and absence of `after_abort` through a subsequent SDK query on the same connection.
Replacing the warehouse awaits close. A fresh Bun process immediately opens the
same file, verifies the interrupted table is absent and the baseline is preserved,
and commits/reads a new table. This proves rollback, connection reuse, and file-lock
release independently of an in-process cache.

Temporarily removing only the signal forwarding made (c) fail: the CTAS completed
and `after_abort` existed after 5.93 seconds. The forwarding was restored in a
`finally` block and the tests rerun. See
[cancellation negative control](evidence/s1b-cancellation-mutation.txt),
[first passing cancellation](evidence/s1b-cancellation.txt), and
[S1 rerun](evidence/s1b-tests.txt).

| S1 acceptance / regression | Result |
| --- | --- |
| a. structured SELECT rows and text table | PASS |
| b1. configured deny prevents write | PASS |
| b2. plain reject ends the step and prevents write | PASS |
| b3. reject with feedback reports failure and prevents write | PASS |
| b4. once approval executes write | PASS |
| c. native cancellation, no committed CTAS, same-connection reuse, independent reopen/write | PASS (was TODO) |
| d. schema inspection | PASS |
| e. warehouse persistence across hosts | PASS |
| requested row limit/truncation | PASS |
| read/write batch permission | PASS |
| EXPLAIN ANALYZE permission | PASS |
| comment-looking string permission | PASS |
| queued cancellation does not interrupt active query or commit queued write | PASS |
| already-aborted signal prevents execution | PASS |
| Date/Buffer/Uint8Array binds, empty-result columns, and noLimit compatibility | PASS |

### Remaining scope and v2 gaps

No v2 cancellation API gap remains for this acceptance slice. Native interruption
is a connection operation, so serialization is driver-owned. Cancellation is not
a rollback guarantee for a write that committed before the signal arrived; the
acceptance query is deliberately long-running and its negative control establishes
that it was still executing when interrupted.

The driver retains lazy `loadOptionalDriver` lookup, now targeting the Node API
package, including its existing managed-path fallback. Workspace loading is
proven; compiled-binary/managed discovery, registry installation, and other
platforms remain unverified S7 work. S1's optional SQL-parser limitation remains
unchanged. Date and byte binds are normalized to the Node API's timestamp/blob
wrappers; a real-query regression covers Date, Buffer, Uint8Array, empty-result
column metadata, and `noLimit`.

Final combined test/typecheck/check receipts are
[round2-tests.txt](evidence/round2-tests.txt),
[round2-typecheck.txt](evidence/round2-typecheck.txt), and
[round2-root-check.txt](evidence/round2-root-check.txt).
Only `packages/altimate/**` and `packages/drivers/**` were edited; all changes are
unstaged. The explicit write boundary also precludes the default Obsidian copy.

Final round-2 verification: **25 pass / 0 fail / 0 TODO, 106 assertions** (12 S1,
3 driver regressions, 10 S5). Package typecheck and canonical root check both exit
0; root lint reports 1,353 warnings and zero errors, SDK documentation reports zero
problems, and all 37 package typechecks succeed. `git diff --check` passes and the
Git index is empty. Work ran approximately 09:27:50–09:40:32 UTC (13 minutes),
within the 40-minute budget.
