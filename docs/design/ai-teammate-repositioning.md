# altimate: From AI Tool to AI Teammate

## The Core Repositioning

**Current**: "The data engineering agent for dbt, SQL, and cloud warehouses" — a sophisticated CLI tool with 55+ features.

**Proposed**: "Your data engineering teammate" — an AI colleague you onboard, train on your team's standards, and who gets better the more you work together.

### Why This Matters

The "AI tool" framing puts altimate in a crowded market of CLI tools and coding agents. Users evaluate it feature-by-feature against Claude Code, Cursor, Copilot, etc.

The "AI teammate" framing creates a different mental model entirely:
- **Tools are disposable; teammates are invested in.** You don't "configure" a teammate — you onboard them, teach them your ways, and they earn your trust over time.
- **Tools are generic; teammates know your context.** A teammate knows your naming conventions, your warehouse quirks, your team's review standards, your domain vocabulary.
- **Tools wait for instructions; teammates are proactive.** A teammate notices when a PR introduces an anti-pattern, flags cost anomalies, and suggests improvements without being asked.

### Inspiration: OpenClaw & the "Trainable Agent" Pattern

**OpenClaw** (247K+ GitHub stars, fastest-growing open-source project ever) proved the "teammate" framing works when backed by real architecture. Key lessons:

1. **Meet users where they are.** OpenClaw's UX *is* your existing messaging apps (WhatsApp, Telegram, Slack, Signal). Zero learning curve. For altimate, the equivalent: meet data engineers in their terminal, their dbt workflow, their Slack — don't force them into a separate app.

2. **Self-improving memory.** OpenClaw captures learnings, errors, and corrections in structured files (`LEARNINGS.md`, `ERRORS.md`). When patterns recur 3+ times across 2+ tasks within 30 days, they auto-promote into permanent system prompt files (`CLAUDE.md`, `SOUL.md`). This is the model for altimate's training system — learning should be automatic, not manual.

3. **Proactive heartbeat.** A scheduler wakes the agent at intervals so it can act without being prompted — checking email, running tasks, flagging issues. For altimate: imagine the teammate running nightly cost checks, freshness monitors, or schema drift detection without being asked.

4. **Persistent identity.** One agent instance across all channels with shared memory and context. For altimate: the same teammate across TUI, web, CI/CD, and Slack — always knowing your project, your standards, your history.

**Devin** ($10.2B valuation, $73M ARR) proved the market appetite: they market as "a collaborative AI teammate" and "the first AI software engineer," but candidly advise treating it as "a junior coding partner." The honesty works — users understand the capability boundary.

**Factory AI** positions autonomous "Droids" that embed into existing workflows (VS Code, JetBrains, Slack, Linear). Their insight: "delegate complete tasks like refactors, incident response, and migrations without changing your tools."

The **World Economic Forum** outlines the industry evolution:
1. **Copilots** (assisted intelligence) — suggestions, human controls
2. **Agents** (autonomous task execution) — limited decisions, task-oriented
3. **AI Teammates** (collaborative intelligence) — adapt, learn, achieve shared objectives

altimate should skip straight to level 3 for data engineering.

> The best AI teammate is one that adapts to YOUR team, not one that forces your team to adapt to IT.

---

## Design: The Teammate Interface

### 1. Onboarding (replacing "Configuration")

Instead of a config file with warehouse credentials, the first experience is an **onboarding conversation**:

```
Welcome! I'm your new data engineering teammate.

Let me get set up. I'll learn about your data stack, coding standards,
and how your team works.

Step 1/4: Discovering your environment...
  Found: dbt project (dbt-core 1.7.4)
  Found: Snowflake warehouse (from ~/.dbt/profiles.yml)
  Found: 3 dbt packages (dbt_utils, dbt_expectations, elementary)
  Found: sqlfluff config (.sqlfluff)

Step 2/4: Learning your coding style...
  Analyzing 47 existing models...
  Detected patterns:
    - CTE-heavy style (avg 3.2 CTEs per model)
    - snake_case naming (100% consistent)
    - Staging models use "stg_" prefix
    - Intermediate models use "int_" prefix
    - Mart models use no prefix
    - Primary keys named "<entity>_id"
    - Created/updated timestamps always present

Step 3/4: Understanding your review standards...
  No .altimate/standards found.
  Would you like to teach me your standards now, or learn as we go?

Step 4/4: Learning your domain vocabulary...
  Scanned model descriptions and column comments.
  Built glossary: 23 domain terms (ARR, MRR, churn_date, cohort, ...)

Ready! I'll keep learning as we work together.
```

