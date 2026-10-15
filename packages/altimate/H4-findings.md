# H4: v1 user migration feasibility

Measured 2026-10-15 on `spike/v2-branded-host`, starting HEAD `9c4ee060e68eb0b1f75df59f04f87fa10794f906`, with the supplied Bun 1.4.2. This is a decision gate, not a finished migration implementation. Changes are distribution-owned and unstaged; no commit or upstream migration changes.

**Verdict: feasible, but the required subset does not yet pass as a seamless migration.** The real session import, text preservation, scripted continuation, restart, and process-kill recovery work. Literal message/part parity does not hold under v2's representation. Fresh-database provider auth, non-DuckDB connections, keychain verification, and MCP OAuth need explicit handling before shipping. Preserve the existing session transformer and build a small one-way import coordinator around a separate database copy.

## Required-subset decision table

| Requirement | Result | Evidence / named failure |
| --- | --- | --- |
| Correct branded database discovery | **PASS** | Source local channel selects `altimate-code-local.db`; release-family channels select `altimate-code.db`. Old-name-only `opencode.db` produces the H1 diagnostic, not automatic import. |
| Session count | **PASS** | 1,706 v1 sessions → 1,706 v2 sessions. |
| Message/part count parity for three samples | **FAIL: H4-COUNT-PARITY** | One sample changes message count; two change flattened part/content count. All deltas are classified below; v2 has no separate active part table. |
| One session's text hash equality | **PASS** | 22 text parts before/after, identical SHA-256; 32 sessions qualified for this exact comparison. |
| Resume a migrated session | **PASS** | Actual in-process SDK and scripted model: all 21 nonempty historical text parts visible exactly, one new reply persisted. |
| Repeat migration | **PASS** | Restarted process: session, message, and sequence table fingerprints unchanged. |
| Kill mid-migration and recover | **PASS** | SIGKILL after observing 111 committed sessions; rerun reaches 1,706 / 39,086, integrity `ok`, three table fingerprints equal uninterrupted import. |
| Provider auth beside migrated v1 DB | **PASS** | All 6 provider IDs imported and decoded through the actual credential service; rerun remains 6. |
| Provider auth beside fresh DB | **FAIL: H4-AUTH-FRESH** | 0/6 imported, despite legacy import migration being marked applied. Restart remains 0. |
| Global/project/env connection parsing | **PASS for the measured boundary** | 344 typed entries parsed; offline fixtures exercise precedence and relative paths. Real project files and connection env overrides were absent. |
| All v1 warehouses usable | **FAIL: H4-WAREHOUSE-TYPES / H4-WAREHOUSE-PATH** | Existing registry supports DuckDB only: 119 other types unsupported; 3 DuckDB entries lack a path. 222 DuckDB descriptors import. |
| Imported DuckDB executes SQL | **PASS** | Real plugin executes `select 42 AS answer` → `[[42]]`, using a synthetic scratch file entry added only to the copied JSON. |
| Keychain credential resolution | **NOT VERIFIED: H4-KEYCHAIN-LIVE** | No keychain access, as requested. JSON has no explicit references; actual stored-secret count cannot be inferred. |
| MCP OAuth carryover | **FAIL: H4-MCP-OAUTH** | 3 real entries not imported. They contain no tokens; a synthetic token-bearing entry also fails to import. Re-authentication is the current path. |
| Coexistence after cutover | **PASS only with separate DBs and one-way semantics** | Adding a late v1 session to a completed scratch migration leaves 1,707 legacy / 1,706 v2 sessions; it is not imported. |

“Usable provider auth” here means the real v2 credential service can retrieve and decode it. No remote provider validation, OAuth refresh, listener, or paid model call was made.

## Isolation and database filename contract

The source was opened read-only using SQLite's online backup API, including committed WAL contents, rather than copying a live main/WAL/SHM trio:

```sh
umask 077
mkdir -p /private/tmp/altimate-h4/source
sqlite3 -readonly "$HOME/.local/share/altimate-code/opencode.db" \
  ".backup '/private/tmp/altimate-h4/source/opencode.db'"
```

The resulting consistent 264 MiB snapshot was the source for disposable cases. Auth, MCP auth, three config files, and connections JSON were copied under `/private/tmp/altimate-h4`. Every runtime case set `HOME`, all four `XDG_*_HOME` roots, and `TMPDIR` inside that directory before importing host modules. Private fixture directories/files were created under a restrictive umask. No original warehouse file, credential file, message content, or source database was modified by the probes. Credential/connection source hashes matched their initial copies at completion. A live source DB may independently change while v1 runs; a whole-source-file hash equality claim would be inappropriate.

