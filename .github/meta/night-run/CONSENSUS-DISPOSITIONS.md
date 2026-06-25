# Consensus code-review (glm 5.2 / deepseek / kimi k2.6) — must-fix dispositions

Tracking how each consensus must-fix was resolved on `upstream/merge-v1.17.9`.

## 1. migration.ts hardcoded schema fingerprint — CRITICAL drift hazard  → FIXED (`1ab842115c`)
`currentSchemaTables`/`currentSchemaColumns`/`currentSchemaIndexes` in `packages/core/src/database/migration.ts`
are a hand-maintained fingerprint of `schema.gen` used by `applyOnly` to adopt a DB already at the
generated schema. A migration that adds/renames/removes a schema object without updating the
fingerprint makes a previous-schema DB falsely fingerprint as "current" → the new migration is marked
applied without running.

Fix: exported the three constants and added a `schema fingerprint drift guard` suite to
`database-migration.test.ts`:
- `currentSchemaTables` set-equals the generated user tables (catches add/remove/rename).
- `currentSchemaIndexes` set-equals the generated indexes (verified 17==17).
- `currentSchemaColumns` entries must all be live columns (subset validity; column list is an
  intentionally curated version fingerprint — documented residual: a brand-new column on an existing
  table must be added by hand).
- Behavioral: `apply()` adopts a generated schema with no journal (no baseline CREATE replayed).
- Mutation-tested: dropping a fingerprint entry fails the guard.

## 2. currentSchemaApplied TOCTOU (DeepSeek)  → FIXED (`1ab842115c`)
The `apply()` empty-DB create path already re-checks under `BEGIN IMMEDIATE`. The remaining gap was
`applyOnly`'s adoption short-circuit: `currentSchemaApplied(db)` then `markMigrationsApplied(db)` ran
without a transaction. Wrapped the check+mark together under `db.transaction(..., { behavior: "immediate" })`
so a concurrent migrator cannot slip a real migration between the check and the mark.

## 3. task.background "single gatekeeper" (task.ts publishes full schema, registry.ts strips)  → WONT-FIX (documented)
Recommendation: consolidate to one gatekeeper, with registry as the flag-aware layer.

Investigated and **declined for this merge-stabilization PR**, because the apparent redundancy is
intentional, not a bug:
- `task.ts` publishes a `jsonSchema` with `background` stripped **unconditionally**, and `execute()`
  rejects `background === true` **unconditionally**. This is the fork's *current hard-disable* of
  background subagents. `fromTool()` reads `tool.jsonSchema`, so this strip is authoritative for what
  the model sees.
- `registry.ts`'s `applyRuntimeToolSchemaFlags` strips `background` only when
  `experimentalBackgroundSubagents` is off. Its marker says "hide task.background **unless** the
  runtime flag enables it" — it is *forward-looking infra* for re-enabling the feature via the flag.
- The feature is genuinely implemented upstream (`BackgroundJob` service; `task.test.ts` has a full
  background suite asserting `metadata.background === true` and `jobs.wait(...)`), but those tests are
  `.skip`ped due to a **test-infra DB-migration race** (see `task.test.ts:226`), and `execute()` has
  no background path wired in the fork.

Either "fix" is wrong here: removing registry's stripper deletes intentional infra; making the flag
functional re-enables an incompletely-tested feature (needs `BackgroundJob` wired into `execute()` +
the racy tests un-skipped) — out of scope for the merge. Current behavior is correct: background is
hidden from models and rejected at runtime by default. Leaving the two layers as-is (active
hard-disable + dormant flag infra). Revisit when background subagents are intentionally re-enabled.

## 4. db.ts test fixture — derive dataTables from live schema  → FIXED
`packages/opencode/test/fixture/db.ts` hardcoded a 19-table `dataTables` list that `resetDatabase()`
`DELETE`s between tests — the same drift hazard: a table added by a future migration wouldn't be
cleared, leaking rows across tests. Now derives the data tables from the live schema
(`sqlite_master`), excluding the migration journal (`migration`/`__drizzle_migrations`, preserved so
the DB stays "migrated"). `foreign_keys` is OFF during the reset, so cross-table DELETE order is
irrelevant — the previously-hardcoded ordering is unnecessary. Verified: registry + read-only smoke
suites green.
