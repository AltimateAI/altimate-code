/**
 * Tier 1 prompt-contract tests for the `snowflake-setup` skill.
 *
 * Pattern borrowed from PR #1092 (`optimizer-prompt-contract.test.ts`):
 * deterministic, whitespace-normalized assertions that pin the skill's
 * non-negotiable invariants. Reflow of SKILL.md text does not break these
 * tests; substantive removal of a rule does.
 *
 * See `.opencode/skills/snowflake-setup/TESTING.md` for Tier 2 (mocked-execution
 * eval) and Tier 3 (live Snowflake eval) designs — those are not implemented
 * yet and this file does not stub them.
 *
 * What this file catches:
 *   - Frontmatter drift (name renamed, description dropped)
 *   - Tool references to nonexistent tools (a class of bug this skill has hit
 *     multiple times: `snowflake_sql`, `finops_role_access`, misuse of
 *     `altimate_core_export_ddl` as if it queried a live warehouse)
 *   - Reference files renamed or deleted without updating SKILL.md
 *   - Guardrails silently removed
 *   - Triage / topology / emission-mode options silently changed
 *   - Rollback safety rules watered down
 *   - Data-Vault-2 branches missing when topology mentions DV2
 *
 * What this file does NOT catch:
 *   - Whether emitted DDL is syntactically valid Snowflake SQL
 *   - Whether the audit workflow actually finds real misconfigurations
 *   - Whether Terraform HCL passes `terraform validate`
 *   - Whether the skill loads in the OpenCode session runtime
 *
 * Those live in Tier 2 (mocked) and Tier 3 (live). See TESTING.md.
 */

import { describe, test, expect } from "bun:test"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const SKILL_DIR = join(import.meta.dir, "../../../../.opencode/skills/snowflake-setup")
const SKILL_MD_PATH = join(SKILL_DIR, "SKILL.md")
const REFERENCES_DIR = join(SKILL_DIR, "references")
const TOOLS_DIR = join(import.meta.dir, "../../src/altimate/tools")

// Read once; every assertion re-reads from the same string so tests are hermetic.
const SKILL_MD = readFileSync(SKILL_MD_PATH, "utf-8")

// Whitespace-normalize helper — reflow of prose must not break invariants.
const norm = (s: string) => s.replace(/\s+/g, " ").trim()
const containsNorm = (haystack: string, needle: string) =>
  norm(haystack).toLowerCase().includes(norm(needle).toLowerCase())

// --- Section 1: Structural invariants -----------------------------------------

describe("snowflake-setup — structural invariants", () => {
  test("SKILL.md exists and is non-empty", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true)
    expect(SKILL_MD.length).toBeGreaterThan(1000)
  })

  test("frontmatter opens with --- fence and declares name: snowflake-setup", () => {
    const firstLines = SKILL_MD.split("\n").slice(0, 6).join("\n")
    expect(firstLines.startsWith("---\n")).toBe(true)
    expect(firstLines).toMatch(/^name:\s*snowflake-setup\s*$/m)
  })

  test("frontmatter has a description", () => {
    const firstLines = SKILL_MD.split("\n").slice(0, 6).join("\n")
    expect(firstLines).toMatch(/^description:\s*.+\S/m)
  })

  test("frontmatter description is under 500 chars (loader constraint)", () => {
    const match = SKILL_MD.match(/^description:\s*(.+)$/m)
    expect(match).not.toBeNull()
    expect(match![1].length).toBeLessThan(500)
  })

  test("references/ directory exists and contains all 10 reference files", () => {
    expect(existsSync(REFERENCES_DIR)).toBe(true)
    const files = readdirSync(REFERENCES_DIR).filter((f) => f.endsWith(".md")).sort()
    expect(files).toEqual([
      "advanced-features.md",
      "audit-queries.md",
      "cost-governance.md",
      "data-vault-patterns.md",
      "governance-patterns.md",
      "idempotency-patterns.md",
      "ingestion-patterns.md",
      "rbac-patterns.md",
      "terraform-mapping.md",
      "topology-patterns.md",
    ])
  })
})

// --- Section 2: Every referenced tool must exist ------------------------------

