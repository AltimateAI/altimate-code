---
title: altimate
hide:
  - toc
---

<style>
.md-content h1:first-child { display: none; }
.hero img { max-width: 280px; image-rendering: -webkit-optimize-contrast; image-rendering: crisp-edges; }
</style>

<div class="hero" markdown>

<p align="center">
  <img src="assets/images/altimate-code-banner.png" alt="altimate-code" />
</p>

<p class="hero-tagline">The open-source data engineering harness.</p>

<p class="hero-description">99+ tools for building, validating, optimizing, and shipping data products. Use in your terminal, CI pipeline, orchestration DAGs, or as the harness for your data agents. Evaluate across any platform — independent of a single warehouse provider.</p>

<p class="hero-actions" markdown>

[Get Started](getting-started.md){ .md-button .md-button--primary }
[View on GitHub :material-github:](https://github.com/AltimateAI/altimate-code){ .md-button }

</p>

</div>

<div class="hero-install" markdown>

```bash
npm install -g altimate-code
```

</div>

---

<h2 class="section-heading">Purpose-built for the data product lifecycle</h2>
<p class="section-sub">Every tool covers a specific stage — build, validate, optimize, or ship. Not general-purpose AI on top of SQL files.</p>

<div class="grid cards" markdown>

-   :material-database-search:{ .lg .middle } **SQL Anti-Pattern Detection**

    ---

    19 rules with confidence scoring. Catches SELECT *, missing filters, cartesian joins, non-sargable predicates, and more.

-   :material-graph-outline:{ .lg .middle } **Column-Level Lineage**

    ---

    Automatic lineage extraction from SQL. Trace any column back through joins, CTEs, and subqueries to its source.

-   :material-cash-multiple:{ .lg .middle } **FinOps & Cost Analysis**

    ---

    Credit analysis, expensive query detection, warehouse right-sizing, and unused resource cleanup.

-   :material-translate:{ .lg .middle } **Cross-Dialect Translation**

    ---

    Transpile SQL between Snowflake, BigQuery, Databricks, Redshift, PostgreSQL, and more.

-   :material-shield-lock-outline:{ .lg .middle } **PII Detection & Safety**

    ---

    Automatic column scanning for PII. Safety checks and policy enforcement before every query execution.

-   :material-pipe:{ .lg .middle } **dbt Native**

    ---

    Manifest parsing, test generation, model scaffolding, incremental model detection, and lineage-aware refactoring.

</div>

---

<h2 class="section-heading">Use anywhere in your stack</h2>
<p class="section-sub">Run interactively, automate in CI, embed in DAGs, or mount as the tool layer for your AI agents.</p>

<div class="grid cards" markdown>

-   :material-console:{ .lg .middle } **Terminal**

    ---

    Interactive TUI with 99+ tools, autocomplete for skills, and persistent memory across sessions.

-   :material-pipe-disconnected:{ .lg .middle } **CI Pipeline**

    ---

    Headless mode for automated validation, schema diffing, and anti-pattern checks in GitHub Actions or any CI system.

-   :material-graph:{ .lg .middle } **Orchestration DAGs**

    ---

    Call the harness from Airflow, Dagster, or Prefect tasks to add data quality gates and lineage checks to your pipelines.

-   :material-robot-outline:{ .lg .middle } **Data Agent Harness**

    ---

    Mount altimate as the tool layer underneath Claude Code, Codex, or any AI agent — giving it deterministic, warehouse-aware capabilities.

</div>

---

<h2 class="section-heading">Seven specialized agents</h2>
<p class="section-sub">Each agent has scoped permissions and purpose-built tools for its role.</p>

<div class="grid cards" markdown>

-   :material-hammer-wrench:{ .lg .middle } **Builder**

    ---

    Create dbt models, SQL pipelines, and data transformations with full read/write access.

-   :material-chart-bar:{ .lg .middle } **Analyst**

    ---

    Explore data, run SELECT queries, and generate insights. Read-only access is enforced.

-   :material-check-decagram:{ .lg .middle } **Validator**

    ---

    Data quality checks, schema validation, test coverage analysis, and CI gating.

-   :material-swap-horizontal:{ .lg .middle } **Migrator**

    ---

    Cross-warehouse SQL translation, schema migration, and dialect conversion workflows.

-   :material-magnify:{ .lg .middle } **Researcher**

    ---

    Deep multi-step investigations with structured reports. Root cause analysis, cost audits, deprecation checks.

-   :material-school:{ .lg .middle } **Trainer**

    ---

    Correct the agent once, it remembers forever, your team inherits it. Teach patterns, rules, and domain knowledge.

-   :material-account-tie:{ .lg .middle } **Executive**

    ---

    Business-friendly reporting. No SQL jargon — translates technical findings into impact and recommendations.

</div>

---

<h2 class="section-heading">Works with any LLM</h2>
<p class="section-sub">Model-agnostic — bring your own provider or run locally.</p>

<div class="pill-grid" markdown>

- :material-cloud: **Anthropic**
- :material-creation: **OpenAI**
- :material-google: **Google**
- :material-aws: **AWS Bedrock**
- :material-microsoft-azure: **Azure OpenAI**
- :material-server: **Ollama**
- :material-router-wireless: **OpenRouter**

</div>

---

<h2 class="section-heading">Evaluate across any platform</h2>
<p class="section-sub">First-class support for 8 warehouses. Migrate, compare, and translate across platforms — not locked to one vendor.</p>

<div class="pill-grid" markdown>

- :material-snowflake: **Snowflake**
- :material-google-cloud: **BigQuery**
- :simple-databricks: **Databricks**
- :material-elephant: **PostgreSQL**
- :material-aws: **Redshift**
- :material-duck: **DuckDB**
- :material-database: **MySQL**
- :material-microsoft: **SQL Server**

</div>

---

<div class="doc-links" markdown>

**Documentation** — [Getting Started](getting-started.md) | [Guides](data-engineering/guides/cost-optimization.md) | [Tools](data-engineering/tools/sql-tools.md) | [Configuration](configure/config.md)

**Extend** — [SDK](develop/sdk.md) | [Plugins](develop/plugins.md) | [Server API](develop/server.md)

</div>
