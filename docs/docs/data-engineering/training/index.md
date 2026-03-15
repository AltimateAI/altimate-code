# Customizing Your AI Teammate

altimate-code ships as a data engineering harness — specialized for SQL, dbt, and cloud warehouses. But every team's stack, conventions, and domain knowledge are different. Training is how you customize the harness for **your** project.

## Why Training Exists

Most users don't know what to tell an AI coding assistant. Research shows that when writing instructions manually, people omit **40-70% of the critical knowledge** the agent actually needs. The result: the agent makes mistakes, the user gets frustrated, and both waste time.

Training flips the dynamic. Instead of you writing a perfect instruction file, **the agent works with you to discover what it needs to know**:

- The agent scans your codebase and asks: "I see these patterns — are they conventions I should follow?"
- You correct the agent, and it asks: "Want me to remember this for next time?"
- You point the agent at your style guide, and it extracts the actionable rules

This is collaborative knowledge building — like onboarding a new teammate through conversations, not by handing them a manual.

| Static Instructions (CLAUDE.md) | Training (Agent-Guided) |
|---|---|
| You must anticipate what the agent needs | Agent identifies its own knowledge gaps |
| Blank canvas — where do you start? | Guided discovery — agent asks the right questions |
| One-time effort, drifts over time | Evolves through corrections and validation |
| You write, agent reads | Agent proposes, you confirm |
| Generic — same instructions for all tasks | Contextual — different knowledge for different situations |

Training doesn't replace CLAUDE.md — it complements it. Use CLAUDE.md for broad project instructions. Use training to teach domain-specific knowledge that the agent discovers it needs through working with you.

## What You Can Teach

Six types of knowledge, each serving a different purpose:

| Kind | What It Captures | Example |
|---|---|---|
| **pattern** | How code should look | "Staging models use source CTE -> filtered -> final" |
| **rule** | Hard constraints | "Never use FLOAT for money — use DECIMAL(18,2)" |
| **glossary** | Business terms | "ARR = Annual Recurring Revenue = MRR * 12" |
| **standard** | Team conventions | "Every PR needs tests, schema YAML, and docs" |
| **context** | Background knowledge | "We chose Snowflake because of RBAC support" |
| **playbook** | Step-by-step procedures | "When costs spike: check query history, identify warehouse, kill runaway queries" |

## Quick Start

### Option 1: Let the Agent Discover (Recommended)

Switch to trainer mode and let the agent scan your project:

```bash
altimate --agent trainer
```

```
You: Scan my dbt project for patterns

Trainer:
> training_scan target:models
  Scanned 24 files in models/

  Discovered Patterns:
  - Naming: stg_* (12 files), fct_* (6 files), dim_* (4 files)
  - Common: CTEs in 92%, {{ source() }} in 50%, incremental in 25%

  I noticed your staging models consistently use a CTE pattern:
  source -> filtered -> final. Should I save this as a convention?

You: Yes, and also save the naming convention

Trainer: Saved 2 patterns. Now I'll follow these in builder mode.
```

### Option 2: Correct as You Go

In any mode, corrections become learning moments:

```
You: Create a staging model for raw_payments

Builder: [creates model using FLOAT for amount column]

You: No — never use FLOAT for money. Use DECIMAL(18,2).

Builder: Got it. Want me to remember this as a rule?

You: Yes

Builder: Saved rule "no-float-financial". I'll apply this in every future session.
```

### Option 3: Load from Documentation

Point the agent at your existing docs:

```
You: /train @docs/sql-style-guide.md

Agent: I found 12 actionable rules. Here are the top ones:
  1. SQL keywords in lowercase
  2. Never use SELECT *, always list columns
  3. CTEs named as verb_noun: filtered_orders, joined_payments
  ...
  Save all 12?
```

---

## Trainer Mode

Trainer mode is a dedicated agent for systematic knowledge building. It can't modify your code — it only reads, scans, validates, and manages training.

```bash
altimate --agent trainer
```

### When to Use Trainer Mode

| Scenario | What Happens |
|---|---|
| **New project setup** | Agent scans codebase, discovers conventions, you confirm what to keep |
| **New team member** | Walk through existing training, agent explains each entry with examples |
| **After an incident** | Save the lesson as a rule so it's never repeated |
| **Quarterly review** | Validate training against code, remove stale entries, fill gaps |
| **Loading a style guide** | Agent extracts rules and standards from your docs |
| **Before a migration** | Document current patterns as context for the migrator agent |

### Trainer Workflows

**Pattern Discovery** — Agent scans your codebase:
```
You: Scan my models for patterns

Trainer:
> training_scan target:models
  Found: stg_* naming (12 files), CTE pattern (92%), incremental (25%)

  I see 3 potential conventions. Want me to walk through each one?
```

**Training Validation** — Agent checks if training matches reality:
```
You: Validate my training

Trainer:
> training_validate
  Followed: 4 entries (code matches)
  Violated: 1 entry (2 files use FLOAT for amounts)
  Stale: 1 entry (no relevant code found)

  Recommendations:
  - Fix the 2 FLOAT violations, or update the rule
  - Remove the stale entry
```

**Gap Analysis** — Agent identifies what it doesn't know:
```
You: What don't you know about my project?

Trainer: I have 8 entries. Gaps I see:
  - No glossary terms (I don't know your business metrics)
  - No context (I don't know why you chose this warehouse)
  - No playbooks (no incident response procedures)

  Want me to scan your docs for glossary terms?
```

---

## Real-World Scenarios

### Scenario 1: "The Agent Keeps Getting Our Naming Wrong"

The agent creates `fact_orders` but your team uses `fct_orders`. You correct it once:

```
You: We use fct_ not fact_ for fact tables

Builder: Got it. Want me to remember this?

You: Yes
```

