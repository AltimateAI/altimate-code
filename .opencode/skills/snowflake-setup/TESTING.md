# Testing the `snowflake-setup` skill

## Current state

| Tier | Status | Location |
|------|--------|----------|
| **Tier 1 — prompt contract** | ✅ Implemented (74 tests, ~1s, runs on every PR) | `packages/opencode/test/altimate/snowflake-setup-contract.test.ts` |
| **Tier 2/3 — model-in-the-loop eval** | ✅ Implemented (13 tests, ~90s, opt-in) | `packages/opencode/test/altimate/snowflake-setup-eval.test.ts` |
| **Tier 3 — live Snowflake apply/rollback cycle** | ✅ Executed 2026-08-25 + 2026-08-26 against `DKZPOBS-TQ14188` — see `LIVE-EVAL-RESULTS.md`. Not codified as a repeatable test (would need reusable operator credentials). | `test/altimate/fixtures/snowflake-setup/LIVE-EVAL-RESULTS.md` |

Run Tier 1 (always safe):
```bash
cd packages/opencode
bun test test/altimate/snowflake-setup-contract.test.ts
```

Run Tier 2/3 model-in-the-loop eval (requires Altimate LLM Gateway login, costs API credits):
```bash
cd packages/opencode
SNOWFLAKE_SETUP_EVAL=1 bun test test/altimate/snowflake-setup-eval.test.ts
```

The eval test boots real `altimate-code run --yolo`, feeds a scripted greenfield
scenario, captures the emitted SQL files, and grades them against SKILL.md's
non-negotiable guardrails. See §"Tier 2/3 as-implemented" below for details.

Golden reference files from a prior successful run:
- `packages/opencode/test/altimate/fixtures/snowflake-setup/greenfield-medallion.expected.sql`
- `packages/opencode/test/altimate/fixtures/snowflake-setup/rollback-medallion.expected.sql`

These are for human eyeballing when the eval starts failing — they are not
asserted verbatim (the LLM emits slightly different phrasing each run).

## What Tier 1 covers

Tier 1 is a **static analysis of the skill's markdown** — deterministic string / AST assertions that pin non-negotiable invariants. Whitespace-normalized so prose reflow doesn't break tests; substantive removal of a rule does.

Categories (74 assertions total):

1. Structural — frontmatter valid, name = `snowflake-setup`, all 10 reference files present
2. Tool references resolve — every `` `tool_name` `` mention matches a `Tool.define("<name>", ...)` under `src/altimate/tools/`
3. Reference file mentions resolve — every `` `references/*.md` `` mention exists on disk
4. No stale names — `snowflake_sql`, `finops_role_access`, `snowflake-greenfield-setup` never appear anywhere in the skill dir
5. Triage flow — mode / output-format / execution-control question options intact
6. Topology options — all 4 present (Medallion / Functional / Domain-per-DB / Data Vault 2.0), DV2 branches wired in plan sections 1/3/5
7. Emission modes — strict / idempotent (default) / additive present
8. Warehouse preflight — step 2b present with multi-warehouse prompt, `warehouse_test` smoke check, audit fail-fast
9. Guardrails — all 10 non-negotiable guardrails present
10. Rollback safety — `IF EXISTS` on drops, no CASCADE, built-in roles protected, account-locator confirmation guard, full CREATE OR REPLACE danger list of 8 object types
11. DV2 reference completeness — hub/link/satellite patterns, HASHDIFF, insert-only enforcement, 3 DV2 roles, PII placement decision
12. Audit queries — target `sql_execute` (not the hallucinated `snowflake_sql`), severity rubric, maturity formula

## What Tier 1 does NOT cover

- Whether emitted DDL is syntactically valid Snowflake SQL
- Whether the audit workflow actually finds real misconfigurations
- Whether Terraform HCL passes `terraform validate`
- Whether the skill loads and runs in the OpenCode session runtime
- Whether tool argument shapes match how the skill instructs the agent to invoke them (verified manually against Zod schemas in an earlier audit; NOT continuously enforced by a test)

Tiers 2 and 3 are designed to close those gaps.

---

## Tier 2/3 as-implemented (model-in-the-loop)

`snowflake-setup-eval.test.ts` boots the real `altimate-code run` subcommand
with `--yolo` (auto-approve permissions), feeds it the prompt below with all
14 skill answers pre-provided, and grades the two SQL files the skill emits.

**Prompt used (verbatim in the test file):**