The main run placed the snapshot at:

`/private/tmp/altimate-h4/main/data/altimate-code/altimate-code-local.db`

It used `packages/altimate/script/identity-preload.ts`, the real CLI `databasePath(Global.Path.data)`, `Database.layer`, and `V1Migration.run()` in a scoped Effect runtime. No server listener was created. Initial status was `required`; final status was `completed`. Elapsed schema acquisition plus session conversion was **5,414 ms** in this single warm filesystem run; this is not a cold-start benchmark.

`latest`, `dev`, `beta`, `next`, and `prod` use `<XDG_DATA_HOME>/altimate-code/altimate-code.db`; uncompiled source uses channel `local`, hence `altimate-code-local.db`. `*_DISABLE_CHANNEL_DB=1|true` selects the unsuffixed basename. Absolute `ALTIMATE_CLI_DB` / fallback `OPENCODE_DB` overrides remain possible. Tests exercised old-name-only and both-name cases for local and unsuffixed selection: the new file wins when present; old-name-only throws without copying or opening a fresh DB.

**`opencode.db` is an input to our proposed snapshot coordinator, not the branded default migration target.** Core transforms whichever database it opens in place. The separate historical `opencode-next.db` reader is unrelated. Never point v2 at the user's original `opencode.db` via the override as a migration shortcut.

## Sessions: counts, transformations, and losses

| Representation | Before | After |
| --- | ---: | ---: |
| Sessions (`session` → `session_v2`) | 1,706 | 1,706 |
| Messages (`message` → `session_message`) | 38,341 | 39,086 |
| Legacy part rows | 132,478 | 132,478 retained as inactive legacy archive |
| Active v2 assistant content entries | — | 57,812 |
| Active v2 flattened content units, defined below | — | 61,556 |

V2 message types: user 1,865; assistant 35,345; synthetic 391; system 1,116; compaction 369. Assistant content: text 13,561; reasoning 2,100; tool 42,151. Three user file attachments survive. The legacy `part` table still existing does **not** establish active-history parity.

For a reproducible three-session sample, sessions were sorted by descending source message count, then ID; the first, middle, and last were selected. “V2 content units” counts each assistant content entry, one text/summary/notice unit for each non-assistant message, and user file attachments. This is a disclosed comparison measure, not a claimed v2 part-table count.

| Sample | Session ID | V1 messages | V2 messages | V1 parts | V2 content units |
| --- | --- | ---: | ---: | ---: | ---: |
| Largest | `ses_2f2bf4877ffeIpPjtHJLEqUqL7` | 222 | 167 | 554 | 222 |
| Middle | `ses_2d06539d9ffe6wH4mAnqlWVjha` | 21 | 21 | 73 | 35 |
| Smallest | `ses_f7fe90aacffeo41kXmSta3SKf9` | 1 | 1 | 1 | 1 |

The real exported `transformSession` was also applied to all 1,706 sessions and compared against actual persisted output by message ID, type, sequence, and serialized data: **0 mismatching sessions**. Warning classes `invalid-message`, `invalid-part`, and `orphan-part`: **0 each**. Independent SQL found no orphan messages/parts or missing session projects.

The total message delta is completely accounted for:

- 369 successful compaction trigger/summary pairs become one compaction message each. Trigger IDs remain; summary IDs disappear; their 369 text parts become compaction summary text.
- One unsuccessful compaction pair contributes two omitted message IDs: one trigger and one assistant summary. There are 371 omitted source message IDs in total.
- 1,116 new deterministic-ID system notices describe changed historical tool names/arguments. Thus `38,341 - 371 + 1,116 = 39,086`.
- 391 synthetic text parts become synthetic messages using existing source IDs in this snapshot; no extra synthetic IDs were introduced.
- There are no subtask-only omissions or ignored user text in this input.

Source part inventory: text 16,186; reasoning 2,160; tool 42,151; step-start 35,264; step-finish 34,954; patch 1,390; compaction 370; file 3. Step and patch parts cease being independent content; relevant surviving-message snapshot metadata is assembled from them. **60 reasoning parts belonging to omitted summary messages are not carried into active v2 content.** Those omitted messages also owned 369 step-start, 369 step-finish, and 2 patch parts; their 369 text parts are represented as compaction summaries. The unsuccessful trigger's compaction part is omitted. These are semantic transformations/losses, not schema-validation skips.

