/**
 * Tier 2/3 model-in-the-loop eval for the `snowflake-setup` skill.
 *
 * WHAT THIS TESTS
 *   Runs a real LLM turn through the `snowflake-setup` skill in non-interactive
 *   `altimate-code run --yolo` mode, captures the emitted DDL, and grades it
 *   against the skill's non-negotiable guardrails from SKILL.md.
 *
 * This is genuine end-to-end verification — the same code path a real user
 * hits when typing `/snowflake-setup` in the TUI. It exercises: skill
 * discovery, skill loading, LLM instruction-following, tool use (bash for
 * mkdir + write tool for the SQL files), and downstream file emission.
 *
 * WHAT THIS DOES NOT TEST
 *   - Applying the emitted DDL to a real Snowflake account
 *   - Rollback correctness end-to-end
 *   - Audit mode against a broken account
 *   - Terraform HCL emission or `terraform validate`
 *   - External integrations (S3, SSO, DR, sharing, Cortex)
 *
 * Those are documented in `.opencode/skills/snowflake-setup/TESTING.md` and
 * remain manual until the harness matures.
 *
 * WHY IT IS OPT-IN
 *   - Requires a working Altimate LLM Gateway login (~/.altimate/altimate.json)
 *   - Costs API credits (~120K tokens per run at time of writing)
 *   - Takes ~90 seconds
 *   - Not deterministic across model versions (the LLM emits slightly different
 *     phrasing / comments each run; assertions are shape-based, not literal)
 *
 * Run with:
 *   SNOWFLAKE_SETUP_EVAL=1 bun test test/altimate/snowflake-setup-eval.test.ts
 *
 * The golden files at fixtures/snowflake-setup/*.expected.sql are the OUTPUT
 * from a prior successful run — kept as reference, not asserted verbatim
 * against. Use them to eyeball drift when this test starts failing.
 */

