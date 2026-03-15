# Lineage Gate Debate: How to Monetize Column-Level Lineage

## The Problem

altimate-code is being open-sourced. Column-level lineage is a key differentiator and should be a paid feature. But users must experience it to understand the tool's value.

## Product Architecture

- **altimate-code**: Open-source CLI/agent framework (TypeScript + Python)
- **altimate-core**: Closed-source Rust binary, bundled with altimate-code (NOT open-sourced)
- **Column-level lineage**: Powered by altimate-core, currently feature-flagged
- **BYOK**: Users bring their own LLM API keys. No Altimate backend for core features
- **Local-first**: Everything runs on the user's machine

## What Column-Level Lineage Does

- Traces data flow at the column level through SQL transformations
- Shows which source columns feed into which target columns
- Works across CTEs, JOINs, subqueries, UNION ALLs, dbt models
- Enables impact analysis ("what breaks if I change this column?")
- Enables PII flow tracking ("where does this sensitive column end up?")
- Powers the agent's ability to write correct SQL (understands data flow)
- 2ms execution time, zero database dependency

## The Primary Consumer

**AI coding agents are the primary consumer of lineage, not humans directly.** The agent calls lineage tools during its work — while writing SQL, debugging queries, building dbt models. This means:

1. Feature-gating (free: single-model, paid: full-project) doesn't work — the agent can loop through models and reconstruct the full graph
2. The agent makes lineage calls automatically and in parallel as part of its workflow
3. The "user experience" of lineage happens through the agent's improved output quality, not through a UI

## What We've Ruled Out (and Why)

### 1. Feature-gating (single-model free, full-project paid)
**Why it fails:** Agent can call lineage on each model individually and reconstruct the full graph programmatically. There's no meaningful restriction.

### 2. Local rate limiting (N calls/day)
**Why it fails:** Counter stored locally (config file, SQLite, dotfile). Users can delete the state file and reset. Any local enforcement is bypassable.

### 3. Hard paywall from day 1
**Why it fails:** Users never experience the value. "Trust me, lineage is great" doesn't drive adoption. They need to see it work.

### 4. Time-limited trial (14 days free)
**Partially viable but:** Users can reinstall/reset. Feels like a time bomb. Creates negative sentiment.

## Constraints

1. Must let users experience lineage on first use (no signup before first "wow")
2. Must create a natural conversion trigger to paid
3. Must be enforceable — can't be trivially bypassed by deleting local files
4. Should not require signup before first use
5. Must work when AI agents are the primary consumer (not humans clicking a UI)
6. altimate-core is a compiled Rust binary (closed source, hard to reverse engineer)
7. No Altimate backend API exists for core features currently
8. Users bring their own LLM API keys

## Pricing Context

| Tier | Price | Target |
|------|-------|--------|
| Free | $0 | Individual data engineers |
| Pro | $29/user/month | Professional data engineers |
| Team | $49/user/month | Data teams (5-50 seats) |
| Enterprise | $100-150/seat/month | Organizations (50+ seats) |

## Market Comparables

- **dbt-core** (Apache-2.0) → **dbt Cloud** ($100M+ ARR) for orchestration, CI/CD, docs, governance
- **Snyk CLI** (free) → **Snyk Platform** (paid) for org-wide vulnerability management
- **Terraform CLI** (free) → **Terraform Cloud** (paid) for remote state, team workflows
- **Nx** (free local) → **Nx Cloud** (paid) for remote caching, distributed task execution
- **Turborepo** (free local) → **Vercel** (paid) for remote caching
- **PostHog** (open-source) → **PostHog Cloud** (paid) for managed hosting
- **Cursor** (closed-source) — free tier with limited "fast" requests, paid for more
- **GitHub Copilot** — free tier (2K completions/month), paid for unlimited

## What We Need From This Debate

A specific, implementable recommendation that solves this tension:
- Users MUST experience lineage to understand the value
- Lineage MUST be monetizable (can't give it all away forever)
- The gate MUST work when AI agents are the consumer
- The gate MUST NOT rely solely on deletable local state

Be specific. Name the exact mechanism. Explain how it works technically. Cite real products that use similar approaches. Address the agent-as-consumer problem directly.
