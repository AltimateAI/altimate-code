# Training Your AI Teammate

altimate-code can learn your team's patterns, rules, terminology, and standards — then apply them consistently across every session. Training persists to disk, gets committed to git, and is shared with your team automatically.

## Why Train?

Without training, altimate-code is a capable but generic data engineering agent. With training, it becomes **your team's agent** — one that knows your naming conventions, understands your business terms, follows your SQL style guide, and avoids mistakes your team has already learned from.

| Without Training | With Training |
|---|---|
| Uses generic SQL patterns | Follows your CTE conventions |
| Guesses at column naming | Uses your `_at`/`_id`/`is_` conventions |
| Doesn't know business terms | Knows ARR, churn, NRR definitions |
| Can't enforce team standards | Checks your PR review checklist |
| Repeats mistakes you've corrected | Remembers corrections permanently |

## Training Kinds

Six types of knowledge you can teach:

| Kind | Purpose | Example |
|---|---|---|
| **pattern** | How code should look | "Staging models use source CTE → filtered → final" |
| **rule** | Hard constraints | "Never use FLOAT for money — use DECIMAL(18,2)" |
| **glossary** | Business terms | "ARR = Annual Recurring Revenue = MRR * 12" |
| **standard** | Team conventions | "Every PR needs tests, schema YAML, and docs" |
| **context** | Background knowledge | "We chose Snowflake because of RBAC support" |
| **playbook** | Step-by-step procedures | "When costs spike: check query history, identify warehouse, kill runaway queries" |

## Quick Start

### Option 1: Trainer Mode (Recommended for first-time setup)

Switch to trainer mode for systematic knowledge building:

```bash
altimate --agent trainer
```

```
You: Scan my dbt project for patterns

Trainer:
> training_scan target:models
  Scanned 24 files in models/

  Discovered Patterns:
  - Naming Conventions: `stg_*` (12 files), `int_*` (5 files), `fct_*` (4 files), `dim_*` (3 files)
  - Common Patterns:
    - Uses CTEs: 22/24 files (92%)
    - Uses {{ source() }} macro: 12/24 files (50%)
    - Has dbt config block: 20/24 files (83%)

  Suggested Next Steps:
  Review the patterns above and tell me which ones to save.

You: Save the naming convention and CTE pattern

Trainer: I'll save two patterns:

  1. pattern/model-naming — "Staging: stg_{source}__{entity}, Intermediate: int_{entity}__{verb},
     Facts: fct_{entity}, Dimensions: dim_{entity}"
  2. pattern/cte-structure — "All models use CTEs: source → transformed → final. No nested subqueries."

  Saved pattern "model-naming" to project training.
  Saved pattern "cte-structure" to project training.
  Training usage: 380/6000 chars (6% full).
```

### Option 2: Inline Corrections (During normal work)

In any mode, correct the agent and it offers to remember:

```
You: Create a staging model for raw_payments

Builder: [creates model using FLOAT for amount column]

You: No — never use FLOAT for money. Use DECIMAL(18,2).

Builder: Got it, switching to DECIMAL(18,2).

  Want me to remember this as a rule for future sessions?

You: Yes

Builder: Saved rule "no-float-financial" to project training.
  This will be shared with your team when committed to git.
```

### Option 3: Learn from Documentation

Use the `/train` skill to extract rules from existing docs:

```
You: /train @docs/sql-style-guide.md

Agent: I found 12 actionable rules in your style guide. Here are the top ones:

  1. rule/lowercase-keywords — "SQL keywords in lowercase (select, from, where)"
  2. rule/explicit-column-list — "Never use SELECT *, always list columns"
  3. standard/cte-naming — "CTEs named as verb_noun: filtered_orders, joined_payments"
  ...

  Save all 12? Or let me show you each one first?
```

---

## Trainer Mode — Deep Dive

Trainer mode is a dedicated, read-only agent mode designed for systematic knowledge building. It cannot modify your project files — it can only read, scan, validate, and manage training entries.

```bash
altimate --agent trainer
```

### When to Use Trainer Mode