describe("snowflake-setup — tool references resolve", () => {
  // Extract every `tool_name` mention from SKILL.md that matches the altimate
  // tool naming convention: snake_case, prefixed with a known family.
  const toolRefs = new Set<string>()
  const rx = /`((?:warehouse|sql|altimate_core|schema|finops)_[a-z_]+)`/g
  let m: RegExpExecArray | null
  while ((m = rx.exec(SKILL_MD)) !== null) {
    // Filter out obvious argument names that share the naming style but aren't
    // tools (e.g. `schema_path`, `schema_context` are Zod field names).
    const name = m[1]
    if (["schema_path", "schema_context", "schema_name", "sql_execute_write"].includes(name)) continue
    toolRefs.add(name)
  }

  test("SKILL.md mentions at least 10 tools (sanity check on the extractor)", () => {
    expect(toolRefs.size).toBeGreaterThanOrEqual(10)
  })

  // Build the set of all tools defined in src/altimate/tools/*.ts by scanning
  // for `Tool.define("<name>", ...)`.
  const definedTools = new Set<string>()
  for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(TOOLS_DIR, file), "utf-8")
    const defRx = /Tool\.define\(\s*["']([a-z_]+)["']/g
    let dm: RegExpExecArray | null
    while ((dm = defRx.exec(src)) !== null) {
      definedTools.add(dm[1])
    }
  }

  for (const toolName of toolRefs) {
    test(`tool \`${toolName}\` mentioned in SKILL.md must exist in src/altimate/tools/`, () => {
      expect(definedTools.has(toolName)).toBe(true)
    })
  }
})

// --- Section 3: Every referenced markdown file must exist ---------------------

describe("snowflake-setup — reference file mentions resolve", () => {
  // Extract every `references/*.md` mention from SKILL.md.
  const refMentions = new Set<string>()
  const rx = /`references\/([a-z\-]+\.md)`/g
  let m: RegExpExecArray | null
  while ((m = rx.exec(SKILL_MD)) !== null) refMentions.add(m[1])

  test("SKILL.md mentions at least 6 reference files (sanity)", () => {
    expect(refMentions.size).toBeGreaterThanOrEqual(6)
  })

  for (const ref of refMentions) {
    test(`references/${ref} mentioned in SKILL.md must exist on disk`, () => {
      expect(existsSync(join(REFERENCES_DIR, ref))).toBe(true)
    })
  }
})

// --- Section 4: No stale tool names anywhere in the skill ---------------------

describe("snowflake-setup — no stale tool names", () => {
  // These names have appeared in earlier drafts of the skill and must never
  // reappear. Each is either a hallucinated name or a name that was renamed
  // during the tool-schema audit.
  const staleNames = ["snowflake_sql", "finops_role_access"]

  const allSkillContent = [
    SKILL_MD,
    ...readdirSync(REFERENCES_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(REFERENCES_DIR, f), "utf-8")),
  ].join("\n")

  for (const stale of staleNames) {
    test(`no reference to stale tool name \`${stale}\` anywhere in skill`, () => {
      expect(allSkillContent.includes(stale)).toBe(false)
    })
  }

  test("no reference to old skill directory name `snowflake-greenfield-setup`", () => {
    expect(allSkillContent.includes("snowflake-greenfield-setup")).toBe(false)
  })
})

// --- Section 5: Triage flow invariants ----------------------------------------

describe("snowflake-setup — triage flow", () => {
  test("mode question offers greenfield, audit, and hybrid", () => {
    expect(containsNorm(SKILL_MD, "greenfield")).toBe(true)
    expect(containsNorm(SKILL_MD, "audit")).toBe(true)
    expect(containsNorm(SKILL_MD, "hybrid")).toBe(true)
  })

  test("output-format question offers sql, terraform, and both", () => {
    // These appear as literal option labels in the triage batch.
    expect(SKILL_MD).toMatch(/`sql`.*(default)/is)
    expect(SKILL_MD).toMatch(/`terraform`/)
    expect(SKILL_MD).toMatch(/`both`/)
  })

  test("execution-control question offers all 4 modes", () => {
    for (const mode of ["review-only", "guided-execute", "dbt-integrate", "terraform-apply"]) {
      expect(SKILL_MD.includes(`\`${mode}\``)).toBe(true)
    }
  })
})