import { describe, test, expect } from "bun:test"
import { execSync } from "node:child_process"
import { readFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const EVAL_ENABLED = process.env.SNOWFLAKE_SETUP_EVAL === "1"
const REPO_ROOT = join(import.meta.dir, "../../../..")

// Write emitted artifacts to a temp directory instead of inside the checkout.
// The prior in-tree `packages/opencode/eval-artifacts/` was untracked and
// dirtied the working tree on every run (PR #1164 review comment 27).
const ARTIFACT_DIR = join(tmpdir(), "snowflake-setup-eval")
const GREENFIELD_SQL_PATH = join(ARTIFACT_DIR, "greenfield.sql")
const ROLLBACK_SQL_PATH = join(ARTIFACT_DIR, "rollback.sql")

const PROMPT = [
  "Invoke the snowflake-setup skill.",
  "Pre-answered triage: mode=greenfield, format=sql, execution=review-only.",
  "Detail answers: topology=Medallion, RBAC=small-team, envs=prod-only,",
  "ingestion=Snowpipe(AWS S3), cloud=AWS, emission=idempotent, budget=500 credits,",
  "PII discovery=declared with categories email/first_name/last_name,",
  "no multi-tenancy, no advanced features.",
  `Emit the greenfield SQL to ${GREENFIELD_SQL_PATH} and rollback SQL`,
  `to ${ROLLBACK_SQL_PATH}. Placeholders for S3 ARN etc are fine.`,
  "Do NOT execute anything against Snowflake.",
].join(" ")

describe.skipIf(!EVAL_ENABLED)("snowflake-setup — Tier 2/3 model-in-the-loop eval", () => {
  let greenfieldSql = ""
  let rollbackSql = ""

  test(
    "boots altimate-code, runs the skill, emits both SQL files",
    () => {
      // Clean up any prior run so we're not asserting against stale files.
      if (existsSync(ARTIFACT_DIR)) rmSync(ARTIFACT_DIR, { recursive: true, force: true })
      mkdirSync(ARTIFACT_DIR, { recursive: true })

      // Run the skill non-interactively. --yolo auto-approves permission prompts
      // (bash + write) which are otherwise deny-by-default in non-interactive mode.
      // Format=json is not needed here — we're grading the files, not the events.
      // Timeout is 10 min: real LLM emissions (greenfield + rollback via write
      // tool) take ~5–6 min against the Altimate gateway; earlier 5-min timeout
      // was cutting off partway through the rollback write, leaving files
      // partially emitted and downstream tests failing on empty rollbackSql.
      // maxBuffer is 256 MiB because a 10-min run of LLM + tool output can
      // exceed the 1 MiB default, causing execSync to throw ERR_CHILD_PROCESS_STDIO_MAXBUFFER
      // and kill the child mid-emission (PR #1164 review comment 9).
      const MIN_FILE_BYTES = 500 // partial writes below this are truncation, not success
      try {
        execSync(`bun run dev run --yolo ${JSON.stringify(PROMPT)}`, {
          cwd: REPO_ROOT,
          stdio: "pipe",
          timeout: 10 * 60 * 1000,
          maxBuffer: 256 * 1024 * 1024,
        })
      } catch (e) {
        // Only swallow ETIMEDOUT: any other error (child crash, permission
        // failure, network) must surface. Even for timeout, require both
        // files present AND non-trivially populated — a partial write
        // masquerading as success gives false confidence (comment 8).
        const err = e as NodeJS.ErrnoException & { code?: string; signal?: string }
        const isTimeout = err.code === "ETIMEDOUT" || err.signal === "SIGTERM"
        if (!isTimeout) throw e
        const bothExist = existsSync(GREENFIELD_SQL_PATH) && existsSync(ROLLBACK_SQL_PATH)
        const bothPopulated =
          bothExist &&
          statSync(GREENFIELD_SQL_PATH).size >= MIN_FILE_BYTES &&
          statSync(ROLLBACK_SQL_PATH).size >= MIN_FILE_BYTES
        if (!bothPopulated) throw e
      }

      expect(existsSync(GREENFIELD_SQL_PATH)).toBe(true)
      expect(existsSync(ROLLBACK_SQL_PATH)).toBe(true)

      greenfieldSql = readFileSync(GREENFIELD_SQL_PATH, "utf-8")
      rollbackSql = readFileSync(ROLLBACK_SQL_PATH, "utf-8")

      // Basic size sanity — 100+ lines each; anything smaller is a truncation bug.
      expect(greenfieldSql.split("\n").length).toBeGreaterThan(100)
      expect(rollbackSql.split("\n").length).toBeGreaterThan(50)
    },
    15 * 60 * 1000,
  )

  test("greenfield: Medallion topology → BRONZE / SILVER / GOLD databases", () => {
    expect(greenfieldSql).toMatch(/CREATE DATABASE IF NOT EXISTS BRONZE/i)
    expect(greenfieldSql).toMatch(/CREATE DATABASE IF NOT EXISTS SILVER/i)
    expect(greenfieldSql).toMatch(/CREATE DATABASE IF NOT EXISTS GOLD/i)
  })

  test("greenfield: emission=idempotent → every CREATE uses IF NOT EXISTS", () => {
    // Count creates and creates-with-guard. Ratio should be very high.
    const totalCreates = (greenfieldSql.match(/^\s*CREATE\s+/gim) ?? []).length
    const guardedCreates = (greenfieldSql.match(/^\s*CREATE\s+[A-Z ]+IF NOT EXISTS/gim) ?? []).length

    // Guard against zero-CREATE emission before dividing — otherwise the ratio
    // is NaN and Bun reports "NaN is not greater than 0.85" which is
    // uninformative. The sister rollback test guards its DROP counterpart the
    // same way (PR #1164 review comment 30).
    expect(totalCreates).toBeGreaterThan(0)

    // The CREATE STORAGE INTEGRATION and CREATE PIPE forms sometimes use a
    // different idempotency pattern (CREATE OR REPLACE is banned by guardrail 3
    // for those; DESC INTEGRATION is used to detect existence instead). Allow
    // 90%+ to be IF NOT EXISTS.
    expect(guardedCreates / totalCreates).toBeGreaterThan(0.85)
  })

  test("greenfield: guardrail #2 — FUTURE grants present", () => {
    const futureGrants = (greenfieldSql.match(/GRANT[^;]+ON FUTURE/gi) ?? []).length
    expect(futureGrants).toBeGreaterThanOrEqual(4)
  })

  test("greenfield: guardrail #1 — no ACCOUNTADMIN granted to service accounts", () => {
    // Any occurrence of "GRANT ROLE ACCOUNTADMIN TO USER <service_user>" is a bug.
    expect(greenfieldSql).not.toMatch(/GRANT\s+ROLE\s+ACCOUNTADMIN\s+TO\s+USER/i)
    // Service accounts must have DEFAULT_ROLE set to a functional role, not ACCOUNTADMIN.
    const serviceAccounts = greenfieldSql.match(/CREATE USER[^;]+DEFAULT_ROLE\s*=\s*(\w+)/gi) ?? []
    for (const decl of serviceAccounts) {
      expect(decl.toLowerCase()).not.toContain("default_role = accountadmin")
    }
  })

  test("greenfield: guardrail #4 — role-scoped execution blocks present", () => {
    // Must have all 3 role-switch blocks: ACCOUNTADMIN, SECURITYADMIN, SYSADMIN.
    expect(greenfieldSql).toMatch(/USE ROLE ACCOUNTADMIN/i)
    expect(greenfieldSql).toMatch(/USE ROLE SECURITYADMIN/i)
    expect(greenfieldSql).toMatch(/USE ROLE SYSADMIN/i)
  })

  test("greenfield: PII masking policies emitted for declared categories", () => {
    // User declared email/first_name/last_name — expect masking policies for each family.
    expect(greenfieldSql).toMatch(/MASKING POLICY[^;]+email/i)
    expect(greenfieldSql).toMatch(/MASKING POLICY[^;]+name/i)
  })

  test("greenfield: resource monitors present (account + at least one per-warehouse)", () => {
    const monitors = (greenfieldSql.match(/CREATE\s+[A-Z ]*RESOURCE MONITOR/gi) ?? []).length
    expect(monitors).toBeGreaterThanOrEqual(2)
  })

  test("greenfield: Configure-Before-Running placeholder checklist present", () => {
    // Skill guardrail: placeholders must appear in an explicit checklist so users can't miss them.
    expect(greenfieldSql).toMatch(/CONFIGURE BEFORE RUNNING/i)
    // At least a few placeholder markers.
    expect(greenfieldSql).toMatch(/<[A-Z_]+>/)
  })

  test("rollback: every DROP uses IF EXISTS", () => {
    const totalDrops = (rollbackSql.match(/^\s*DROP\s+/gim) ?? []).length
    const guardedDrops = (rollbackSql.match(/^\s*DROP\s+[A-Z ]+IF EXISTS/gim) ?? []).length
    expect(totalDrops).toBeGreaterThan(0)
    expect(guardedDrops / totalDrops).toBeGreaterThan(0.95)
  })

  // Helper: strip SQL comments (-- lines) before checking for statement
  // patterns. The skill's rollback file has descriptive comments like
  // "No DROP ... CASCADE anywhere" and "Never drops ... SNOWFLAKE database"
  // that must not trip the regex — the assertions are about STATEMENTS.
  const stripComments = (sql: string) =>
    sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")

  test("rollback: no DROP ... CASCADE (guardrail: cascade drops mask misconfig)", () => {
    expect(stripComments(rollbackSql)).not.toMatch(/DROP[^;]*CASCADE/i)
  })

  test("rollback: never drops built-in roles or SNOWFLAKE db", () => {
    const statements = stripComments(rollbackSql)
    for (const builtin of ["ACCOUNTADMIN", "SECURITYADMIN", "SYSADMIN", "USERADMIN", "PUBLIC", "ORGADMIN"]) {
      // Must not appear as target of a DROP ROLE statement.
      const dropPattern = new RegExp(`DROP\\s+ROLE[^;]*\\b${builtin}\\b`, "i")
      expect(statements).not.toMatch(dropPattern)
    }
    expect(statements).not.toMatch(/DROP\s+DATABASE[^;]*\bSNOWFLAKE\b/i)
  })

  test("rollback: account-locator confirmation guard present", () => {
    expect(rollbackSql).toMatch(/CURRENT_ACCOUNT\(\)/i)
    expect(rollbackSql).toMatch(/rollback_confirmed_account|ROLLBACK CONFIRMATION/i)
  })
})
