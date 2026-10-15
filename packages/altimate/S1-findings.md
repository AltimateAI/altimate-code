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