**Key shift**: The user doesn't fill out a config file. They have a conversation. The AI discovers, learns, and confirms.

### 2. Training (replacing "Skills/Prompts")

Training is how the teammate gets better at YOUR team's specific way of working. Three training mechanisms:

#### a) Learn-by-Example (`/teach`)

```
You: /teach staging-model
Teammate: Show me an example of a well-written staging model in your project.
You: @models/staging/stg_orders.sql
Teammate: Got it. I've learned these patterns from your staging model:
  - Source reference via {{ source('stripe', 'orders') }}
  - Rename columns to snake_case in CTE
  - Cast types explicitly
  - Add surrogate key via dbt_utils.generate_surrogate_key
  - Final SELECT with column ordering: keys → dimensions → measures → timestamps
  I'll follow this pattern for all future staging models.
```

The teammate stores this as a **learned pattern** (not just a prompt — structured knowledge it can reference and apply):

```yaml
# .altimate/learned/staging-model.yml
name: staging-model
type: pattern
learned_from: models/staging/stg_orders.sql
learned_at: 2025-12-15T10:30:00Z
patterns:
  - source_reference: "{{ source('<schema>', '<table>') }}"
  - cte_strategy: rename_and_cast
  - surrogate_key: dbt_utils.generate_surrogate_key
  - column_order: [keys, dimensions, measures, timestamps]
  - naming: snake_case
```

#### b) Learn-by-Correction (Implicit + `/feedback`)

When the teammate does something wrong, instead of just fixing it, you teach it:

```
You: Actually, we never use FLOAT — always use NUMERIC(18,2) for financial amounts
Teammate: Noted! I've updated my understanding:
  Rule: Use NUMERIC(18,2) instead of FLOAT for financial columns
  Applies to: columns matching *_amount, *_price, *_cost, *_revenue, *_total
  I'll apply this in all future work.
```

Stored as a **learned rule**:

```yaml
# .altimate/learned/rules/numeric-over-float.yml
name: numeric-over-float
type: rule
learned_at: 2025-12-15T11:00:00Z
rule: "Use NUMERIC(18,2) instead of FLOAT for financial amounts"
applies_to:
  column_patterns: ["*_amount", "*_price", "*_cost", "*_revenue", "*_total"]
severity: high
```