Next session, the agent knows. You taught it **in the moment you noticed the problem** — not because you remembered to update a config file later.

### Scenario 2: "New Hire Doesn't Know Our Conventions"

A new analytics engineer joins. They start trainer mode:

```
altimate --agent trainer

New hire: What do I need to know about this project?

Trainer: Let me scan the codebase and your existing training...

  Your team has taught me 15 things:
  - 4 naming conventions (stg_, int_, fct_, dim_)
  - 3 SQL rules (no FLOAT, no SELECT *, always test PKs)
  - 5 glossary terms (ARR, NRR, churn, ...)
  - 3 context items (why Snowflake, fiscal year offset, ...)

  Want me to walk through any of these?
```

The new hire doesn't need to know what to ask — the agent already knows what it knows.

### Scenario 3: "Why Does the Agent Fail on Our Incremental Models?"

The agent writes incremental models wrong — missing your team's dedup pattern. Instead of figuring out what to put in CLAUDE.md, you show it an example:

```
You: /teach @models/staging/stg_orders.sql — this is how we do incremental models

Trainer: I see the pattern:
  - ROW_NUMBER dedup on _loaded_at
  - Filter source to >= max(_loaded_at) from target
  - Unique key on composite [id, _loaded_at]

  Save as pattern "incremental-dedup"?
```

The agent extracted the pattern from your actual code. You didn't have to write it from scratch.

### Scenario 4: "Our Data Has Quirks the Agent Can't Discover from Code"

Your Salesforce connector delivers duplicate records during API pagination resets. The agent can't discover this from code alone — it's tribal knowledge.

```
You: Save as context: The Salesforce connector occasionally delivers duplicates
     during API pagination resets. All Salesforce staging models MUST include
     deduplication logic.

Trainer: Saved context "salesforce-dedup-requirement".
```

Now every time the builder creates a Salesforce staging model, it knows to add dedup — because you taught it something it could never learn from code.

### Scenario 5: "Customizing for Our Stack (Databricks)"

You're a Databricks shop. The default harness assumes generic SQL. Teach it your stack:

```
altimate --agent trainer

You: Let me teach you about our Databricks setup

Trainer: I'll ask questions to understand your stack:
  1. Which catalog/schema structure?
  2. Delta Lake merge patterns?
  3. Optimization conventions?

You: Three-level namespace: dev.analytics.*, staging.analytics.*, prod.analytics.*
     MERGE INTO for all incremental loads in gold layer.
     Z-order on customer_id and date_month for fact tables.

Trainer: Saving 3 entries:
  - context/databricks-namespace
  - pattern/delta-merge-incremental
  - standard/z-order-convention
```

You've customized the harness for your specific deployment — something no generic template could do.

### Scenario 6: "Cost Spike — Teaching the Agent the Lesson"

Your Snowflake bill spiked because someone ran SELECT * on a 2B-row table without a partition filter.

```
You: Save as playbook: When investigating cost spikes:
     1. Run finops_analyze_credits for last 7 days
     2. Identify top 5 expensive queries via finops_expensive_queries
     3. Check git log for recent model changes
     4. Correlate: did a deployment remove a partition filter?
     5. If runaway query found, check if LIMIT or date filter is missing

Trainer: Saved playbook "cost-spike-investigation".
  The researcher and analyst agents will follow this procedure
  when investigating cost anomalies.
```

---

## How Training Differs from CLAUDE.md

Both are useful. They serve different purposes:

| | CLAUDE.md | Training |
|---|---|---|
| **Best for** | Broad project instructions | Domain-specific knowledge the agent needs |
| **Who writes it** | You, manually | Agent proposes, you confirm |
| **Discovery** | You must know what to write | Agent scans code and asks questions |
| **Corrections** | Edit file, commit, remember to do it | "Want me to remember this?" — done |
| **Format** | Free-form markdown | Structured (kind, name, content, citations) |
| **Maintenance** | Manual review | Agent detects stale entries and suggests cleanup |
| **Sharing** | In git, always loaded | In git, injected into agent context |

**Use CLAUDE.md when:** You know exactly what to tell the agent and want broad instructions that apply everywhere.

**Use training when:** You want the agent to help you figure out what it needs to know, or you want to capture corrections as they happen.

---

## Limitations

### What Training Is

- A way for the agent to learn from YOU about YOUR project
- An onboarding process for your AI teammate
- A mechanism to customize the harness through conversation
- Persistent knowledge that grows smarter over time

### What Training Is Not

- **Not a replacement for CLAUDE.md.** They complement each other.
- **Not a linter or CI gate.** Training is advisory. For enforcement, add dbt tests or sqlfluff rules.
- **Not an audit trail.** No approval workflows or change tracking beyond git history.
- **Not automatic.** The agent proposes, you confirm. Training is explicit and deliberate.

### Limits

| Limit | Value |
|---|---|
| Max entries per kind | 20 |
| Max content per entry | 2,500 characters |
| Training kinds | 6 (pattern, rule, glossary, standard, context, playbook) |
| Scopes | 2 (global = personal, project = team-shared) |

---

## Tools Reference

| Tool | Purpose | Available In |
|---|---|---|
| `training_save` | Save or update a training entry | All modes |
| `training_list` | List entries with usage stats and insights | All modes |
| `training_remove` | Remove an entry | All modes |
| `training_scan` | Auto-discover patterns in codebase | Trainer mode |
| `training_validate` | Check training compliance against code | Trainer mode |

## Skills Reference

| Skill | Purpose |
|---|---|
| `/teach` | Learn a pattern from an example file |
| `/train` | Extract rules and standards from a document |
| `/training-status` | View training dashboard |

## Feature Flag

```bash
export ALTIMATE_DISABLE_TRAINING=true  # Disables all training tools and injection
```