// --- Section 6: Topology options -----------------------------------------------

describe("snowflake-setup — topology options", () => {
  const requiredTopologies = ["Medallion", "Functional", "Domain-per-Database", "Data Vault 2.0"]

  for (const topo of requiredTopologies) {
    test(`topology question offers ${topo}`, () => {
      expect(SKILL_MD.includes(topo)).toBe(true)
    })
  }

  test("SKILL.md branches on data-vault-2 in plan sections (DV2-specific behavior wired)", () => {
    // Sections 1, 3, 5 must have explicit DV2 branches. Look for the
    // fingerprint used consistently: "If topology = `data-vault-2`".
    const branches = SKILL_MD.match(/If topology = `data-vault-2`/gi) ?? []
    expect(branches.length).toBeGreaterThanOrEqual(3)
  })

  test("DV2 detail-question batch present in step 4b", () => {
    // Detail questions should be gated on the DV2 answer.
    expect(containsNorm(SKILL_MD, "Data Vault 2.0 detail questions")).toBe(true)
    expect(containsNorm(SKILL_MD, "AutomateDV")).toBe(true) // recommended package
  })
})

// --- Section 7: Emission modes -------------------------------------------------

describe("snowflake-setup — emission modes", () => {
  test("emission-mode question offers strict, idempotent (default), and additive", () => {
    expect(SKILL_MD).toMatch(/`strict`/)
    expect(SKILL_MD).toMatch(/`idempotent`[^\n]*default/i)
    expect(SKILL_MD).toMatch(/`additive`/)
  })
})

// --- Section 8: Warehouse preflight -------------------------------------------

describe("snowflake-setup — warehouse preflight (step 2b)", () => {
  test("preflight step exists and uses warehouse_list", () => {
    // Skill must NOT fire sql_execute blind — it must go through warehouse_list
    // first. This is the guardrail introduced after the audit-mode fail-fast
    // rule.
    expect(SKILL_MD).toMatch(/warehouse_list/)
    expect(SKILL_MD).toMatch(/warehouse preflight/i)
  })

  test("multi-warehouse case: user must be prompted to pick, no auto-select", () => {
    expect(SKILL_MD).toMatch(/multiple.*Snowflake warehouses/i)
    expect(containsNorm(SKILL_MD, "prompt the user to pick")).toBe(true)
    expect(containsNorm(SKILL_MD, "never guess or auto-select")).toBe(true)
  })

  test("preflight includes warehouse_test smoke check", () => {
    expect(SKILL_MD).toMatch(/warehouse_test/)
  })

  test("preflight fails fast for audit mode (no silent fallback)", () => {
    expect(containsNorm(SKILL_MD, "Fail fast for `audit` mode")).toBe(true)
  })
})

// --- Section 9: Guardrails -----------------------------------------------------

describe("snowflake-setup — guardrails", () => {
  // The 10 non-negotiable guardrails at the bottom of SKILL.md.
  // Each test pins one of them, whitespace-normalized so light rewording still
  // passes but substantive removal fails.
  const guardrails: Array<[string, string]> = [
    ["no ACCOUNTADMIN to service accounts", "No ACCOUNTADMIN to service accounts"],
    ["always include FUTURE grants", "Always include FUTURE grants"],
    ["never CREATE OR REPLACE for stateful objects", "Never `CREATE OR REPLACE`"],
    ["storage integration requires ACCOUNTADMIN + manual IAM", "Storage integration DDL requires ACCOUNTADMIN"],
    ["prefer key-pair auth over passwords", "Prefer key-pair auth over passwords"],
    ["rollback never drops built-in roles", "Never drop built-in roles"],
    ["audit mode requires live connection", "Audit mode requires a live connection"],
    ["PII discovery is advisory", "PII discovery results are advisory"],
    ["rollback scripts are gated by confirmation", "Rollback scripts are gated"],
    ["Terraform state must not contain secrets", "Terraform state must not contain secrets"],
  ]

  for (const [label, needle] of guardrails) {
    test(`guardrail: ${label}`, () => {
      expect(containsNorm(SKILL_MD, needle)).toBe(true)
    })
  }
})