| Scenario | Use Trainer Mode |
|---|---|
| Setting up a new project | Scan codebase, extract patterns, build knowledge base |
| Onboarding a new team member | Walk through existing conventions with the agent |
| After a production incident | Save the lesson as a rule so it's never repeated |
| Quarterly training review | Validate entries against code, remove stale, consolidate |
| Loading a style guide | Extract rules and standards from documentation |
| Before a migration | Document current warehouse patterns as context |

### Trainer Workflows

#### 1. Pattern Discovery

Scan your codebase to automatically find conventions worth teaching:

```
You: Scan my models for patterns

Trainer:
> training_scan target:models
  Scanned 20 files...

  Discovered Patterns:
  - Naming: `stg_*` (8 files), `fct_*` (6 files), `dim_*` (4 files)
  - Common: CTEs in 95% of files, {{ source() }} in 40%, incremental in 25%
  - Config: materialized='table' in 60%, materialized='view' in 25%

You: The naming convention is important — save it

Trainer: Saving as pattern. Let me draft the content:

  pattern/dbt-model-naming:
  "Model naming convention:
  - Staging: stg_{source}__{entity} (e.g., stg_stripe__payments)
  - Intermediate: int_{entity}__{verb} (e.g., int_orders__pivoted)
  - Facts: fct_{entity} (e.g., fct_orders)
  - Dimensions: dim_{entity} (e.g., dim_customers)
  Double underscore separates source from entity in staging."

  Save this? [The content above will be shown to you for approval]
```

#### 2. Training Validation

Check whether your training rules are actually followed in the codebase:

```
You: Validate my training

Trainer:
> training_validate

  ## Training Validation Report

  ### Followed (4)
  - rule/no-select-star: 0 violations in 10 files sampled
  - pattern/cte-structure: Relevant in 9/10 files (90%)
  - standard/yaml-descriptions: Relevant in 8/10 files (80%)
  - glossary/arr: Referenced in 3 doc files

  ### Violated (1)
  - rule/no-float-financial: 2 of 10 files may violate
    - models/legacy/old_revenue.sql
    - models/staging/stg_payments_v1.sql

  ### Stale (1)
  - standard/old-review-checklist: No matching files found

  ### Recommendations
  - Review 1 violated entry — fix the code or update the rule
  - Remove 1 stale entry that no longer matches the codebase
```

#### 3. Guided Teaching

Tell the agent what you want it to learn, and it helps you formalize it:

```
You: I want you to know that our fiscal year starts February 1

Trainer: Good context. Let me save this properly:

  Kind: context (background knowledge, not a rule)
  Name: fiscal-year-offset
  Content: "Fiscal year starts February 1, not January 1. All _fiscal_quarter
  and _fiscal_year columns use this offset. The date spine model handles this,
  but any hardcoded date logic must account for the Feb 1 start."

  Scope: project (so the whole team benefits)

  Save this?
```

#### 4. Gap Analysis

Ask the trainer what it doesn't know yet:

```
You: What gaps do I have in my training?

Trainer:
> training_list

  You have 8 entries across 3 kinds:
  - 3 patterns (model naming, CTE structure, incremental template)
  - 4 rules (no-float, no-select-star, always-test-pks, lowercase-sql)
  - 1 glossary (ARR)

  Gaps I notice:
  - **No standards**: You have rules but no team conventions (PR checklist, doc requirements)
  - **No context**: I don't know why you chose Snowflake, or how your data flows
  - **No playbooks**: No procedures for incidents, deployments, or migrations
  - **Glossary is thin**: Only 1 term — most teams have 10-20 key business terms
  - **No column naming standard**: You enforce no-float but I don't know your naming conventions

  Want me to scan your codebase to fill some of these gaps?
```

---

## How Training Is Applied

When you start a session, altimate-code automatically injects your training into the system prompt. Every agent mode (builder, analyst, validator, etc.) sees the same training.

### Priority Order

Training is injected in this order (most actionable first):

1. **Rules** — hard constraints, always included first
2. **Patterns** — coding examples, included next
3. **Standards** — team conventions
4. **Glossary** — term definitions
5. **Context** — background knowledge
6. **Playbooks** — multi-step procedures (first to be dropped if budget is tight)

Within each kind, entries are sorted by **applied count** — most-used entries get priority. This means your most valuable training always fits.

### Budget

Training has a 6,000-character context budget. This fits roughly:

