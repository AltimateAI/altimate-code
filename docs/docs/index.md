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

<p class="hero-tagline">The data engineering agent for<br/>dbt, SQL, and cloud warehouses.</p>

<p class="hero-description">An AI-powered CLI with 55+ specialized tools — SQL analysis, schema inspection, column-level lineage, FinOps, and RBAC. Connects to your warehouse, understands your data, and helps you ship faster.</p>

<p class="hero-actions" markdown>

[Get Started](getting-started.md){ .md-button .md-button--primary }
[View on GitHub :material-github:](https://github.com/AltimateAI/altimate-code){ .md-button }

</p>

</div>

<div class="hero-install" markdown>

```bash
npm install -g @altimateai/altimate-code
```

</div>

---

<h2 class="section-heading">Built for data teams</h2>
<p class="section-sub">Unlike general-purpose coding agents, every tool is purpose-built for data engineering workflows.</p>

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

<h2 class="section-heading">Four specialized agents</h2>
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

<h2 class="section-heading">Connects to your warehouse</h2>
<p class="section-sub">First-class support for 8 data platforms.</p>

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

**Documentation** — [Getting Started](getting-started.md) | [Data Engineering](data-engineering/agent-modes.md) | [Configuration](configure/config.md)

**Develop & Extend** — [SDK](develop/sdk.md) | [Plugins](develop/plugins.md) | [Server API](develop/server.md)

</div>