// --- Section 10: Rollback safety (in idempotency-patterns.md) ------------------

describe("snowflake-setup — rollback safety rules", () => {
  const idempotency = readFileSync(join(REFERENCES_DIR, "idempotency-patterns.md"), "utf-8")

  test("rollback uses IF EXISTS on every DROP", () => {
    expect(containsNorm(idempotency, "Use `IF EXISTS` on every `DROP`")).toBe(true)
  })

  test("rollback never emits DROP ... CASCADE", () => {
    expect(containsNorm(idempotency, "Never emit `DROP ... CASCADE`")).toBe(true)
  })

  test("rollback never drops built-in roles", () => {
    expect(containsNorm(idempotency, "PUBLIC")).toBe(true)
    expect(containsNorm(idempotency, "ACCOUNTADMIN")).toBe(true)
  })

  test("rollback includes account-locator confirmation guard", () => {
    expect(containsNorm(idempotency, "ROLLBACK CONFIRMATION")).toBe(true)
    expect(containsNorm(idempotency, "CURRENT_ACCOUNT()")).toBe(true)
  })

  test("danger list for CREATE OR REPLACE is intact (all 8 object types)", () => {
    for (const obj of [
      "WAREHOUSE",
      "ROLE",
      "USER",
      "DATABASE",
      "SCHEMA",
      "TABLE",
      "STORAGE INTEGRATION",
      "PIPE",
      "RESOURCE MONITOR",
    ]) {
      expect(idempotency.includes(obj)).toBe(true)
    }
  })
})

// --- Section 11: DV2 reference completeness -----------------------------------

describe("snowflake-setup — data-vault-patterns.md completeness", () => {
  const dv2 = readFileSync(join(REFERENCES_DIR, "data-vault-patterns.md"), "utf-8")

  test("hub / link / satellite patterns all present", () => {
    expect(dv2.includes("## Hub Pattern")).toBe(true)
    expect(dv2.includes("## Link Pattern")).toBe(true)
    expect(dv2.includes("## Satellite Pattern")).toBe(true)
  })

  test("HASHDIFF pattern documented (critical: prevents linear satellite growth)", () => {
    expect(containsNorm(dv2, "HASHDIFF")).toBe(true)
  })

  test("insert-only enforcement documented (REVOKE UPDATE, DELETE)", () => {
    expect(dv2).toMatch(/REVOKE\s+UPDATE,?\s+DELETE/i)
  })

  test("three DV2 roles present", () => {
    for (const role of ["VAULT_LOADER_ROLE", "BUSINESS_VAULT_BUILDER_ROLE", "MART_BUILDER_ROLE"]) {
      expect(dv2.includes(role)).toBe(true)
    }
  })

  test("PII placement decision (three options) documented", () => {
    expect(containsNorm(dv2, "PII placement")).toBe(true)
    // Three named options
    expect(containsNorm(dv2, "RAW_VAULT satellites")).toBe(true)
    expect(containsNorm(dv2, "BUSINESS_VAULT")).toBe(true)
    expect(containsNorm(dv2, "hybrid")).toBe(true)
  })
})

// --- Section 11.1: ACCOUNT_USAGE lag cross-check (found by live eval) --------

describe("snowflake-setup — ACCOUNT_USAGE lag cross-check", () => {
  const audit = readFileSync(join(REFERENCES_DIR, "audit-queries.md"), "utf-8")

  test("audit-queries.md documents ACCOUNT_USAGE replication lag", () => {
    expect(containsNorm(audit, "45 minutes to 2 hours")).toBe(true)
  })

  test("audit-queries.md provides SHOW-command cross-check mapping", () => {
    expect(containsNorm(audit, "Real-time `SHOW` equivalent")).toBe(true)
    // A few of the specific entries in the mapping table.
    expect(audit).toMatch(/SHOW DATABASES/i)
    expect(audit).toMatch(/SHOW ROLES/i)
    expect(audit).toMatch(/SHOW USERS/i)
    expect(audit).toMatch(/SHOW WAREHOUSES/i)
  })

  test("audit-queries.md tells the skill to treat SHOW as authoritative on mismatch", () => {
    expect(containsNorm(audit, "treat the `SHOW` result as authoritative")).toBe(true)
  })
})