- 20 short rules (~100 chars each) = ~2,000 chars
- 10 patterns (~200 chars each) = ~2,000 chars
- 10 glossary terms (~100 chars each) = ~1,000 chars
- A few standards and context entries = ~1,000 chars

When budget is exceeded, least-applied entries are dropped first. The `training_list` tool shows your current budget usage.

### Applied Count

Every time training is injected into a session, each entry's "applied" counter increments. This creates a natural quality signal:

- **High applied count** (5+) = This entry is regularly used — it's working
- **Zero applied count after 7+ days** = This entry may be stale — review it
- **Near the 20-entry limit** = Time to consolidate related entries

---

## Scenarios

### Scenario 1: New Project Onboarding

Your team just started using altimate-code. You want to teach it your conventions.

**Step 1:** Start in trainer mode and scan the codebase:
```
altimate --agent trainer
> Scan my dbt project for patterns
```

**Step 2:** Review discoveries and save the important ones.

**Step 3:** Load your style guide:
```
> /train @docs/sql-style-guide.md
```

**Step 4:** Add business glossary:
```
> Save these glossary terms:
  - ARR: Annual Recurring Revenue = MRR * 12
  - NRR: Net Revenue Retention = (Start MRR + Expansion - Contraction - Churn) / Start MRR
  - Churn: Customer whose subscription is cancelled 30+ days with no reactivation
```

**Step 5:** Add critical context:
```
> Save as context: We use Snowflake with a star schema. Staging models are 1:1 with sources.
  Intermediate models do joins and filtering. Marts are business-facing aggregates.
  Fiscal year starts February 1.
```

**Step 6:** Validate everything:
```
> Validate my training
```

**Step 7:** Commit the training to git so your team gets it:
```bash
git add .altimate-code/memory/
git commit -m "feat: add AI teammate training for dbt conventions"
```

### Scenario 2: Post-Incident Learning

A production incident occurred because someone used `FLOAT` for a monetary column, causing a $47K reconciliation error.

```
You: Save this as a rule: Never use FLOAT or DOUBLE for financial columns.
     Use DECIMAL(18,2) for amounts, DECIMAL(18,4) for rates.
     This caused a $47K reconciliation error in Q3 2025 from rounding.

Trainer: Saving as rule/no-float-financial to project scope.
  Source: "production incident Q3 2025"

  Saved. This will be shared with your team when committed.
  Training usage: 280/6000 chars (4% full).
```

Now every time the builder creates a model with money columns, it will use DECIMAL — and cite why.

### Scenario 3: Quarterly Training Review

Every quarter, audit your training to keep it current:

```
altimate --agent trainer

You: Review my training quality

Trainer:
> training_validate
  ...
  Followed: 12 entries
  Violated: 2 entries (legacy code not yet updated)
  Stale: 3 entries (no relevant code found)

> training_list
  ...
  Insights:
  ! 3 entries saved 30+ days ago but never applied
  - 2 high-value entries (applied 15+ times)
  - rule entries at 18/20 — consider consolidating

  Recommendations:
  1. Remove 3 stale entries: old-review-checklist, deprecated-macro-style, v1-naming
  2. Consolidate 5 related SQL rules into one "sql-safety-rules" entry
  3. Update 2 violated entries to match current code

You: Do it — remove the stale ones and consolidate the SQL rules
```

### Scenario 4: Teaching Business Domain Knowledge

Your new data engineer doesn't know the business terms:

```
altimate --agent trainer

You: Let me teach you our key metrics

Trainer: Great — I'll save each as a glossary entry. Tell me the terms.

You: - ARR: Annual Recurring Revenue = MRR * 12, includes only active subscriptions
     - MRR: Monthly Recurring Revenue, recognized on billing date not payment date
     - NRR: Net Revenue Retention = (Start + Expansion - Contraction - Churn) / Start
     - DAU/MAU: Daily/Monthly Active Users ratio, target > 0.4
     - Qualified Lead: Completed demo + confirmed budget + timeline within 90 days

Trainer: Saved 5 glossary entries to project scope.
  Training usage: 780/6000 chars (13% full).

  Now when the analyst mode encounters these terms in queries or dashboards,
  it will use these exact definitions.
```

### Scenario 5: Documenting Migration Context

