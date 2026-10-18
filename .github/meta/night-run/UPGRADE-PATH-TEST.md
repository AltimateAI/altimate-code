# Upgrade-path test: v0.8.10 → upstream/merge-v1.17.9 (PR #964)

Method: built BOTH binaries from source (v0.8.10 tag + branch). Isolated via XDG_*
temp dirs (v0.8.10 reads data dir from xdg-basedir, NOT OPENCODE_TEST_HOME — that
only overrides `home`). Booted v0.8.10 to create an authentic old-schema DB
(10 drizzle migrations; `session` but no `session_message`/`project_directory`;
session lacks metadata/cost/tokens_*/agent/model). Injected sentinel project +
session rows + a v0.8.10 config.json + auth.json. Booted the NEW binary against
the SAME isolated dir = the upgrade moment.

## Result: 16/16 assertions PASS + idempotent across 3 boots
Schema migrated forward: session.{metadata,cost,tokens_input,tokens_output,agent,
model} added; project_directory + session_message tables created; drizzle journal
advanced 10→11; NO "duplicate column" crash; TUI rendered clean.
Data preserved: sentinel project + session survived; session title byte-identical
(sha1 match); 0 rows lost. Config + auth.json carried over. integrity_check = ok
before and after.

## Minor finding — FIXED (commit 27c490515a) + verified
`__drizzle_migrations` grows by 1 row per launch: the `20260511173437_session-metadata`
entry is re-inserted every boot (markDrizzleEntriesApplied uses INSERT OR IGNORE but
the table has no UNIQUE constraint, so it never dedupes). DDL is guard-checked so it
never re-runs → no crash, no data change, ~50 bytes/launch. FIXED: markDrizzleEntriesApplied now INSERT...WHERE NOT EXISTS(name) + a guarded
dedupeDrizzleJournal self-heal. Re-verified end-to-end: fixed binary boots 3x
against a v0.8.10 DB with journal rows STABLE at 11 (was 11->12->13), no dup
names, integrity ok. Regression test test/storage/db-journal-idempotency.test.ts.

## Safety note
v0.8.10 honors OPENCODE_DISABLE_CHANNEL_DB and reads its data dir from XDG. An early
probe that set that flag without XDG isolation briefly opened the real
~/.local/share/altimate-code/opencode.db (1194 sessions) READ-only-ish — verified
intact (integrity ok, 1194 sessions preserved; v0.8.10 migrations are guarded/idempotent).
Correct isolation for old-binary tests = XDG_{DATA,CONFIG,STATE,CACHE}_HOME, not
OPENCODE_TEST_HOME.