Text equality used `ses_2e2a7676effeil16eJMEd1NNEj`: 22 messages with one text part per message, no ignored/synthetic text, and all message IDs preserved. Ordered by source message ID, the compact JSON array of all 22 texts has identical before/after SHA-256:

`be6ed546ab4622c8f20f5511bd389b148ad46ba0f3b8d42b706e812b237c4315`

This includes one empty text. The same session resumed using `OpenCode.create`, the real scripted-model fixture, disabled model fetching/filewatching/snapshots/project config, and a scratch-only relocation of its copied session/project directory. It switched to `scripted/scripted` and `build`, admitted a new prompt, waited, and produced one scripted call. **21/21 nonempty old texts were exact strings in the model prompt**; the empty text is omitted from model input but retained in the migrated DB. Messages went 22 → 27: model-switched, agent-switched, user, assistant, idle. The new assistant reply was durable. No real project config or provider endpoint was needed.

### Attachments and cleared state

All three user file parts were inline `data:` attachments. Decoded payloads were byte-equal after migration: 108,890; 256,439; and 178,312 bytes. Three tool-result attachments also retained their original URI values. Their targets were not opened or fetched.

The plan's blanket statement that attachments become text is too broad for this checkout. Inline user files preserve payloads; non-data user file URLs become an unavailable-attachment text placeholder. There were zero such non-data user files here. Tool attachment URIs survive as references; this does not prove the referenced content remains accessible.

Session permissions were cleared in **1,610** sessions; all 1,706 v2 permission fields are null. Revert and compacting state are explicitly cleared, though both were already null throughout this snapshot. Workspace bindings are null (none populated in the source). All six old events were removed; event sequence watermarks were rebuilt. Six pending and 27 running tool calls become interrupted errors. Twenty already-compacted tool outputs remain cleared markers. Fifteen child-session parent links survive. Legacy todos (569 rows) remain physically archived but are not imported into a v2 todo feature.

### Fork schema comparison

Compared `sqlite_master`/`pragma_table_info` against the supplied v1 checkout's `packages/core/src/database/schema.gen.ts` and `packages/core/src/session/sql.ts`, cross-checking `packages/opencode/src/storage/db.ts` and its migrations. The source contains all expected v1 tables/columns; **no fork-only session/message/part columns or business tables** were found. The sole fork-specific business-schema addition is **`permission.data`**, with **0 rows**; the fork adds it for its JSON permission format. It remains physically present in the copied table but is not consumed by v2's permission API.

Additional bookkeeping tables are `__drizzle_migrations` (11 records; extra `name`/`applied_at` journal metadata) and `migration` (38 records). They are not user conversation data. Do not misclassify upstream credential/account/todo tables as Altimate-only. The v2 split migration removes `data_migration`, `session_context_epoch`, and `session_input`, all empty in this snapshot. Legacy session/message/part/todo tables remain in the copied DB.

## Repeat, interruption, and later v1 writes

The uninterrupted imported tables had these SHA-256 fingerprints (ordered complete rows, compact JSON):

| Table | SHA-256 |
| --- | --- |
| `session_v2` | `b8bf441c2b16d1e27aade3a3a23a04ef8c6fe5642c9315954483e55eca95b614` |
| `session_message` | `10baa37a2bba22e40c0d9539b4698879b9b8f31a816f0bc121c99db3f301b613` |
| `event_sequence` | `625ca46ee2800e70da82d21c4d7a3ec689b3a5ec7b7255bf21bae938be264879` |

A new process rerunning migration left all three identical. A separate source copy was migrated while a parent process polled committed rows. At 111 sessions it sent SIGKILL (exit `-9`); the observed cursor was `ses_f39aa3186ffeF42wsqrdC27SSQ`. Restart completed with all three fingerprints identical to the uninterrupted result and `PRAGMA integrity_check = ok`. This is an actual kill, with no production hook. It covers one observed interruption point, not exhaustive fault injection.

The code commits cursor and session projection together, then marks `kv['migration.v1-v2']` completed permanently. To measure coexistence, a synthetic late legacy session was inserted only into a finished scratch copy: rerun left **1,707 legacy sessions / 1,706 v2 sessions**, and the new session was absent from v2. Resetting the completion flag is not a supported merge strategy.

## Provider auth and MCP OAuth

Auth files were placed beside a fresh branded DB and, separately, a copied v1 DB. Both used the real schema migration path and credential service. Fresh bootstrap creates schema and records all migrations without executing their `up()` functions: **0/6 credentials**. On the v1 copy, `applyOnly` executes `20260805200742_import_legacy_credentials`: **6/6**. These IDs resolve: `anthropic`, `azure`, `google`, `google-vertex-anthropic`, `google-vertex`, `openai`. Restart stays 6, with no duplicates.