Before migrating from Redshift to Snowflake, capture institutional knowledge:

```
altimate --agent trainer

You: Save context about our current Redshift setup before we migrate

Trainer: I'll ask some questions to capture the key context:

  1. Why are you migrating?
  2. What Redshift-specific features do you rely on? (DISTKEY, SORTKEY, etc.)
  3. Are there any known pain points in the current setup?
  4. What's the timeline?

You: We're migrating because Redshift can't handle our semi-structured JSON data
     natively. We use DISTKEY on customer_id for most tables and SORTKEY on
     created_at. Timeline is Q2 2026. Main pain point is the lack of
     lateral flatten for nested arrays.

Trainer: Saving as two entries:

  context/redshift-to-snowflake-migration:
  "Migrating from Redshift to Snowflake in Q2 2026. Primary driver: Snowflake's
  native semi-structured (VARIANT) and LATERAL FLATTEN support. Current Redshift
  uses DISTKEY(customer_id) and SORTKEY(created_at) on most tables — these have
  no direct Snowflake equivalent but can be replaced with clustering keys."

  playbook/migration-checklist:
  "Redshift to Snowflake migration steps:
  1. Audit all DISTKEY/SORTKEY usage — map to clustering keys where beneficial
  2. Identify JSON processing queries — convert to LATERAL FLATTEN
  3. Test data type mappings (Redshift BIGINT → Snowflake NUMBER, etc.)
  4. Dual-write for 2 weeks comparing outputs
  5. Cut over BI layer last"

  Save both?
```

---

## Limitations

### What Training Can Do

- Persist patterns, rules, glossary, standards, context, and playbooks across sessions
- Be applied automatically by all agent modes
- Be shared with your team via git
- Track effectiveness via applied counts
- Self-improve via stale detection and consolidation insights

### What Training Cannot Do

- **It cannot enforce rules at build time.** Training is injected as guidance in the system prompt — the LLM will follow it most of the time, but it's not a hard technical gate. Critical rules should also be enforced via linting (SQL Fluff), dbt tests, or CI checks.

- **It has a 6,000-character budget.** At scale (60+ entries), some entries will be silently excluded from the prompt. The system prioritizes rules and high-applied entries, but you may need to consolidate aggressively.

- **It does not learn automatically.** Unlike tools that auto-extract patterns from usage, altimate-code training is explicit. You (or the trainer mode) must save entries manually. Inline corrections are offered as save opportunities, but require confirmation.

- **Validation is heuristic, not semantic.** The `training_validate` tool uses keyword matching and structural analysis — it cannot deeply understand whether code semantically follows a pattern. Use it as a screening tool, not a definitive audit.

- **No conflict resolution across scopes.** If you have a global rule that conflicts with a project rule, the system doesn't detect or resolve the conflict. You must manage this manually.

- **No version history.** Updating a training entry overwrites the previous version. If you need to revert, you must recover from git history.

- **Context and playbook entries are not validated.** Only pattern, rule, standard, and glossary entries can be checked against the codebase. Context and playbook entries are purely informational.

### Limits

| Limit | Value |
|---|---|
| Max entries per kind | 20 |
| Max content per entry | 2,500 characters |
| Total context budget | 6,000 characters |
| Training kinds | 6 (pattern, rule, glossary, standard, context, playbook) |
| Scopes | 2 (global = personal, project = team-shared) |

---

## Training Tools Reference

| Tool | Purpose | Available In |
|---|---|---|
| `training_save` | Save a new entry or update an existing one | All modes |
| `training_list` | List entries with applied counts, budget, and insights | All modes |
| `training_remove` | Remove an entry | All modes |
| `training_scan` | Auto-discover patterns in codebase | Trainer mode |
| `training_validate` | Check training compliance against code | Trainer mode |

## Training Skills Reference

| Skill | Purpose |
|---|---|
| `/teach` | Learn a pattern from an example file |
| `/train` | Extract rules and standards from a document |
| `/training-status` | View training dashboard with insights |

## Feature Flag

Training can be disabled entirely:

```bash
export ALTIMATE_DISABLE_TRAINING=true
```

This removes all training tools from the tool registry and skips training injection in session prompts. Memory (a separate system) is unaffected.