// --- Section 11.2: Terraform HCL schemas match v0.100.0 (found by live eval) --

describe("snowflake-setup — Terraform HCL schemas", () => {
  const tf = readFileSync(join(REFERENCES_DIR, "terraform-mapping.md"), "utf-8")

  test("snowflake_masking_policy uses `argument` block, not `signature { column }`", () => {
    // Extract each snowflake_masking_policy resource block and verify.
    const blocks = tf.match(/resource\s+"snowflake_masking_policy"[\s\S]+?\n\}/g) ?? []
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(block).toMatch(/argument\s*\{/)
      expect(block).not.toMatch(/signature\s*\{\s*column/)
    }
  })

  test("snowflake_masking_policy uses `body`, not `masking_expression`", () => {
    const blocks = tf.match(/resource\s+"snowflake_masking_policy"[\s\S]+?\n\}/g) ?? []
    for (const block of blocks) {
      expect(block).toMatch(/\bbody\s*=/)
      expect(block).not.toMatch(/masking_expression\s*=/)
    }
  })

  test("snowflake_row_access_policy uses `argument` and `body`", () => {
    const blocks = tf.match(/resource\s+"snowflake_row_access_policy"[\s\S]+?\n\}/g) ?? []
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(block).toMatch(/argument\s*\{/)
      expect(block).toMatch(/\bbody\s*=/)
      expect(block).not.toMatch(/row_access_expression\s*=/)
      expect(block).not.toMatch(/signature\s*=\s*\{/)
    }
  })

  test("snowflake_resource_monitor does not use `warehouses` or `set_for_account`", () => {
    const blocks = tf.match(/resource\s+"snowflake_resource_monitor"[\s\S]+?\n\}/g) ?? []
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(block).not.toMatch(/\bwarehouses\s*=/)
      expect(block).not.toMatch(/\bset_for_account\s*=/)
    }
  })

  test("account-level monitor is attached via snowflake_execute (not snowflake_account_parameter)", () => {
    // Finding 5b (2026-08-26): snowflake_account_parameter rejects
    // key="RESOURCE_MONITOR". Must use snowflake_execute with ALTER ACCOUNT.
    // Look for a `resource "snowflake_execute" "..."` block containing ALTER ACCOUNT SET RESOURCE_MONITOR.
    const executeBlocks = tf.match(/resource\s+"snowflake_execute"[\s\S]+?\n\}/g) ?? []
    const anyAttachesMonitor = executeBlocks.some((b) =>
      b.match(/ALTER ACCOUNT SET RESOURCE_MONITOR/)
    )
    expect(anyAttachesMonitor).toBe(true)

    // Must NOT define a snowflake_account_parameter resource with RESOURCE_MONITOR value.
    const acctParamBlocks = tf.match(/resource\s+"snowflake_account_parameter"[\s\S]+?\n\}/g) ?? []
    const anyUsesRM = acctParamBlocks.some((b) => b.match(/["']RESOURCE_MONITOR["']/))
    expect(anyUsesRM).toBe(false)
  })

  test("per-warehouse monitor is attached via snowflake_warehouse.resource_monitor", () => {
    // The warehouse resource block must have a `resource_monitor` attribute.
    const whBlocks = tf.match(/resource\s+"snowflake_warehouse"[\s\S]+?\n\}/g) ?? []
    const anyHasMonitor = whBlocks.some((b) => b.match(/\bresource_monitor\s*=/))
    expect(anyHasMonitor).toBe(true)
  })
})

// --- Section 11.3: conditional validation queries (found by live eval) --------

describe("snowflake-setup — validation queries conditional on emission", () => {
  test("SKILL.md rule: validation queries only for sections actually emitted", () => {
    expect(containsNorm(SKILL_MD, "validation queries must only reference objects the emitted DDL actually creates")).toBe(true)
    // Must call out the placeholder-skip case explicitly.
    expect(containsNorm(SKILL_MD, "placeholders the user did not fill in")).toBe(true)
  })
})

// --- Section 11.4: split-rollback rule (found by 2026-08-25 live eval) --------

