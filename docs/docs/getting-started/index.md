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

<p class="hero-tagline">The open-source data engineering harness.</p>

<p class="hero-description">70+ specialized data engineering tools for building, validating, optimizing, and shipping data products. Use in your terminal, CI pipeline, orchestration DAGs, or as the harness for your data agents. Evaluate across platforms, independent of any single warehouse provider.</p>

<p class="hero-actions" markdown>

[Get Started](quickstart.md){ .md-button .md-button--primary }
[See Examples](../examples/index.md){ .md-button }
[View on GitHub :material-github:](https://github.com/AltimateAI/altimate-code){ .md-button }

</p>

</div>

<div class="hero-install" markdown>

```bash
npm i -g @altimateai/altimate-code && altimate
```

</div>

---

<h2 class="section-heading">See it in action</h2>
<p class="section-sub">Build dbt models from Jira tickets, find broken Snowflake views, optimize warehouse costs, migrate PySpark to dbt, debug Airflow DAGs, and more — all from your terminal.</p>

<p class="section-sub" markdown>[:octicons-arrow-right-24: Browse examples](../examples/index.md)</p>

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

    Five agent modes — Builder, Analyst, Validator, Migrator, and Executive — each with tool-level permissions you can `allow`, `ask`, or `deny` per agent. Layer on project rules via `AGENTS.md`, automatic context compaction for long sessions, and auto-formatting on every edit. Governance enforced by the harness.

</div>

---

<h2 class="section-heading">70+ specialized tools</h2>
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

<h2 class="section-heading">What you can do today</h2>
<p class="section-sub">A few prompts to try in your first five minutes.</p>

```bash
# Auto-detect your data stack (dbt projects, warehouse connections, installed tools)
> /discover

# Analyze a query for anti-patterns and optimization opportunities
> Analyze this query for issues: SELECT * FROM orders JOIN customers ON orders.id = customers.order_id

# Translate SQL across dialects
> /sql-translate this Snowflake query to BigQuery: SELECT DATEADD(day, 7, current_date())

# Generate dbt tests for a model
> /generate-tests for models/staging/stg_orders.sql

# Get a cost report for your Snowflake account
> /cost-report

# Scaffold a new dbt model following your project patterns
> /model-scaffold fct_revenue from stg_orders and stg_payments

# Check column-level lineage for a query
> Trace the lineage for SELECT revenue, region FROM marts.fct_revenue
```

---

<h2 class="section-heading">Benchmarks</h2>
<p class="section-sub">Precision matters. Here's where we stand.</p>

!!! note "Benchmark results coming soon"
    Full benchmark methodology and reproducible results will be published here. Check back for detailed comparisons across ADE-bench and competitive evaluations.

| Benchmark | Result |
|---|---|
| **SQL Anti-Pattern Detection** | 100% accuracy across 1,077 queries, 19 categories. Zero false positives. |
| **Column-Level Lineage** | 100% edge match across 500 queries with complex joins, CTEs, and subqueries. |
| **Snowflake Query Optimization (TPC-H)** | 16.8% average execution speedup (3.6x vs baseline). |
| **ADE-bench** | _Results pending_ |

---

<div class="doc-links" markdown>

**Learn More** — [Quickstart](quickstart.md) | [Examples](../examples/index.md) | [Use](../configure/agent-modes.md) | [Configure](../configure/index.md) | [Interfaces](../interfaces/tui.md) | [Reference](../reference/security-faq.md)

</div>