> Invoke the snowflake-setup skill. Pre-answered triage: mode=greenfield,
> format=sql, execution=review-only. Detail answers: topology=Medallion,
> RBAC=small-team, envs=prod-only, ingestion=Snowpipe(AWS S3), cloud=AWS,
> emission=idempotent, budget=500 credits, PII discovery=declared with
> categories email/first_name/last_name, no multi-tenancy, no advanced
> features. Emit the greenfield SQL to eval-artifacts/greenfield.sql and
> rollback SQL to eval-artifacts/rollback.sql. Placeholders for S3 ARN etc
> are fine. Do NOT execute anything against Snowflake.

**Assertions (13, all shape-based, resilient to LLM phrasing drift):**

| # | Assertion |
|---|-----------|
| 1 | `bun run dev run --yolo` completes and emits both SQL files (>100 / >50 lines) |
| 2 | Greenfield: Medallion → BRONZE / SILVER / GOLD databases present |
| 3 | Greenfield: emission=idempotent → ≥85% of CREATE statements use IF NOT EXISTS |
| 4 | Greenfield: guardrail #2 — ≥4 FUTURE grants present |
| 5 | Greenfield: guardrail #1 — no ACCOUNTADMIN granted to service accounts; no service account has DEFAULT_ROLE=ACCOUNTADMIN |
| 6 | Greenfield: guardrail #4 — all 3 role-switch blocks present (ACCOUNTADMIN / SECURITYADMIN / SYSADMIN) |
| 7 | Greenfield: PII masking policies emitted for email and name |
| 8 | Greenfield: ≥2 resource monitor CREATE statements |
| 9 | Greenfield: "CONFIGURE BEFORE RUNNING" placeholder checklist present with `<PLACEHOLDER>` markers |
| 10 | Rollback: ≥95% of DROP statements use IF EXISTS |
| 11 | Rollback: no DROP ... CASCADE |
| 12 | Rollback: never drops built-in roles (ACCOUNTADMIN, SECURITYADMIN, SYSADMIN, USERADMIN, PUBLIC, ORGADMIN) or SNOWFLAKE database |
| 13 | Rollback: account-locator confirmation guard with CURRENT_ACCOUNT() check present |

**Cost per run:** ~120K input tokens + ~2–5K output tokens against the Altimate
LLM gateway. Not billed to the runner if using an Altimate-provided API key;
budget accordingly for CI.

**Runtime:** ~90 seconds cold; primary cost is LLM inference.

**Gating:** `SNOWFLAKE_SETUP_EVAL=1` env var. Without it, all 13 tests are
`describe.skipIf`'d — no LLM cost on regular CI runs.

**Known variance:** LLM emits slightly different phrasing, comments, and
non-essential SQL each run. Assertions match on shape and required primitives
(role switches, IF NOT EXISTS ratios, PII policy families) rather than exact
strings. First failure to investigate before assuming a regression: rerun and
check if the LLM produced substantively different output vs cosmetically
different.

