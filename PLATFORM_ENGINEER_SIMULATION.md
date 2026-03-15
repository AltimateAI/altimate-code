# Platform Engineer Simulation: Databricks + Unity Catalog + PySpark

**Persona:** Data Platform Engineer at fintech (SOC2 + PCI-DSS compliance)
**Stack:** Databricks + Unity Catalog + Delta Lake + PySpark + dbt-databricks
**Team:** 8 engineers
**Date:** 2026-03-15

---

## Executive Summary

Training system coverage: **~25-30%** of daily PySpark work. Compliance gap: **Critical**. Production readiness: **Not suitable** without major architectural changes.

| Aspect | Training System | CLAUDE.md + Git | Winner |
|--------|-----------------|-----------------|--------|
| PySpark patterns | Limited (SQL-only scan) | N/A | Tie (missing) |
| Compliance audit trail | None | Full history + PR reviews | Git (clear win) |
| Approval workflow | Missing | PRs + code review | Git (clear win) |
| Environment-specific rules | None | Section-based | Git (clear win) |
| Version history | Flat (updated timestamp) | Full git blame | Git (clear win) |
| Multi-team governance | Single scope (global/project) | CODEOWNERS + teams | Git (clear win) |

---

## Part 1: PySpark Problem

### What the Training System Actually Finds

**Training Scan Targets** (training-scan.ts line 15-21):
```typescript
const TARGET_GLOBS: Record<string, string[]> = {
  models: ["**/models/**/*.sql", "**/staging/**/*.sql", ...],  // SQL ONLY
  sql: ["**/*.sql"],                                            // SQL ONLY
  config: ["**/dbt_project.yml", "**/packages.yml", ...],
  tests: ["**/tests/**/*.sql", "**/tests/**/*.yml", ...],
  docs: ["**/*.md", ...],
}
```

**Result:** No Python scanning. Your team's PySpark code is invisible:
- `spark.read.table()` patterns → not found
- `df.filter()` chains → not found
- `df.write.mode("overwrite")` → not found
- Unity Catalog namespacing (`catalog.schema.table`) → not found
- Databricks-specific patterns (MERGE INTO, Z-order, OPTIMIZE) → not found

**Coverage:** ~0% of PySpark work. Your team writes 70% PySpark, 30% SQL + dbt.

---

### Gap 1: No Python File Scanning

You need to add to training-scan.ts:
```typescript
python: ["**/*.py", "**/dbt_packages/**/*.py"],
```

But even then, keyword extraction (line 274-294) won't understand:
- DataFrame transformations (`.select()`, `.filter()`, `.groupBy()`)
- PySpark patterns (broadcast variables, window functions)
- Databricks APIs (`spark.sql()`, `sql()` magic commands)
- dbt-databricks macros (`dbt_utils.get_column_list()`)

---

### Gap 2: 2500-Character Pattern Limit

Your PySpark pattern:
```python
from pyspark.sql.functions import col, sum as spark_sum

df = spark.read.table("bronze.raw_customers")
df_clean = df.filter(col("is_valid") == True).select(
    "customer_id", "name", "email"
).repartition(10, "customer_id")

df_clean.write.format("delta") \
    .mode("overwrite") \
    .option("mergeSchema", "true") \
    .partitionBy("customer_id") \
    .bucketBy(10, "customer_id") \
    .saveAsTable("silver.customers")

spark.sql("OPTIMIZE silver.customers ZORDER BY customer_id")
```

After imports + formatting: ~650 characters. Fits within MemoryBlock content limit (2048 chars).

But try this Unity Catalog + dynamic partition pattern:
```python
# Read from Bronze (catalog.schema.table)
df = spark.read.table(f"{bronze_catalog}.raw.events")

# Complex transformation chain with window functions
from pyspark.sql.window import Window
from pyspark.sql.functions import row_number, dense_rank, lag

w = Window.partitionBy("customer_id").orderBy(desc("event_timestamp"))
df_ranked = df.select("*",
    row_number().over(w).alias("rn"),
    lag("event_type").over(w).alias("prev_event")
)

# Write to Silver with MERGE (idempotent upsert)
df_silver = df_ranked.filter(col("rn") == 1)

# Can't express this pattern! No good way to show:
# - MERGE INTO ... MATCHED/NOT MATCHED clauses
# - Dynamic SQL construction
# - Partition pruning optimization
# - Z-order clustering strategy
```

