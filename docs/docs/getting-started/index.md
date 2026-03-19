---
title: Altimate Code
hide:
  - toc
---

<style>
.md-content h1:first-child { display: none; }
.hero img { max-width: 280px; image-rendering: -webkit-optimize-contrast; image-rendering: crisp-edges; }
</style>

<div class="hero" markdown>

<p align="center">
  <img src="../assets/images/altimate-code-banner.png" alt="altimate-code" />
</p>

<p class="hero-tagline">Open-source data engineering harness.</p>

<p class="hero-description">100+ specialized data engineering tools for building, validating, optimizing, and shipping data products. Use in your terminal, CI pipeline, orchestration DAGs, or as the harness for your data agents. Evaluate across platforms, independent of any single warehouse provider.</p>

<p class="hero-actions" markdown>

[Get Started](quickstart.md){ .md-button .md-button--primary }
[See Examples](../examples/index.md){ .md-button }
[View on GitHub :material-github:](https://github.com/AltimateAI/altimate-code){ .md-button }

</p>

</div>

<div class="hero-install" markdown>

```bash
npm install -g altimate-code
```

</div>

---

<h2 class="section-heading">Why Altimate Code?</h2>
<p class="section-sub">Every major data platform is building AI agents — but they're all locked to one ecosystem. Your data stack isn't.</p>

Your transformation logic is in dbt. Your orchestration is in Airflow or Dagster. Your warehouses span Snowflake and BigQuery (and maybe that Redshift cluster nobody wants to talk about). Your governance requirements cross every platform boundary.

Altimate Code goes the other direction. It connects to your **entire** stack and lets you bring **any LLM** you want. No vendor lock-in. No platform tax.

<div class="grid cards" markdown>

-   :material-open-source-initiative:{ .lg .middle } **Open source & auditable**

    ---

    Every tool, every agent prompt, every analysis rule is inspectable, extensible, and auditable. For data teams in regulated industries, that's not a nice-to-have — it's a requirement.

-   :material-connection:{ .lg .middle } **Cross-platform, not single-vendor**

    ---

    Optimize a Snowflake query in the morning. Migrate a SQL Server pipeline to BigQuery in the afternoon. Same agent, same tools. No warehouse subscription required. First-class support for :material-snowflake: Snowflake, :material-google-cloud: BigQuery, :simple-databricks: Databricks, :material-elephant: PostgreSQL, :material-aws: Redshift, :material-duck: DuckDB, :material-database: MySQL, and :material-microsoft: SQL Server.

-   :material-cloud-outline:{ .lg .middle } **Works with any LLM**

    ---

    Model-agnostic — bring your own provider, use your existing subscription, or run locally. Swap models without swapping your harness. Supports :material-cloud: Anthropic, :material-creation: OpenAI, :material-google: Google Gemini, :material-google: Google Vertex AI, :material-aws: AWS Bedrock, :material-microsoft-azure: Azure OpenAI, :material-server: Ollama, :material-router-wireless: OpenRouter, :material-cog: Mistral, :material-lightning-bolt: Groq, :material-head-snowflake-outline: DeepInfra, :material-brain: Cerebras, :material-message-text: Cohere, :material-group: Together AI, :material-compass: Perplexity, :material-alpha-x-circle: xAI, and :material-github: GitHub Copilot.

-   :material-puzzle:{ .lg .middle } **Customizable to your workflow**

    ---

    Bring your own rules, agents, skills, and tools. Customize the framework to match your company's data conventions, naming standards, and testing patterns.

-   :material-shield-check:{ .lg .middle } **Governed by design — five agent modes**

    ---

    Three agent modes — Builder, Analyst, and Plan — each with tool-level permissions you can `allow`, `ask`, or `deny` per agent. Create custom agents for specialized workflows. Layer on project rules via `AGENTS.md`, automatic context compaction for long sessions, and auto-formatting on every edit. Governance enforced by the harness.

</div>

---

<h2 class="section-heading">100+ specialized tools</h2>
<p class="section-sub">Unlike general-purpose coding agents, every tool is purpose-built for data engineering workflows.</p>

<div class="grid cards" markdown>

-   :material-database-search:{ .lg .middle } **SQL Anti-Pattern Detection**

    ---

    19 rules with confidence scoring. Catches SELECT *, missing filters, cartesian joins, non-sargable predicates, and more. 100% accuracy across 1,077 benchmark queries.

-   :material-graph-outline:{ .lg .middle } **Live Column-Level Lineage**

    ---

    Real-time lineage extraction from SQL. Trace any column back through joins, CTEs, and subqueries to its source. Not a cached graph — a living lineage that updates with every change.

-   :material-cash-multiple:{ .lg .middle } **FinOps & Cost Analysis**

    ---

    Credit analysis, expensive query detection, warehouse right-sizing, and unused resource cleanup. Specific optimization recommendations with estimated savings.

-   :material-translate:{ .lg .middle } **Cross-Dialect Translation**

    ---

    Deterministic engine translating SQL between Snowflake, BigQuery, Databricks, Redshift, PostgreSQL, MySQL, SQL Server, and DuckDB with lineage verification.

-   :material-shield-lock-outline:{ .lg .middle } **PII Detection & Safety**

    ---

    Automatic column scanning across 15+ PII categories. Safety checks and policy enforcement before every query touches production.

-   :material-pipe:{ .lg .middle } **dbt Native**

    ---

    Manifest parsing, test generation, model scaffolding, incremental model detection, and lineage-aware refactoring. Builds models that fit your project conventions.

</div>

---

<h2 class="section-heading">See it in action</h2>
<p class="section-sub">Build dbt models from Jira tickets, find broken Snowflake views, optimize warehouse costs, migrate PySpark to dbt, debug Airflow DAGs, and more — all from your terminal.</p>

```bash

# Analyze a query for anti-patterns and optimization opportunities
> Analyze this query for issues: <query code> or <query id from warehouse>

# Translate SQL across dialects
> /sql-translate this Snowflake query to BigQuery: <query-code>

# Get a cost report for your Snowflake or Databricks account
> /cost-report

# Scaffold a new dbt model following your project patterns
> /model-scaffold fct_revenue from stg_orders and stg_payments

# Generate column level lineage report for sensitive columns
# from a particular table and identify owners
> Trace the lineage for email_id and name columns from
  customer_data.customer_info table and generate a report
  of where sensitive data is replicated with table owners info

# Migrate PySpark jobs to dbt models
> Migrate this PySpark ETL to a dbt model: <path to PySpark file>

# Debug a failing Airflow DAG
> Debug this Airflow DAG failure: <DAG id or error log>
```

<p class="section-sub" markdown>[:octicons-arrow-right-24: Browse more examples](../examples/index.md)</p>

---

<h2 class="section-heading">Benchmarks</h2>
<p class="section-sub">Precision matters. Here's where we stand.</p>

| Benchmark | Result |
|---|---|
| **ADE-Bench (DuckDB Local)** | **74.4%** pass rate (32/43 tasks) — 15.4 points ahead of dbt Fusion+MCP (59%). |
| **SQL Anti-Pattern Detection** | 100% accuracy across 1,077 queries, 19 categories. Zero false positives. |
| **Column-Level Lineage** | 100% edge match across 500 queries with complex joins, CTEs, and subqueries. |
| **Snowflake Query Optimization (TPC-H)** | 16.8% average execution speedup (3.6x vs baseline). |

<p class="section-sub" markdown>[:octicons-arrow-right-24: Full benchmark details](https://www.altimate.sh/benchmarks)</p>

---

<div class="doc-links" markdown>

**Learn More** — [Quickstart](quickstart.md) | [Examples](../examples/index.md) | [Use](../data-engineering/agent-modes.md) | [Configure](../configure/index.md) | [Interfaces](../usage/tui.md) | [Reference](../reference/security-faq.md)

</div>