The minimal fix is an explicit first-import credential step independent of schema-journal completion, reusing the existing conversion and preserving existing v2 credentials. Do not delete the migration row at every startup. No such auth adapter was implemented during this feasibility slice.

The real `mcp-auth.json` contains **3 server entries**, each with `clientInfo`, `codeVerifier`, `oauthState`, and `serverUrl`; **zero contain `tokens`**. After migration there were zero MCP credential rows and zero migrated client registrations. To avoid concluding “not imported” merely because input tokens were absent, a fourth synthetic entry with dummy tokens/client registration and an `.invalid` URL was added to a COPY. Migrating another v1 DB copy still produced zero MCP credentials. The real `McpOAuth.connectProvider` token/client lookup path was exercised without making HTTP calls.

This matches [upstream issue #54879](https://github.com/anomalyco/opencode/issues/54879), inspected as open/reproduced on 2026-10-15. Current behavior is **re-authentication required**. A seamless importer would need the exact server-name/URL-derived v2 integration identity, OAuth method, expiry/scope, and client-registration field mapping; transient verifier/state should not be blindly reused. This user's three entries independently need authentication because none have saved tokens.

## Warehouse adapter and measured scope

`src/legacy-warehouses.ts` reads global `~/.altimate-code/connections.json`, project `.altimate-code/connections.json`, and `ALTIMATE_CODE_CONN_*` overrides. Precedence is global < project < environment; environment suffixes become lowercase connection names. Global relative paths resolve against `~/.altimate-code`; project/environment paths resolve against the Location directory. The adapter inventories all typed definitions but emits only the existing S1 registry's `{name,type:'duckdb',path}` shape. It neither accesses the keychain nor persists arbitrary credential fields.

| Real input result | Count |
| --- | ---: |
| Typed definitions parsed | 344 |
| DuckDB / SQLite / Snowflake / BigQuery | 225 / 117 / 1 / 1 |
| DuckDB descriptors admitted to registry | 222 |
| DuckDB missing `path` | 3 |
| Unsupported non-DuckDB types | 119 |

The three missing-path definitions are `green_taxi_duckdb`, `nyc_taxi_duckdb`, and `dbt_crypto_dbt_dev`; two have a `database` key instead of `path`, one only `type`. No project connection file existed in either checkout and no real connection environment overrides were set; those dimensions are covered by offline fixtures. Metadata-only path inspection found 171 existing local DuckDB files, 49 missing/nonlocal paths, two memory entries, and three absent paths. Existing warehouses were never opened.

The actual copied-input probe added `h4_synthetic_probe` pointing to a newly created scratch DuckDB file. The identity-preloaded in-process SDK, production plugin registry, and scripted model executed `sql_execute` and returned `[[42]]`; two scripted calls covered tool use and completion. There was no listener and no real warehouse access.

Zero explicit keychain reference markers exist in the JSON. **That is not a count of stored secrets.** V1 strips sensitive fields when saving and implicitly probes OS service `altimate-code`, account `<connection-name>/<field>`, when a sensitive field is absent. The Snowflake definition lacks password/private-key/token fields. The BigQuery definition has a `credentials_path`; that file was not read. A stored-secret/reference count cannot be established from this file without the prohibited keychain read. Live keychain access and cloud-warehouse authentication remain a named gate.

Only the minimum parser/storage/execution seam was added. The current registry does not preserve all DuckDB options (such as read-only flags or default schema), support other drivers, or provide a finished migration preview/retry UI. These are explicit scope limits, not successful migrations of those connections.

File definitions seed the per-Location `ctx.storage` registry, preserving existing v2 names. Environment overrides are reapplied at every plugin setup and are never persisted, including when `warehouse_add` saves another definition. An import report stores safe issue names. A completion marker is written only when a source file exists and there are no issues; absent, unreadable, malformed, or partially unsupported input remains retryable. This real snapshot has 122 issues, so later setup retries it. Already accepted names remain pinned; changing those requires an explicit v2 update. Unreadable files do not abort the mandatory plugin.

## Recommended migration design and size

1. Before opening v2 storage, detect v1 `opencode.db` only as an import source. Create a consistent online SQLite backup at a temporary new-name destination; never rename or open the source for write. Record snapshot time, source identity/fingerprint, counts, and a nonsecret import manifest.
2. Migrate the temporary copy using the existing schema/session code. Explicitly import provider auth independently of whether the DB was fresh. Verify integrity, counts, classified losses, and migration completion before publishing under `altimate-code.db` (or the selected channel basename).
3. Import global/project connection definitions into plugin-owned storage with a receipt, preserve existing v2 registrations, and apply environment overrides at runtime. Resolve keychain credentials lazily through the legacy service/account contract; do not persist resolved secrets in warehouse RPC/storage. Surface unsupported definitions and unavailable file paths.
4. Present MCP re-authentication as an explicit cutover action unless a separately validated OAuth importer is built. Preserve the original auth/config/connection files and OS keychain entries.
5. Keep v1's `opencode.db` untouched. Recommend v1 as an archive after cutover. Concurrent v1 use against its own DB is possible, but later writes form a divergent history and are never imported automatically. Sharing the migrated DB via an override is unsupported. After v2 accepts new work, do not automatically reset/replay the import or overwrite its DB.

Rough **additional distribution-owned production lines**, not a commitment or code shipped in H4:

| Required work | Lines |
| --- | ---: |
| Snapshot coordinator, new-name publication, manifest and recovery boundary | 100–180 |
| Explicit fresh/upgraded provider credential import | 30–70 |
| Full warehouse descriptors, existing driver dispatch, option preservation | 120–200 |
| Lazy legacy keychain bridge and actionable missing/locked diagnostics | 80–140 |
| Import receipts, retry/reporting and project-policy integration | 60–100 |
| MCP re-auth detection/action | 20–40 |
| Semantic parity/loss accounting | 50–100 |
| **Total beyond the H4 measurement adapter** | **460–830** |

Allow roughly 300–500 additional offline test lines. Seamless MCP token transfer instead of re-auth detection is approximately 100–180 production lines plus 80–150 test lines and a live OAuth refresh validation. Literal part-count equality would require changing the acceptance criterion or a different history representation; it is not a small import bug to patch. Full arbitrary v1 config translation and all warehouse driver behavior remain outside this estimate.

## Verification and retained artifacts

The measurement used the actual migration, credential, MCP credential lookup, SDK, scripted model, and plugin code. No migration mock or copied transformation implementation was used. Independent review checked the evidence against this report and the adapter's precedence, persistence, error handling, and privacy boundaries.

| Final verification | Result |
| --- | --- |
| `packages/altimate`: `bun test test/h4-warehouses.test.ts` | 8 pass, 0 fail, 22 assertions |
| `packages/altimate`: `bun test test/s1-data-tools.test.ts test/s8-rpc.test.ts` | 10 pass, 0 fail, 36 assertions |
| `packages/altimate`: `bun typecheck` | Pass |
| Repository root: `bun run check`, after final adapter changes | 37/37 tasks successful |
| `git diff --check` | Pass |
| Actual copied-input plugin probe, rerun after adapter review fixes | `select 42` passes; source connection hash unchanged |

The eight H4 tests cover precedence and path bases; unsupported/missing fields and secret-value exclusion; malformed input; memory/URI/Windows/absolute paths; unreadable files; actual file-backed SQL and one-way persistence; refreshed non-persisted environment overrides; and malformed-input repair/retry. Integration fixtures save, clear, and restore ambient connection overrides.

Patch size against starting HEAD, without staging: `src/legacy-warehouses.ts` **+84**; `src/server.ts` **+25/-5**; `test/h4-warehouses.test.ts` **+259**. That is **109 added / 5 removed production lines**, entirely under `packages/altimate`, plus 259 test lines and this report. No Protocol/HttpApi change or generated client update is needed.

Reproduction needs new read-only copies because privacy cleanup removes the datasets, temporary probe scripts, outputs, and logs. Use the supplied Bun path, preload identity before host imports, set scratch HOME/XDG/TMPDIR, acquire `Database.layer` with the CLI-selected path, then call `V1Migration.status/run/status`. For interruption, launch a child and SIGKILL after a read-only poll observes a nonzero incomplete `session_v2` count; restart the same destination. Compare ordered session/message/event-sequence row hashes, not just counts. For continuation, use `OpenCode.create` with the scripted-model fixture and a copied session relocated to a scratch project.

Canonical report: `packages/altimate/H4-findings.md`. A sanitized copy is retained at `/private/tmp/altimate-h4/H4-findings.md`; all other H4 scratch data is removed after validation. The default work-vault copy is blocked: `/Users/anandgupta/obsidian/altimate/Research/` is outside the writable roots and this session has no approval mechanism. Intended destination: `Research/Branded host spike/H4 v1 user migration feasibility.md`.