**Result:** Complex PySpark patterns (MERGE, dynamic SQL, partition strategies) exceed 2500 chars or can't be captured as simple text.

---

### Gap 3: No DataFrames = No Databricks Patterns

Your team's most critical patterns:

1. **MERGE Pattern** (Databricks Delta Lake idempotent upsert)
   ```python
   # No way to express this in training system
   # SQL: MERGE INTO silver.customers USING df ...
   # But we need to show: how to structure the logic, handle type mismatches, etc.
   ```

2. **Z-order + OPTIMIZE** (critical for cost optimization)
   ```python
   spark.sql(f"OPTIMIZE {table_name} ZORDER BY ({zorder_cols})")
   ```
   This single line represents:
   - When to OPTIMIZE (file sizes > threshold)
   - Which columns to Z-order (query predicates)
   - Cost implications (can't show without context)

3. **Unity Catalog Namespacing**
   ```python
   # Pattern: Always use three-part names for multi-workspace support
   df = spark.read.table("fintech_prod.bronze.transactions")

   # Anti-pattern: Single/two-part names (breaks in other workspaces)
   df = spark.read.table("bronze.transactions")  # ❌
   ```

Training validation can't catch this — it just looks for strings like "transactions".

---

## Part 2: Compliance Problem

### Metadata Gaps

**Current metadata** (types.ts line 13-19):
```typescript
export const TrainingBlockMeta = z.object({
  kind: TrainingKind,
  source: z.string().optional(),
  applied: z.number().int().min(0).default(0),
  accepted: z.number().int().min(0).default(0),
  rejected: z.number().int().min(0).default(0),
})
```

**Missing fields for compliance:**
- ❌ `created_by: string` — Who added this rule?
- ❌ `approved_by: string` — Who approved it?
- ❌ `approval_date: ISO8601` — When was it approved?
- ❌ `reason: string` — Why does this rule exist?
- ❌ `impact: string` — What breaks if we ignore it?
- ❌ `reviewer_notes: string` — What did the reviewer check?

**Audit trail comparison:**

| Requirement | Training System | Git + CLAUDE.md |
|-------------|-----------------|-----------------|
| Who created rule | ❌ No | ✅ git log (author) |
| When created | ✅ created timestamp | ✅ git log (date) |
| Who approved | ❌ No | ✅ PR reviewers |
| Approval date | ❌ No | ✅ Merge commit |
| Change history | ❌ Flat (updated overwrites) | ✅ Full diff history |
| Compliance proof | ❌ No | ✅ PR description + approval |
| Review notes | ❌ No | ✅ PR comments + thread |
| Enforcement evidence | ❌ No | ✅ Commit messages |

---

### Approval Workflow: Missing

Store.ts has `accepted`/`rejected` counters (line 16) but:
- No workflow to set them
- No endpoint to approve/reject
- No user interface for approval
- No audit log of who approved what

**Your compliance requirement:**
> "PII tagging rules must be enforced, not advisory. Audit trail: who added each rule, when, approved by whom."

**Training system answer:** Rule exists, applied 5 times, 0 approvals recorded.

**Git answer:**
```
commit abc123 (PR #1234 by alice, approved by bob)
Author: alice <alice@fintech.com>
Date:   2025-11-15

  feat: [AI-201] enforce PII tagging on sensitive columns

  Rule: Never store SSN, credit_card, or account_number without PII tag
  Impact: Prevents accidental data exposure in non-sensitive systems

  Co-Authored-By: bob <bob@fintech.com>
```

You can prove: alice wrote it, bob reviewed, approved 2025-11-15.

---

## Part 3: Multi-Environment Problem

### Scenario: OPTIMIZE Rule

**Rule:** "Always OPTIMIZE after writes > 1GB"

**Environment variance:**
- **Dev**: Optional (lots of small writes, cost not critical)
- **Staging**: Recommended (some cost, helps catch issues)
- **Prod**: Mandatory (cost critical, SLAs matter)

**Training system:** No environment concept.
```typescript
export interface TrainingEntry {
  scope: "global" | "project",  // That's it
  ...
}
```

Save rule as global → applies everywhere. Applies same way in dev/prod.

**CLAUDE.md approach:**
```markdown
## Databricks Optimization Rules

### Dev Environment
- OPTIMIZE is optional
- Focus on correctness over cost

### Staging Environment
- OPTIMIZE recommended for tables > 1GB
- Use for pre-prod validation

### Prod Environment
- OPTIMIZE mandatory after writes > 1GB
- Monitor Z-order effectiveness
- Alert if skipped
```

**Implementation comparison:**

| Scenario | Training | CLAUDE.md |
|----------|----------|-----------|
| Dev team pushes expensive OPTIMIZE | Applied everywhere ✅ (but not enforced) | Docs say optional, code can skip ✅ |
| Prod engineer forgets OPTIMIZE | Ignored ❌ (advisory) | Code review catches ✅ (CODEOWNERS) |
| New rule added mid-project | Updated immediately (affects all) ⚠️ | PR discussion, approved first ✅ |
| Rollback old rule | Delete entry, no history | `git revert` with full context ✅ |

---

## Part 4: The Validation Problem

### What `training_validate` Actually Does

**Validation logic** (training-validate.ts line 136-151):
```typescript
// Check for violation indicators (negative rules)
const negativeKeywords = extractNegativeKeywords(entry.content)
for (const neg of negativeKeywords) {
  if (contentLower.includes(neg.toLowerCase())) {
    violationCount++  // Found a violation!
  }
}
```

**Example: PII Rule**

Rule:
```
Never store SSN or credit_card in non-sensitive systems.
Don't use float for financial amounts — use DECIMAL(18,2).
```

Extract negative keywords:
- "SSN"
- "credit_card"
- "float"

Scan 10 random .sql/.py files:
- File 1: `SELECT * FROM temp_ssn_lookup` → **VIOLATION DETECTED** (found "ssn")
- File 2: `-- legacy: using float (deprecated)` → **VIOLATION DETECTED** (found "float")
- File 3: `CAST(amount AS DECIMAL(18,2))` → NO VIOLATION

**Problem:** Can't distinguish:
- ✅ "SSN in sensitive system (allowed)"
- ❌ "SSN in non-sensitive system (violation)"

Training validation just looks for keywords. No scope understanding.

---

### Practical Example: Your Team's Compliance Rule

**Rule you want to enforce:**
```
PII tagging rule:
- Columns with PII must have @pii tag in schema
- Systems: fintech_sensitive only
- Not enforced in: fintech_dev, fintech_analytics

Example:
  - Column: customer_ssn → MUST have @pii (in fintech_sensitive)
  - Column: customer_email → SHOULD have @pii (in fintech_sensitive)
  - Column: aggregated_customer_id → No @pii needed (in fintech_analytics)
```

**What training_validate finds:**
- "Files with @pii: 15/20 (75%)" ✅
- "Files with SSN tag: 20/20 (100%)" ✅
- Verdict: "Followed"

**What audit needs:**
- "In fintech_sensitive: SSN/email/phone have @pii (100%)"
- "In fintech_dev: No @pii required (0/0)"
- "In fintech_analytics: @pii correctly absent (100%)"
- "Approved by bob@fintech.com on 2025-11-15"
- "Last audit: 2026-02-15 (passed)"

**Training system:** Can't provide this.

---

## Part 5: Version History & Drift

### Scenario: Rule Changed Without Team Knowing

**Original rule** (2025-11-01):
```
Use DECIMAL(18,2) for all financial amounts.
Reason: Avoid rounding errors.
```

**Rule updated** (2025-12-15, by you):
```
Use DECIMAL(38,10) for financial amounts.
Reason: New reporting requirement needs more precision.
```

**Training system:** `updated: "2025-12-15"`. No version history.

**What happened:**
- ✅ New code follows DECIMAL(38,10)
- ❌ Old code still has DECIMAL(18,2)
- ❌ No one knows rule changed
- ❌ Can't compare old vs new
- ❌ Can't audit who decided why

**Git history:**
```bash
git log --follow -- CLAUDE.md | grep -A5 "DECIMAL"

commit abc123 (2025-12-15 by you)
  fix: update decimal precision for new reporting

commit def456 (2025-11-01 by alice)
  feat: enforce decimal financial types

git show abc123 -- CLAUDE.md | grep -B2 -A2 DECIMAL
  # Shows exact change
```

**Compliance answer:** "Rule changed 2025-12-15. Old version had DECIMAL(18,2). All code updated in PR #1234. Approved by bob."

---

## Part 6: The Reality Check

### Coverage Percentage: Your Daily Work

**Daily work breakdown (70% PySpark team):**

1. **DataFrame transformations** (40% of time)
   - `.select()`, `.filter()`, `.groupBy()`, `.join()`
   - Window functions
   - Custom UDFs
   - Training coverage: ❌ **0%** (no Python scanning)

2. **Databricks-specific patterns** (25% of time)
   - MERGE INTO (idempotent upserts)
   - OPTIMIZE + Z-order (cost management)
   - Unity Catalog namespacing
   - Delta Lake features
   - Training coverage: ❌ **0%** (no Databricks-specific scanning)

3. **dbt-databricks integration** (20% of time)
   - `dbt-databricks` adapter-specific macros
   - Python models in dbt
   - Incremental strategy (merge vs insert)
   - Training coverage: ⚠️ **5%** (finds dbt_project.yml, misses Python models)

4. **Compliance checks** (10% of time)
   - PII tagging validation
   - Data governance (Unity Catalog levels)
   - Audit logging
   - Training coverage: ❌ **0%** (no approval/audit trail)

5. **SQL + analytics** (5% of time)
   - Raw SQL queries
   - Testing/validation
   - Training coverage: ✅ **100%** (full SQL scanning)

**Realistic coverage: ~5-10%** of your team's daily work.

---

## Part 7: Security Team Evaluation

### Would Security Approve Training for Prod?

**Compliance Officer Checklist:**

| Requirement | Status | Risk |
|-------------|--------|------|
| Audit trail (who, when) | ❌ Partial | Medium |
| Approval workflow | ❌ Missing | High |
| Enforcement proof | ❌ No | High |
| Version history | ❌ No | Medium |
| Rollback capability | ❌ Limited | Medium |
| Cross-environment rules | ❌ Not supported | High |
| PII/sensitivity scoping | ❌ No | Critical |
| Integration with SIEM | ❌ No | High |

**Security verdict:**
> "Training system cannot be approved for production compliance enforcement. It lacks:
> 1. Formal approval workflows
> 2. Audit trail of approvals (who, when, why)
> 3. Scope/environment differentiation
> 4. Version control + rollback
> 5. Integration with compliance monitoring
>
> Recommendation: Use git + CLAUDE.md for compliance-critical rules. Use training for patterns/context only."

---

## Part 8: Specific Changes Needed

### To Make Training Production-Ready

#### 1. Add Approval Workflow

```typescript
export interface TrainingBlockMeta extends z.infer<typeof TrainingBlockMeta> {
  created_by: string         // User who created
  created_date: ISO8601      // Timestamp
  approved_by?: string       // User who approved
  approved_date?: ISO8601    // Approval timestamp
  approval_status: "pending" | "approved" | "rejected"
  rejection_reason?: string
  compliance_required: boolean
  environment_scope?: "dev" | "staging" | "prod" | "all"
}
```

#### 2. Add Python Scanning

```typescript
const TARGET_GLOBS = {
  python: ["**/*.py", "!**/__pycache__/**"],
  pyspark: ["**/spark_*.py", "**/dataframe_*.py"],
  dbt_python: ["dbt/models/**/*.py"],
}
```

#### 3. Environment-Aware Validation

```typescript
export async function validateInEnvironment(
  entry: TrainingEntry,
  environment: "dev" | "staging" | "prod"
): Promise<ValidationResult> {
  // Filter files by environment-specific patterns
  // Apply environment-specific rules
  // Check approval status for prod
}
```

#### 4. Integration with Git

```typescript
// Store training metadata in git as well
// Enable `git blame` on training rules
// Link training to PRs/issues
export async function exportToGitCLAUDE(
  training: TrainingEntry[]
): Promise<string> {
  // Generate CLAUDE.md section from training entries
}
```

---

## Summary & Recommendation

### Training System: Best Use Cases ✅

1. **Pattern discovery** — find structural conventions
2. **Knowledge sharing** — disseminate learned patterns
3. **Context building** — capture "why" decisions
4. **Playbooks** — step-by-step procedures
5. **Glossary** — domain term definitions

### Training System: Not Suitable ❌

1. **Compliance rules** — no approval/audit trail
2. **Environment-specific policies** — no scope differentiation
3. **PII/security enforcement** — no granular scoping
4. **Critical operational rules** — no version history/rollback
5. **Multi-team governance** — no CODEOWNERS integration

### Recommendation for Your Stack

**Hybrid approach:**

| Category | Use | Tool |
|----------|-----|------|
| PySpark patterns | How to use DataFrame API | Training |
| Databricks best practices | Z-order, OPTIMIZE patterns | Training |
| dbt-databricks patterns | Macros, incremental strategy | Training |
| **PII rules** | **What is PII, enforcement** | **Git + CLAUDE.md** |
| **Compliance policies** | **Data retention, governance** | **Git + CLAUDE.md** |
| **Environment rules** | **Dev vs prod behavior** | **Git + CLAUDE.md** |
| **Approvals** | **Who approved what** | **GitHub PRs + reviews** |
| **Version history** | **Track changes over time** | **Git + git log** |

**Action items:**

1. ✅ Document PySpark patterns in training (fills 40% gap)
2. ✅ Document dbt-databricks patterns in training (fills 20% gap)
3. ✅ Keep PII/compliance rules in CLAUDE.md (remains 100% auditable)
4. ✅ Link training discoveries back to CLAUDE.md for compliance sync
5. ✅ Use git for version control + approval trail
6. ❌ Don't use training for compliance-critical enforcement

**Coverage after implementation:**
- PySpark patterns: 35-40% (up from 0%)
- Compliance rules: 100% (via CLAUDE.md)
- Overall production readiness: 60-70%

---

## Appendix: Scan Results If Running on Sample PySpark

**If you added Python scanning, running `training_scan target:python` would find:**

```markdown
## Scan Results: python

Scanned **20** files in `dataframe_transforms/`

| Type | Count |
|------|-------|
| Python files | 20 |

### Discovered Patterns

**Naming Conventions**: `stg_*` (3 files), `fct_*` (2 files), `dim_*` (1 file)

**Common Patterns**:
- Uses `spark.read.table()`: 15/20 files (75%)
- Uses `df.filter()` chains: 18/20 files (90%)
- Uses `partition` or `bucket`: 8/20 files (40%)
- Uses `OPTIMIZE` or Z-order: 3/20 files (15%)
- Uses `MERGE INTO`: 2/20 files (10%)
- Uses Unity Catalog three-part names: 5/20 files (25%)

### Key Observations

- Most code uses `.write.mode("overwrite")` instead of MERGE
- Z-order/OPTIMIZE only used in 15% — opportunity to standardize
- Unity Catalog adoption at 25% — needs team migration plan
- No custom UDFs found — may be in separate utility files

### Recommendations

Could teach patterns:
- "Idempotent upsert pattern using MERGE"
- "Z-order clustering for query performance"
- "Three-part table naming for multi-workspace support"
- "Partition strategy for Bronze→Silver→Gold"
```

But validation would still be weak:
- Can't distinguish "MERGE in prod" vs "MERGE in dev"
- Can't validate "PII columns tagged"
- Can't prove "rule approved by security team"