**What it does NOT test:**
- Applying the emitted DDL to a real Snowflake account (see §"Tier 3 live
  apply — future work" below)
- Rollback correctness end-to-end (DDL → apply → rollback → verify blank)
- Audit mode against a broken account
- Terraform HCL emission or `terraform validate`
- External integrations (S3, SSO, DR, sharing, Cortex)
- Non-Medallion topologies (DV2, Functional, Domain-per-DB) — the eval script
  covers Medallion only; add more scenarios in follow-up PRs

---

## Tier 3 — Live Snowflake apply/rollback cycle (future work)

The remaining eval work is to actually **apply** the emitted DDL to a Snowflake
account, verify state, run the rollback, and verify the account returns to
blank. Everything below is designed but not implemented.

---

## Tier 2 — Original mocked-execution eval design (superseded by Tier 2/3 above)

> This section was the original Tier 2 design. It was superseded when
> the model-in-the-loop approach turned out to be feasible directly. Kept
> here for reference — the mock-harness approach may still be useful if a
> future team wants to run scenario coverage without LLM calls.

**Goal:** verify the skill's workflow logic — the decisions it makes given a scripted account state — without needing a live Snowflake account.

**Suggested location:** `packages/opencode/test/altimate/snowflake-setup-eval.test.ts`
**Fixture location:** `packages/opencode/test/altimate/fixtures/snowflake-setup/`
**Estimated build effort:** 2–3 days of focused work (this is the harness work, mostly)
**Estimated runtime once built:** ~30s per suite

### What has to be built first (blocking dependencies)

**1. Skill-invocation harness.**
No existing altimate-code test file drives a skill through its markdown Q&A flow with tool calls. Existing skill tests (`packages/opencode/test/skill/*.test.ts`) only verify skill *discovery* — did the loader see it, is the frontmatter valid, does the slash-command register? They do not simulate a user turn or capture tool invocations.

The harness needs to:
- Load a skill by name via the existing `Skill.defaultLayer`
- Accept a scripted `turnScript` — array of `{ userTurn: string, expectAsks: string[], provideAnswers: Record<string, string> }`
- Intercept every tool invocation the agent attempts
- Route interceptions through registered mocks
- Capture the final emitted output (SQL / HCL / plan markdown)
- Provide assertion helpers: `expectEmittedContains`, `expectRolePresent`, `expectDDLParsesAs`, `expectSectionOrder`

This is arguably its own PR — testable infrastructure for **every** skill, not just this one. That's a design conversation worth having with maintainers first (probably file a GH issue proposing the harness API before building it).

**2. Tool mocks.**
Each mock is a function matching the tool's Zod input schema and returning fixture data matching the tool's actual response shape. Faithful shapes are the entire game — a mock that returns "here are 3 warehouses" but with the wrong field names gives false confidence.

Tools that need mocks:

| Tool | Purpose in skill | Mock complexity |
|------|------------------|-----------------|
| `warehouse_list` | Preflight discovery | Low — array of connection records |
| `warehouse_add` | Never called in tests (fixture pre-supplies connections) | Low — no-op |
| `warehouse_discover` | Turn-1 auto-detect | Low — array of discovered accounts |
| `warehouse_test` | Preflight smoke check | Low — success/fail with message |
| `sql_execute` | Audit queries + guided-execute | **High** — must match query patterns and return realistic result shapes from `SNOWFLAKE.ACCOUNT_USAGE` |
| `finops_analyze_credits` | Audit § Cost | Medium — credit history object |
| `finops_role_hierarchy` | Audit § RBAC | Medium — role tree object |
| `finops_role_grants` | Audit § RBAC | Medium — grant list |
| `finops_user_roles` | Audit § RBAC | Low — user→roles map |
| `finops_warehouse_advice` | Hybrid sizing | Medium — sizing recommendation object |
| `schema_inspect` | Governance § column existence check | Medium — column metadata |
| `schema_detect_pii` | PII discovery | Medium — PII candidates with confidence |
| `altimate_core_classify_pii` | PII cross-check | Low — same shape as schema_detect_pii |

Highest risk is `sql_execute` — the skill emits many different query shapes and each needs its own mock branch. A pattern-matching approach (e.g. "if query contains `SHOW WAREHOUSES`, return warehouse fixture") is fragile; a query-parser-based dispatch is better but requires more upfront work.

**3. Fixture set.**
JSON files representing account state. Each scenario has its own directory:

```
fixtures/snowflake-setup/
├── blank/
│   ├── warehouses.json           # []
│   ├── roles.json                # only built-ins
│   ├── databases.json            # only SNOWFLAKE, SNOWFLAKE_SAMPLE_DATA
│   ├── resource_monitors.json    # []
│   └── ...
├── partially-configured/
│   ├── warehouses.json           # 2 warehouses, one without monitor
│   ├── roles.json                # some custom roles, 1 orphaned
│   └── ...
├── production-ready/
│   ├── warehouses.json           # 4 warehouses, all monitored
│   ├── roles.json                # full RBAC topology
│   └── ...
├── broken-with-7-issues/
│   ├── warehouses.json           # 3 warehouses, 1 no auto-suspend
│   ├── roles.json                # 2 orphaned, 3 users w/ DEFAULT_ROLE=ACCOUNTADMIN
│   ├── grants.json               # 4 schemas missing FUTURE
│   ├── users.json                # 2 service accounts w/ passwords
│   ├── policies.json             # 12 PII columns, no masking
│   ├── monitors.json             # []
│   └── ANSWER_KEY.md             # expected: 7 CRITICAL findings, maturity < 30
└── ...
```

Answer keys live **inside** each scenario dir so a directory-copy operation preserves the expected outcome with the input. Alternative: keep them **outside** the scanned dir (as PR #1092 does with `optimizer-project-answer-key.md`) so the skill can't accidentally read the answers during a test. Either is defensible — pick one and document it.

### Test scenarios

**Greenfield matrix (partial coverage of 36 combinations):**

| # | Topology | Emission | Format | Assertion |
|---|----------|----------|--------|-----------|
| G1 | Medallion | idempotent | sql | DDL emits BRONZE/SILVER/GOLD databases, warehouses sized per guide, RBAC per reference topology; `CREATE ... IF NOT EXISTS` used throughout; rollback file emitted alongside; matches golden file `G1.expected.sql` |
| G2 | Functional | strict | sql | plain `CREATE`, no `IF NOT EXISTS`; RAW/TRANSFORM/ANALYTICS databases |
| G3 | Domain-per-DB | idempotent | sql | `ANALYTICS_FINANCE`, `ANALYTICS_MARKETING`, `ANALYTICS_ENGINEERING` databases; per-domain roles |
| G4 | Data Vault 2.0 | idempotent | sql | `RAW_VAULT`, `BUSINESS_VAULT`, `INFO_MARTS` databases; hub/link/satellite schemas; `VAULT_LOADER_ROLE`, `BUSINESS_VAULT_BUILDER_ROLE`, `MART_BUILDER_ROLE`; insert-only `REVOKE UPDATE, DELETE` present |
| G5 | Medallion | idempotent | terraform | HCL emitted; `providers.tf` + `variables.tf` + resource files; `prevent_destroy = true` on prod databases; sensitive outputs marked |
| G6 | Medallion | idempotent | both | both `.sql` and `.tf` files emitted; content matches G1 + G5 |
| G7 | Medallion | additive (fixture: `partially-configured/`) | sql | DDL emits only for missing objects; existing 2 warehouses NOT recreated |

**Audit scenarios:**

| # | Fixture | Assertion |
|---|---------|-----------|
| A1 | `blank/` | 0 findings, maturity 100, "This looks like a new/empty account — did you mean greenfield?" nudge appears |
| A2 | `production-ready/` | 0 CRITICAL findings, maturity ≥ 90 |
| A3 | `broken-with-7-issues/` | ≥ 6/7 planted issues surfaced with correct severity; maturity ≤ 30; each finding maps to a remediation snippet from the correct reference file |
| A4 | `broken-with-7-issues/` | Fail-fast if `warehouse_list` returns no snowflake entry — no `sql_execute` is ever called |

**Hybrid scenarios:**

| # | Fixture | Assertion |
|---|---------|-----------|
| H1 | `partially-configured/` (has Medallion topology, 2 warehouses, no RBAC) | Detects Medallion topology; pre-fills Q1 answer; skips warehouse questions; asks only for missing RBAC and cost controls |
| H2 | `partially-configured/` with existing FUTURE grants | RBAC section detects them and doesn't re-emit; only missing grants emit |

**Rollback scenarios:**

| # | Setup | Assertion |
|---|-------|-----------|
| R1 | Apply G1 to `blank/` → capture state → run rollback | Post-rollback state matches `blank/` exactly (deep-equal) |
| R2 | Rollback against a mismatched account locator | Confirmation guard fires; no DROPs execute |
| R3 | Rollback where a task is running | `ALTER TASK ... SUSPEND` emitted before `DROP TASK` |

### Grading rubric

- **Snapshot-based** for emitted SQL/HCL: golden files in `fixtures/snowflake-setup/expected/`, regenerated with `UPDATE_SNAPSHOTS=1 bun test`
- **Assertion-based** for audit findings: match on `{ category, severity, remediation_ref }` tuples; order-independent
- **Deep-equal** for rollback state comparison

Regressions from any golden file fail the test. Non-substantive DDL reordering (like putting `ALTER USER` before `GRANT USAGE`) may false-positive — mitigate by canonicalizing statement order before comparison.

### Known false-negative modes

Mocked evals only test what the mocks return. Real failure modes NOT caught:

- Snowflake introducing a new column in `ACCOUNT_USAGE.WAREHOUSES` that breaks a query (the mock still returns the old shape)
- `sql_execute` in production requiring different permissions than mocked
- Terraform provider version incompatibility
- Actual query performance at scale

Tier 3 is the only way to catch these.

---

## Tier 3 live apply/rollback — full design (superseded intro; kept for reference)

**Goal:** end-to-end verification against a real Snowflake account.

**Suggested location:** `packages/opencode/test/altimate/snowflake-setup-live.test.ts`
**Gating:** `SNOWFLAKE_LIVE_EVAL=1` env var + credential env vars required
**Estimated build effort:** 1 day, after Tier 2 harness exists (Tier 3 reuses the harness)
**Estimated runtime:** 15–30 min per suite run
**Cost:** ~5–20 Snowflake credits per full run (rollback + audit cycles)

### Prerequisites

1. **A dedicated blank Snowflake account** — not a shared team account. Full teardown between runs.
2. **Credentials** set via env vars:
   - `SNOWFLAKE_ACCOUNT` — account locator
   - `SNOWFLAKE_USER` — user with ACCOUNTADMIN
   - `SNOWFLAKE_PRIVATE_KEY_PATH` — path to key-pair auth private key (never a password in CI)
   - `SNOWFLAKE_WAREHOUSE` — an already-existing warehouse to run the test queries from (typically `COMPUTE_WH`)
3. **Terraform** installed and on `PATH`
4. **`SNOWFLAKE_LIVE_EVAL=1`** set — the `describe.skipIf` gate

### Test flow

**Phase 1 — Preflight** (~ 30s)
- Register the test account via `warehouse_add`
- Call `warehouse_test` — must return success
- Verify account is genuinely blank (no user databases, no custom roles)
- Fail fast if any prior test state exists

**Phase 2 — Greenfield → verify → rollback cycle** (~ 10 min for one topology)

For each topology in [Medallion, Data Vault 2.0] (skip Functional and Domain-per-DB — same shape as Medallion; not worth the credits):

1. Invoke the skill with pre-scripted answers via the same harness Tier 2 uses
2. Skill emits DDL to a temp file
3. Test executes the DDL via `snowsql` CLI (or `sql_execute` in a loop with role switches)
4. Verify each expected object exists:
   - `SHOW DATABASES` — matches expected set
   - `SHOW WAREHOUSES` — matches expected set with sizes, auto_suspend
   - `SHOW ROLES` — matches expected topology
   - `SHOW GRANTS TO ROLE ANALYST_ROLE` — future grants present
   - `SHOW RESOURCE MONITORS` — account monitor + per-warehouse monitors
5. Execute the emitted rollback script
6. Verify account is back to genuinely blank state — same checks as Phase 1
7. If any step fails, run rollback anyway (as a defensive teardown) and fail the test

**Phase 3 — Audit against a broken state** (~ 5 min)

1. Apply a "known-broken" DDL script (planted with the 7 issues from Tier 2 fixture)
2. Run skill in audit mode
3. Assert same finding recall as Tier 2 test A3 (≥ 6/7 issues), but this time against real `ACCOUNT_USAGE` queries
4. Run rollback of the known-broken state

**Phase 4 — Terraform validate** (~ 2 min)

1. Invoke skill with `terraform` output format
2. Skill emits HCL files
3. Run `terraform init` on the emitted directory (requires network to Snowflake registry)
4. Run `terraform validate` — must pass
5. Run `terraform plan` against the blank account — must generate expected resource count
6. Optional: `terraform apply` for one topology if time permits

**Phase 5 — Teardown** (~ 30s)

1. Explicit `DROP` of every database, warehouse, role, and integration that could have been created
2. Verify blank state one more time

### Scope explicitly OUT

Live-eval Phase 2/3 verify the core lifecycle. Live-eval does NOT verify:

- Snowpipe / Task+COPY against a real S3 bucket — needs external infra (S3 + IAM)
- Fivetran / Airbyte — needs external accounts
- SSO federation (Okta, Azure AD, Google Workspace) — needs an IdP tenant
- SCIM provisioning — same
- Cross-region DR (replication / failover groups) — needs a **second** Snowflake account in a different region
- Data sharing to another account — needs a second account
- Cortex functions in production — accrues charges; may not be available in all regions

These paths remain "generated-but-runtime-unverified" and should be marked as such in the emitted plan header ("Note: this section covers configuration that has been unit-tested but not verified end-to-end against live infrastructure. Test manually against your own environment before production use.").

### CI wiring

Tier 3 should NOT run on every PR. Suggested:

- Nightly: run against a dedicated `altimate-code-snowflake-eval` test account
- On-demand: `gh workflow run snowflake-live-eval.yml` for a manual trigger
- Never on forks: gate via `if: github.repository == 'AltimateAI/altimate-code'`

Credentials via GitHub Actions Secrets (`SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PRIVATE_KEY_B64` decoded to a temp file at runtime).

---

## Priority for future work

If someone picks this up, sequence the work like this:

1. **Design + review the skill-invocation harness API first** (file a GH issue). This is the load-bearing dependency for both Tier 2 and Tier 3. Getting the harness API right unblocks eval work for every other skill in the repo too.
2. **Build the harness in a separate PR.** Get it reviewed and merged before Tier 2 depends on it.
3. **Build Tier 2 in a third PR** using the harness. Fixtures + mocks + graded scenarios.
4. **Build Tier 3 in a fourth PR** after acquiring a dedicated test account. Reuses the harness; adds live-connectivity plumbing.

Attempting all four in one PR is not recommended — the surface area is too large for effective review.

## Contact / provenance

- Tier 1 test pattern borrowed from PR #1092 (`optimizer-prompt-contract.test.ts`, dbt-optimizer agent).
- Original skill design + Tier 1 implementation: this PR.
- Tier 2 / Tier 3 designs: this doc; not implemented.