**Auto-promotion (inspired by OpenClaw's self-improving agent):**

When a correction pattern recurs 3+ times across 2+ sessions within 30 days, it auto-promotes from a "soft preference" to a "hard rule" in the system prompt. The teammate proactively tells you:

```
Teammate: I've noticed you've corrected my use of LEFT JOIN → INNER JOIN
          in staging models 4 times now. Should I make this a permanent rule?
          [Yes, always use INNER JOIN in staging] [No, keep case-by-case]
```

This mirrors OpenClaw's `LEARNINGS.md` → `CLAUDE.md` promotion pipeline, but adapted for structured data engineering rules rather than free-form text.

#### c) Learn-by-Document (`/train`)

For more formal training, point the teammate at documents:

```
You: /train https://wiki.company.com/data-team/sql-style-guide
Teammate: I've read your SQL style guide. Here's what I've learned:
  - 14 SQL formatting rules
  - 7 naming conventions
  - 5 prohibited patterns (no SELECT *, no implicit joins, etc.)
  - 3 performance guidelines
  Want me to summarize what I'll enforce?
```

Also works with local files:

```
You: /train .altimate/standards/review-checklist.md
You: /train @models/README.md
```

### 3. Teammate Roles (replacing "Agent Modes")

Instead of "switching agent modes," you ask your teammate to work in different roles. Same teammate, different hat:

| Current (Mode) | Proposed (Role) | Framing |
|---|---|---|
| Builder | **Build** | "Help me build this model" |
| Analyst | **Investigate** | "Help me understand this data" |
| Validator | **Review** | "Review this PR / model" |
| Migrator | **Migrate** | "Help me move this to BigQuery" |
| Executive | **Brief** | "Summarize this for my VP" |
| *NEW* | **Deep Research** | "Do a deep dive on X" |

The role selection becomes more natural:

```
You: @stg_orders.sql review this
Teammate: [automatically enters Review role]

You: I need to understand why revenue numbers are off
Teammate: [automatically enters Investigate role, then Deep Research if complex]
```

**Auto-role detection**: The teammate infers the right role from context, rather than requiring explicit mode switching. You CAN still force a role with `/role build` etc.

### 4. Deep Research Mode (NEW)

This is a powerful new capability that differentiates altimate. When the user asks a complex question, the teammate enters Deep Research mode — a multi-step, thorough investigation.

#### What Deep Research Does

```
You: Why did our Snowflake costs spike 40% last month?

Teammate: [Entering Deep Research mode — this may take a few minutes]

Phase 1: Gathering data
  ├─ Pulling credit consumption history (90 days)
  ├─ Analyzing query history (top 100 by cost)
  ├─ Checking warehouse utilization patterns
  └─ Comparing against previous month baseline

Phase 2: Analyzing patterns
  ├─ Identified 3 warehouses with anomalous usage
  ├─ Found 12 queries with 10x+ cost increase
  ├─ Detected new recurring job (started March 3)
  └─ Cross-referencing with git history for pipeline changes

Phase 3: Tracing root causes
  ├─ PR #847 (merged March 2): Changed incremental model to full refresh
  ├─ New dashboard query running every 15 min (no result caching)
  ├─ ANALYTICS_WH auto-scaled to 2XL due to queue depth
  └─ 3 zombie queries from failed Airflow tasks

Phase 4: Synthesizing report
  ...

━━━ Deep Research Report ━━━

## Snowflake Cost Spike Analysis

### Summary
Credits increased 40% ($12,400 → $17,360) driven by three root causes:

### Root Cause 1: Full Refresh Regression (est. $2,800)
PR #847 changed `fct_orders` from incremental to full refresh.
This was likely unintentional — the PR description says "fix deduplication"
but the materialization change wasn't mentioned in review.
→ Recommendation: Revert to incremental, fix dedup with window function

### Root Cause 2: Dashboard Over-Polling (est. $1,200)
The new "Real-Time Revenue" dashboard queries `mart_revenue` every 15 min.
This model takes ~45 seconds per run and doesn't use result caching.
→ Recommendation: Enable result caching, reduce frequency to hourly

### Root Cause 3: Warehouse Auto-Scaling (est. $960)
ANALYTICS_WH scaled from L to 2XL due to queue depth from the above.
→ Recommendation: Will auto-resolve once causes 1-2 are fixed

### Action Items
1. [ ] Revert fct_orders to incremental materialization
2. [ ] Enable result caching for mart_revenue
3. [ ] Kill 3 zombie queries (IDs: ...)
4. [ ] Add cost alerting threshold at $14,000/month
```

#### Deep Research Architecture

Deep Research works by orchestrating multiple tools in a planned sequence:

```
User Question
    │
    ▼
┌─────────────────┐
│  Research Planner│  ← Breaks question into investigation steps
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│ Worker │ │ Worker │  ← Parallel data gathering (sub-agents)
│ (SQL)  │ │ (Schema│
└───┬────┘ └───┬────┘
    │          │
    ▼          ▼
┌─────────────────┐
│   Synthesizer   │  ← Combines findings, identifies patterns
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Report Generator│  ← Produces structured output with actions
└─────────────────┘
```

Key properties:
- **Multi-step**: Not a single LLM call — a planned investigation
- **Tool-heavy**: Uses warehouse queries, lineage tracing, cost analysis, git history
- **Parallel**: Gathers data concurrently where possible
- **Progressive**: Shows progress as it works (not a black box)
- **Actionable**: Always ends with specific recommendations and action items

#### Deep Research Use Cases

| Question | What it investigates |
|---|---|
| "Why did costs spike?" | Credit history, query costs, warehouse scaling, recent PRs |
| "Is this model safe to deprecate?" | Downstream lineage, dashboard dependencies, query history |
| "What's the data quality status of our pipeline?" | Test results, freshness, row counts, schema changes |
| "How should we migrate to BigQuery?" | Dialect differences, feature usage, cost projections |
| "What PII exposure do we have?" | Column scanning, lineage to PII sources, access controls |

### 5. Memory & Continuity

A teammate remembers. Three types of memory:

#### a) Session Memory (Short-term)
What you discussed in this session. Already exists via session management.

#### b) Project Memory (Medium-term)
Learned patterns, rules, and preferences stored in `.altimate/learned/`. Persists across sessions. Committed to git so the whole team benefits.

```
.altimate/
  learned/
    patterns/          # Learned from /teach
      staging-model.yml
      incremental-pattern.yml
    rules/             # Learned from corrections
      numeric-over-float.yml
      no-select-star.yml
    glossary/          # Domain terms
      business-terms.yml
    standards/         # Learned from /train
      sql-style.yml
      review-checklist.yml
  training-log.yml     # History of all training events
```

#### c) Team Memory (Long-term)
When learned patterns are committed to git, every team member's altimate instance picks them up. One person teaches, the whole team benefits.

```
You: /teach staging-model @models/staging/stg_orders.sql
Teammate: Learned! This pattern is saved to .altimate/learned/patterns/staging-model.yml
         Commit this file so your teammates' altimate instances learn it too.
```

### 6. Proactive Behaviors (inspired by OpenClaw's Heartbeat)

A real teammate doesn't wait to be asked. OpenClaw proved this with its heartbeat scheduler — a background process that wakes the agent at intervals to act autonomously.

For altimate, proactive behaviors are domain-specific and high-value:

#### Background Monitors (opt-in)

```yaml
# .altimate/monitors.yml
cost_alert:
  schedule: daily
  threshold: 120%  # Alert if costs >120% of 30-day average
  action: slack_notify  # or: session_note, email, github_issue

freshness_check:
  schedule: hourly
  models: ["fct_orders", "fct_revenue", "dim_customers"]
  stale_after: 4h
  action: slack_notify

schema_drift:
  schedule: daily
  watch: ["raw.*"]  # Watch raw layer for upstream changes
  action: session_note  # Note it in next session

pii_scan:
  schedule: weekly
  scope: all_indexed_schemas
  action: github_issue
```

#### In-Session Proactive Behaviors

```
You: Can you build a staging model for the new payments table?

Teammate: Sure! Before I start — I noticed something while looking at the
          payments table:
          - Column `card_number` matches PII pattern (credit card)
          - Column `email` matches PII pattern (email address)
          These should probably be masked or excluded in staging.
          Want me to add masking, or exclude them?
```

The teammate doesn't wait to be asked about PII — it checks proactively because that's what a good data engineering teammate does.

### 7. The Training Dashboard (`/training-status`)

Show users what their teammate has learned:

```
You: /training-status

━━━ Training Status ━━━

Patterns learned:     7  (staging, intermediate, mart, incremental, snapshot, source, test)
Rules learned:       12  (naming, types, performance, safety)
Glossary terms:      34  (business domain terms)
Standards loaded:     2  (SQL style guide, review checklist)

Last training:  2 days ago (learned "no-cartesian-joins" rule)
Confidence:     High (92% of suggestions accepted in last 30 days)

Recent corrections:
  - Dec 13: "Use NUMERIC not FLOAT for money" → applied 4 times since
  - Dec 10: "staging models should have a _loaded_at timestamp" → applied 2 times
  - Dec 8: "Don't use QUALIFY in staging, save for marts" → applied 1 time

Want to review or modify any learned patterns? Use /teach --list
```

---

## Implementation Plan

### Phase 1: Foundation (Training Infrastructure)

**Goal**: Build the learned knowledge system and `/teach`, `/feedback`, `/train` commands.

1. **Learned knowledge store** (`.altimate/learned/`)
   - YAML-based storage for patterns, rules, glossary, standards
   - Schema definitions for each knowledge type
   - Loader that injects learned knowledge into system prompts
   - File: `packages/opencode/src/altimate/learned/`

2. **`/teach` skill**
   - Accept file references as examples
   - Extract patterns using LLM analysis
   - Store as structured YAML
   - File: `.opencode/skills/teach/SKILL.md`

3. **`/feedback` implicit learning**
   - Detect corrections in conversation ("actually, we prefer X")
   - Extract rules and store them
   - Apply rules in future sessions
   - File: `packages/opencode/src/altimate/learning/`

4. **`/train` document ingestion**
   - Accept URLs and file paths
   - Parse and extract actionable standards
   - Store as structured knowledge
   - File: `.opencode/skills/train/SKILL.md`

5. **System prompt injection**
   - Load all learned knowledge at session start
   - Inject as context alongside agent prompts
   - Priority: explicit rules > learned patterns > defaults
   - File: modify `packages/opencode/src/session/system.ts`

### Phase 2: Deep Research Mode

**Goal**: Add a new "research" role that does multi-step investigations.

1. **Research planner**
   - Takes a question, breaks it into investigation steps
   - Determines which tools to use for each step
   - Plans parallel vs sequential execution
   - File: `packages/opencode/src/altimate/research/planner.ts`

2. **Research agent**
   - New agent type with research-specific prompt
   - Has access to all read-only tools + warehouse queries
   - Progressive output (shows phases as it works)
   - File: add to `packages/opencode/src/agent/agent.ts`

3. **Report generator**
   - Synthesizes findings into structured reports
   - Always includes: summary, root causes, evidence, action items
   - Export as markdown or JSON
   - File: `packages/opencode/src/altimate/research/report.ts`

4. **Auto-detection**
   - Detect when a question warrants deep research vs quick answer
   - Trigger automatically for complex analytical questions
   - User can force with `/research` command

### Phase 3: Teammate UX Polish

**Goal**: Rebrand the interface to feel like working with a colleague.

1. **Rename throughout**
   - "Agent mode" → "Role"
   - "Select agent" → "Switch role"
   - "Skills" → "Abilities" (or keep skills — it works for teammates too)
   - "Configuration" → "Training" / "Preferences"

2. **Onboarding flow**
   - Replace first-run config with conversational onboarding
   - Auto-discover + confirm with user
   - Learn initial patterns from existing codebase

3. **Training status**
   - `/training-status` command showing what's been learned
   - Confidence scoring based on acceptance rate
   - Suggestions for what to teach next

4. **Proactive teammate behaviors**
   - Suggest training opportunities ("I noticed you corrected my FLOAT usage 3 times — want me to learn this as a rule?")
   - Flag when learned rules conflict
   - Periodic "how am I doing?" prompts

### Phase 4: Terminology & Marketing Updates

1. **README**: "Your data engineering teammate" not "data engineering agent"
2. **CLI welcome**: "Ready to work!" not "Agent initialized"
3. **Tagline options**:
   - "The data engineering teammate that learns your standards"
   - "An AI teammate for data teams — train it once, benefit forever"
   - "Your team's data engineering expert, trained on YOUR codebase"
4. **Key narrative**: "Don't configure another tool. Onboard a teammate."

---

## Competitive Differentiation

| Product | Framing | Training? | Data-Aware? | Proactive? |
|---|---|---|---|---|
| Claude Code | AI coding assistant | CLAUDE.md only | No | No |
| Cursor | AI-powered IDE | Cursor Rules files | No | No |
| Devin ($10.2B) | AI software engineer | No | No | Yes (async tasks) |
| Factory AI | Autonomous Droids | No | No | Yes (workflow triggers) |
| OpenClaw (247K stars) | Trainable AI agent | Self-improving memory + RL | No | Yes (heartbeat scheduler) |
| **altimate** | **AI data teammate** | **Structured learning (/teach, /train, auto-promote)** | **Yes (55+ tools, warehouse)** | **Yes (cost alerts, schema drift)** |

### What altimate takes from each:

| From | What we borrow | How we adapt it |
|---|---|---|
| **OpenClaw** | Self-improving memory, auto-promotion of learnings | Structured YAML rules instead of free-form markdown; domain-specific (SQL patterns, not general tasks) |
| **OpenClaw** | Heartbeat scheduler for proactive behavior | Nightly cost checks, freshness monitors, schema drift detection |
| **OpenClaw** | Meet-users-where-they-are UX | TUI + Web + Slack + CI/CD — same teammate everywhere |
| **Devin** | "Collaborative AI teammate" positioning | Same framing, but specialized: "data engineering teammate" not "software engineer" |
| **Devin** | Honest capability framing ("junior partner") | "Trained on your standards, but you're still the senior engineer" |
| **Factory AI** | Embed into existing workflows, don't replace them | Works inside your dbt workflow, not beside it |

### The unique combination

**Trainable + data-domain-specific + warehouse-connected + proactive.**

No other product lets you:
1. Teach an AI your team's SQL standards (`/teach`)
2. Have it enforce those standards against your actual warehouse metadata and lineage
3. Watch it auto-improve from your corrections over time
4. Wake up to find it already flagged a cost anomaly or schema drift overnight

---

## Summary

The repositioning from "AI tool" to "AI teammate" is not just marketing — it requires real product changes:

1. **Training infrastructure** that makes the AI genuinely learn and improve
2. **Deep Research mode** that showcases teammate-level initiative and thoroughness
3. **Memory system** that persists and shares knowledge across team members
4. **UX changes** that frame every interaction as collaboration, not command-and-control

The result: users don't just use altimate — they invest in it, teach it, and trust it more over time. That's a fundamentally different (and stickier) relationship than "tool I configured once."
