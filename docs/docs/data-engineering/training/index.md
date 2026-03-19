# Training: Corrections That Stick

> **Correct the agent once. It remembers forever. Your team inherits it.**

## The Problem

AI coding assistants make the same mistakes over and over. You say "use DECIMAL not FLOAT," it fixes it, then does the same thing next session. You write instructions in CLAUDE.md, but nobody updates it after corrections. The knowledge from your day-to-day work never becomes permanent.

## How Training Works

When the agent makes a mistake and you correct it, it asks:

```
You: No — never use FLOAT for money. Use DECIMAL(18,2).

Builder: Got it. Want me to remember this as a rule?

You: Yes

Builder: Saved. I'll apply this in every future session.
         Your team gets it too when they pull.
```

That's it. **2 seconds.** No editing files. No context switching. The correction becomes permanent knowledge that every agent mode (builder, analyst) sees in every future session.

Research shows compact, focused context improves AI performance by 17 percentage points, while dumping comprehensive docs actually hurts by 3 points (SkillsBench, 7,308 test runs). Training delivers the right knowledge to the right agent at the right time, not everything to everyone.

## Three Ways to Teach

### 1. Correct as You Go (Most Common)

In any mode, corrections become learning moments:

```
You: We use fct_ not fact_ for fact tables

Builder: Got it. Want me to remember this?

You: Yes
```

Next session, every agent knows. Every teammate inherits it via git.

### 2. Learn from Example Files

Point the agent at code that demonstrates a convention:

```
You: /teach @models/staging/stg_orders.sql

Agent: I see the pattern:
  - source CTE → filtered CTE → final
  - ROW_NUMBER dedup on _loaded_at
  Save as pattern "staging-cte-structure"?
```

### 3. Learn from Documentation

Point the agent at your style guide:

```
You: /train @docs/sql-style-guide.md

Agent: I found 8 actionable rules:
  1. SQL keywords in lowercase
  2. Never use SELECT *
  3. CTEs named as verb_noun
  ...
  Save these?
```

---

## What You Can Teach

| Kind | Purpose | Example |
|---|---|---|
| **rule** | Hard constraint | "Never use FLOAT for money. Use DECIMAL(18,2)." |
| **pattern** | How code should look | "Staging models: source CTE → filtered → final" |
| **standard** | Team convention | "Every PR needs tests + schema YAML" |
| **glossary** | Business term | "ARR = Annual Recurring Revenue = MRR * 12" |
| **context** | Background knowledge | "We chose Snowflake because of RBAC support" |
| **playbook** | Step-by-step procedure | "Cost spike: check query history → identify warehouse → kill runaway" |

## How Training Reaches Your Team

1. You correct the agent → training saved to `.altimate-code/memory/`
2. You commit and push (training files are in git)
3. Teammates pull → they inherit your corrections automatically
4. Next session, every agent applies the correction

No meetings. No Slack messages. No "hey everyone, remember to..."

## Systematic Teaching

For systematic teaching (not just corrections), use the `/teach` and `/train` skills in any agent mode:

- `/teach @file` to learn patterns from example files
- `/train @file` to learn standards from documentation
- `/training-status` to see all learned knowledge

### When to Teach

| Scenario | Why |
|---|---|
| New project setup | Teach conventions before anyone starts building |
| New hire onboarding | Walk through what the team has taught |
| After an incident | Save the lesson as a permanent rule |
| Quarterly review | Remove stale entries, consolidate, fill gaps |

## Agent-Aware Delivery

Training doesn't dump everything into every session. It delivers what's relevant:

- **Builder** gets rules and patterns first (naming conventions, SQL constraints)
- **Analyst** gets glossary and context first (business terms, background knowledge)

Research shows 2-3 focused modules per task is optimal. The scoring system ensures each agent gets its most relevant knowledge first.

## Training vs CLAUDE.md

Training doesn't replace CLAUDE.md. They complement each other:

| | CLAUDE.md | Training |
|---|---|---|
| **Best for** | Broad project instructions | Corrections and domain knowledge |
| **How it's written** | You edit a file | Agent captures from conversation |
| **When it's updated** | When you remember | When you correct the agent (2 sec) |
| **What it knows** | What you wrote down | What emerged from working together |
| **Delivery** | Everything, every session | Most relevant per agent |

**Use CLAUDE.md for**: Project-wide setup, broad instructions, architecture docs.

**Use training for**: The corrections, patterns, and domain knowledge that emerge from actually using the agent.

---

## Limitations

- **Advisory, not enforced.** Training guides the agent, but it's not a hard gate. For critical rules, also add dbt tests or sqlfluff rules that block CI.
- **No approval workflow.** Anyone with repo access can save training to project scope. Use code review on `.altimate-code/memory/` changes for governance.
- **No audit trail** beyond git history. Training doesn't track who saved what, so use `git blame` on the training files.
- **Context budget.** Training competes for context space. Under pressure, least-relevant entries are excluded. Run `/training-status` to see what's included.
- **20 entries per kind.** Hard limit. Consolidate related rules into one entry rather than saving many small ones.
- **SQL-focused file analysis.** The `/teach` skill works best with SQL/dbt files. Python, PySpark, and other patterns must be taught manually via conversation.
- **Team sync requires git discipline.** Training saves to disk but doesn't auto-commit. Commit `.altimate-code/memory/` changes to share with your team.

## Quick Reference

### Tools

| Tool | Purpose | Available In |
|---|---|---|
| `training_save` | Save or update an entry | All modes |
| `training_list` | List entries with usage stats | All modes |
| `training_remove` | Remove an entry | All modes |

### Skills

| Skill | Purpose |
|---|---|
| `/teach` | Learn a pattern from an example file |
| `/train` | Extract rules from a document |
| `/training-status` | View training dashboard |

### Limits

| Limit | Value |
|---|---|
| Max entries per kind | 20 |
| Max content per entry | 1,800 characters |
| Training kinds | 6 |
| Scopes | 2 (global = personal, project = team) |

### Feature Flag

```bash
export ALTIMATE_DISABLE_TRAINING=true  # Disables all training
```