describe("snowflake-setup — rollback split (tool-safe + manual)", () => {
  const idempotency = readFileSync(join(REFERENCES_DIR, "idempotency-patterns.md"), "utf-8")

  test("idempotency-patterns.md documents the two-file split", () => {
    expect(idempotency).toMatch(/rollback-tool-safe\.sql/)
    expect(idempotency).toMatch(/rollback-manual\.sql/)
  })

  test("dependency order marks schemas + databases as MANUAL", () => {
    // Steps 7 (Schemas) and 8 (Databases) must be tagged so the emitter
    // routes them into the manual file, not the tool-safe file.
    expect(idempotency).toMatch(/Schemas\s+\[MANUAL/)
    expect(idempotency).toMatch(/Databases\s+\[MANUAL/)
  })

  test("SKILL.md warns about DROP DATABASE / DROP SCHEMA / TRUNCATE tool guard", () => {
    // Both must be mentioned somewhere — the guided-execute description AND
    // the rollback plan section. Assertion is loose on exact wording so light
    // rewording is fine; disappearance of the warning fails the test.
    expect(SKILL_MD.match(/DROP DATABASE.*DROP SCHEMA.*TRUNCATE/i)).not.toBeNull()
    expect(containsNorm(SKILL_MD, "non-bypassable")).toBe(true)
  })

  test("SKILL.md rollback plan section 13 describes the split", () => {
    expect(containsNorm(SKILL_MD, "rollback-tool-safe.sql")).toBe(true)
    expect(containsNorm(SKILL_MD, "rollback-manual.sql")).toBe(true)
  })
})

// --- Section 11.5: GRANT emission rule (found by 2026-08-25 live eval) --------

describe("snowflake-setup — GRANT emission rule (single-role only)", () => {
  const rbac = readFileSync(join(REFERENCES_DIR, "rbac-patterns.md"), "utf-8")

  test("rbac-patterns.md includes the one-role-per-GRANT rule verbatim", () => {
    expect(containsNorm(rbac, "Always emit one target role per GRANT statement")).toBe(true)
    expect(containsNorm(rbac, "Never comma-separate roles")).toBe(true)
  })

  test("SKILL.md guardrail 11 explicitly bans comma-separated GRANT roles", () => {
    expect(containsNorm(SKILL_MD, "One role per GRANT statement")).toBe(true)
    expect(containsNorm(SKILL_MD, "never comma-separate roles")).toBe(true)
  })

  test("rbac-patterns.md has no example of comma-separated grant target roles", () => {
    // Only check lines that look like SQL statements (start with GRANT/REVOKE after optional whitespace)
    // and end with a semicolon — this rules out prose that quotes GRANT wording.
    const lines = rbac.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.match(/^\s*(GRANT|REVOKE)\s.+TO ROLE\b.+;$/)) continue
      // Skip counter-examples marked with WRONG / DO NOT EMIT within 2 lines above.
      const prevLine = i > 0 ? lines[i - 1] : ""
      const prev2Line = i > 1 ? lines[i - 2] : ""
      if (prevLine.match(/WRONG|DO NOT EMIT/i) || prev2Line.match(/WRONG|DO NOT EMIT/i)) continue
      // Any remaining SQL statement must NOT have a comma between TO ROLE and the semicolon.
      const afterToRole = line.split(/TO ROLE\b/i)[1] ?? ""
      const beforeSemicolon = afterToRole.split(";")[0]
      expect(beforeSemicolon.includes(",")).toBe(false)
    }
  })
})

// --- Section 12: audit-queries.md targets sql_execute, not snowflake_sql ------

describe("snowflake-setup — audit-queries.md tool reference", () => {
  const audit = readFileSync(join(REFERENCES_DIR, "audit-queries.md"), "utf-8")

  test("audit queries run via sql_execute (not the hallucinated snowflake_sql)", () => {
    expect(audit).toMatch(/sql_execute/)
    expect(audit.includes("snowflake_sql")).toBe(false)
  })

  test("severity rubric with three levels present", () => {
    expect(audit).toMatch(/CRITICAL/)
    expect(audit).toMatch(/WARNING/)
    expect(audit).toMatch(/INFO/)
  })

  test("maturity score formula documented", () => {
    expect(containsNorm(audit, "100 – (CRITICAL × 10)")).toBe(true)
  })
})
