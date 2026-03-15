# Pre-Open-Source Strategic Analysis: Altimate Code

**Date:** 2026-03-14
**Status:** Research synthesis for open-source launch decision

---

## 1. Why Use Altimate Code Over Claude Code?

### The Core Argument: Tools, Not Prompts

Claude Code is a general-purpose coding agent. It can write SQL. It **cannot**:

| Capability | Claude Code | Altimate Code |
|---|---|---|
| Execute SQL against your warehouse | No (needs MCP setup) | Built-in, 10 warehouses |
| Column-level lineage | No | Rust-powered, 34 dialects, ~2ms |
| SQL anti-pattern detection | Heuristic (LLM guesses) | 19 deterministic rules, 100% accuracy on 1,077 benchmark queries |
| PII detection before query execution | No | 15 categories, 30+ regex patterns |
| dbt manifest parsing + test generation | No | Native — manifest, lineage, scaffolding |
| Cross-dialect SQL translation | LLM-based (unreliable) | Deterministic transpilation via altimate-core |
| FinOps / cost analysis | No | Credit analysis, expensive queries, warehouse sizing |
| Schema indexing + search | No | Indexes warehouse metadata for context |
| Safety guardrails (prevent destructive SQL) | No | Pre-execution validation pipeline |
| Diff-aware lineage | No | Before/after SQL impact analysis |

**The fundamental gap:** Claude Code treats SQL as text. Altimate Code treats SQL as a structured artifact with lineage, semantics, cost, and safety properties. This is the difference between "write me a query" and "write me a query that won't break downstream dashboards, won't expose PII, won't cost $500 in warehouse credits, and follows our team's conventions."

### Evidence from Real Data Engineers

From our [real quotes research](../research/real-quotes-data-engineers-ai-tools.md):

> "I'm anxious about losing control over the architecture and data model" — HN user `echelon`

> "The 15 minutes of amazingly fast AI code gen has ballooned into taking most of the afternoon" — HN user `marginalia_nu`

> "AI hallucinated a bunch of fields, and got many types wrong, wasting a lot of my time on diagnosing serialization issues" — HN user `pornel`

> "The LLM never decides whether its own work is good enough" — HN user `vincentvandeth`

These quotes reveal four problems Altimate Code solves that Claude Code doesn't:

1. **Architecture/model control** → Agent modes with scoped permissions (analyst is read-only)
2. **Verification tax** → Deterministic pre-execution pipeline (analyze → validate → execute)
3. **Schema hallucination** → Real warehouse schema indexing, not LLM guessing
4. **Self-verification** → Deterministic quality gates, not LLM self-review

### The Three Killer Differentiators

**1. Free column-level lineage (vs. dbt Enterprise at $500/user/month)**
dbt charges $500/user/month for column-level lineage that runs on open-source SQLGlot. Altimate Code offers Rust-powered CLL across 34 dialects for free. With v0.2.0 of altimate-core, we add diff-aware lineage — something **no competitor offers at any price**.

**2. Pre-execution safety pipeline**
Claude Code will happily run `DROP TABLE` if you ask. Altimate Code's builder agent runs a mandatory pre-execution sequence: analyze → validate → execute. It catches anti-patterns, flags PII exposure, validates safety, and warns about cost — before a single credit is spent.

**3. Agent modes with enforced permissions**
The analyst agent is read-only by design. It cannot write files or execute DDL. This isn't a prompt — it's an architectural constraint. For regulated industries (finance, healthcare), this is table-stakes.

---

## 2. Why the World Needs an Open-Source Custom Harness for Data Work

### The Infrastructure Problem

As Robin Moffatt wrote in ["Claude Code isn't going to replace data engineers (yet)"](https://rmoff.net/2026/03/11/claude-code-isnt-going-to-replace-data-engineers-yet/):

> AI-assisted analytics engineering isn't a prompting problem — it's an infrastructure problem.

General-purpose agents lack the **infrastructure** to do data engineering work:
- No warehouse connectivity
- No schema awareness
- No understanding of dbt project structure
- No lineage computation
- No cost awareness
- No safety guardrails for production data

You can bolt these on via MCP servers, but then you're building a custom harness anyway — except with no shared community, no testing, and no opinionated defaults.

### Why Open-Source Specifically

**1. Data governance requires local-first**
- 72% of companies exceeded cloud budgets last year (Flexera)
- Enterprise data teams can't send production schemas to cloud AI services
- Altimate Code runs 100% locally — warehouse credentials never leave the machine
- CLL works without internet (altimate-core has no cloud dependency)

**2. The modern data stack is fragmented — no single vendor owns it**
- 10+ warehouses, 5+ orchestrators, 3+ transformation tools, N BI tools
- An open-source harness can support all of them; a vendor product picks favorites
- Community contributions fill integration gaps faster than any single team

**3. The MCP ecosystem is necessary but insufficient**
- MCP servers give AI access to individual tools
- But data engineering needs **orchestrated multi-tool workflows** (schema → lineage → analyze → validate → execute)
- An agent harness orchestrates tools into workflows; MCP servers are just individual tools

**4. Trust through transparency**
- Data engineers need to know exactly what SQL is being executed on their warehouse
- Open-source means auditable guardrails, auditable safety checks, auditable PII detection
- "The LLM never decides whether its own work is good enough" — our deterministic validation pipeline is inspectable code, not black-box prompting

### Market Evidence

- 57% of organizations have AI agents in production (LangChain State of Agents 2026)
- 80-90% of AI agent projects fail in production (RAND 2025) — the gap is infrastructure, not models
- 95% of data teams at or above capacity (Acceldata) — automation is not optional
- 40-62% of data engineer time goes to maintenance (Ascend.io) — the right tools reclaim it

---

## 3. Benchmark Strategy: What to Do Instead of Publishing Flaky Numbers

### The Problem with Current Benchmarks

**Spider-2.0-dbt:** Our best product-only score is 42.65% (29/68). The benchmark is flawed:
- 6 of 68 evals have stale ground truth
- 5 are unevaluable due to environment issues
- Column order sensitivity causes false failures
- Date spine issues are benchmark artifacts, not product problems
- Leaderboard leader (Databao) is at 44.11% — the benchmark doesn't meaningfully differentiate

**ADE-bench:** Similar flakiness issues. Not reproducible enough to publish.

### Alternative Proof Points (Recommended)

Instead of publishing benchmark numbers, demonstrate capability through:

**1. Deterministic tool benchmarks (publishable, reproducible)**
- SQL anti-pattern detection: **100% accuracy on 1,077 queries** (19 rules)
- Column-level lineage: **100% edge match on 500 queries**
- SQL transpilation accuracy across dialect pairs
- PII detection precision/recall on labeled datasets

These are deterministic — no LLM variance, no flakiness. Run them in CI. Publish with confidence.

**2. Case study demos (video/blog)**
- "Migrating 500 Snowflake queries to BigQuery in 30 minutes"
- "Finding $50K/month in wasted Snowflake credits"
- "Impact analysis: what breaks when you rename a column"
- "dbt model scaffolding with automatic test generation"

**3. Reproducible evaluation harness (ship with the repo)**
Include an `evals/` directory with:
- Curated SQL files with known anti-patterns → expected detections
- Lineage test cases → expected column edges
- Transpilation pairs → expected output SQL
- dbt project templates → expected model output

Users can run `altimate eval` and see results themselves. This is more credible than a leaderboard position.

**4. Community-driven quality signal**
- GitHub stars, forks, contributor count
- "Built with altimate-code" showcase
- Integration count (warehouses × orchestrators × BI tools)

---

## 4. Tool Utilization Audit: What's Built But Underused

### Current Tool Inventory: 70 Custom Tools

We have 70 custom tools in `packages/opencode/src/altimate/tools/`. Here's the utilization assessment:

#### Well-Utilized (referenced in agent prompts, core workflows)
| Tool | Used By | Status |
|---|---|---|
| `sql-execute` | Builder, Analyst | Core — every SQL interaction |
| `sql-analyze` | Builder (pre-execution) | Core — mandatory pre-execution |
| `sql-validate` (altimate-core-check) | Builder (pre-execution) | Core — safety validation |
| `schema-inspect` | Builder, Analyst | Core — schema awareness |
| `lineage-check` | Builder, Validator | Core — dbt verification |
| `warehouse-list` / `warehouse-test` | Builder, Analyst | Core — connectivity |
| `dbt-run` | Builder | Core — dbt operations |
| `dbt-manifest` | Builder | Core — dbt context |

#### 11 Skills Exist (in `.opencode/skills/`)
| Skill | Purpose | Tools Used |
|---|---|---|
| `/cost-report` | Snowflake cost analysis | finops tools |
| `/dbt-docs` | Documentation generation | dbt-manifest, read/write |
| `/generate-tests` | Test scaffold from SQL | altimate-core-testgen |
| `/impact-analysis` | Downstream change impact | lineage tools |
| `/incremental-logic` | Incremental materialization fixes | dbt tools |
| `/lineage-diff` | Column-level lineage comparison | lineage tools |
| `/medallion-patterns` | Medallion architecture scaffold | write/edit |
| `/model-scaffold` | dbt model generation | dbt tools, write |
| `/query-optimize` | SQL query optimization | sql-analyze, sql-optimize |
| `/sql-translate` | Dialect translation | altimate-core-transpile |
| `/yaml-config` | YAML config generation | read/write |

Most skills rely heavily on filesystem tools (read, write, edit, glob) but underuse the specialized analysis tools. For example, `/cost-report` should chain all 6 finops tools but likely only uses 1-2.

#### Likely Underutilized (not mentioned in prompts, may not be triggered)
| Tool | What It Does | Why It's Underused |
|---|---|---|
| `altimate-core-semantics` | Semantic analysis of SQL | No agent prompt references it |
| `altimate-core-optimize-context` | Prune schema for context | Should be automatic, not a tool |
| `altimate-core-fingerprint` | Schema fingerprinting | Infrastructure tool, not user-facing |
| `altimate-core-equivalence` | Check if two SQL queries are equivalent | Powerful but no skill exposes it |
| `altimate-core-grade` | Grade SQL quality | Overlaps with analyze? |
| `altimate-core-correct` | Auto-correct SQL | How different from fix? |
| `altimate-core-complete` | SQL autocompletion | Hard to use in CLI context |
| `altimate-core-prune-schema` | Prune schema for relevance | Should be internal, not tool |
| `altimate-core-policy` | Check policy compliance | No policies defined by default |
| `altimate-core-resolve-term` | Resolve business terms | Requires semantic layer setup |
| `altimate-core-import-ddl` | Import DDL | Rarely needed explicitly |
| `altimate-core-export-ddl` | Export DDL | Rarely needed explicitly |
| `altimate-core-migration` | Generate migration SQL | Migrator agent exists but prompt doesn't reference this |
| `altimate-core-lint` | SQL linting | Overlaps with check/analyze |
| `altimate-core-safety` | Safety analysis | Overlaps with is-safe |
| `altimate-core-classify-pii` | Classify PII columns | Overlaps with query-pii |
| `finops-unused-resources` | Find unused warehouse resources | Not in any agent prompt |
| `finops-warehouse-advice` | Warehouse sizing advice | Not in any agent prompt |
| `finops-role-access` | RBAC analysis | Not in any agent prompt |
| `schema-tags` | Schema tagging | Not in any agent prompt |
| `schema-detect-pii` | Detect PII in schemas | Not in any agent prompt |
| `schema-cache-status` | Cache status | Infrastructure, not user-facing |
| `sql-autocomplete` | SQL completion | Hard to use in CLI |
| `sql-diff` | Compare two SQL queries | No agent prompt references it |
| `sql-explain` | Explain query plans | Not in any agent prompt |
| `sql-rewrite` | Rewrite SQL | Overlaps with optimize/fix |
| `datamate` | Data mate operations | Purpose unclear |

### Key Findings

1. **Too many overlapping tools**: `check` vs `validate` vs `lint` vs `analyze` vs `grade` — the agent doesn't know when to use which
2. **FinOps tools are orphaned**: 6 FinOps tools exist but NO agent prompt mentions them. The analyst and executive agents should be using these.
3. **Schema tools are underexposed**: `schema-detect-pii`, `schema-tags`, `schema-diff` are powerful but no skill chains them
4. **Equivalence tool is a hidden gem**: Checking if two SQL queries produce the same results is incredibly valuable for migrations and refactoring — but nothing exposes it

### Bug Found: Broken RPC Method

`schema-diff.ts` calls `sql.schema_diff` but this method **does not exist** in `server.py`. The tool will fail at runtime. Either implement it in Python or redirect to `altimate_core.schema_diff`.

### 3 Orphaned RPC Methods (no tool calls them)

- `altimate_core.explain` — superseded by `sql.explain`?
- `local.schema_sync` — development only?
- `local.test` — development only?

### Recommendations

1. **Consolidate overlapping tools**: Merge check/validate/lint into one `sql_validate` with severity levels. Merge fix/correct/rewrite into one `sql_fix` with modes.
2. **Wire FinOps tools into agent prompts**: The analyst and executive agents should proactively use `finops-analyze-credits`, `finops-expensive-queries`, and `finops-warehouse-advice`.
3. **Enrich skills with more tool chaining**: Skills rely too heavily on filesystem tools (read/write/edit/glob). They should chain specialized analysis tools — e.g., `/cost-report` should use all 6 finops tools, `/impact-analysis` should chain diff-lineage + dbt-manifest + schema-inspect.
4. **Surface equivalence in migration workflows**: The migrator agent should automatically check SQL equivalence after transpilation.
5. **Fix `schema-diff` RPC bug** before launch — it will fail for any user who tries it.

---

## 5. Missing Ecosystem Support: Airflow, Spark, and Beyond

### Current State

| Tool | Support Level | Notes |
|---|---|---|
| **dbt** | Deep | Manifest, run, test, compile, lineage, test gen |
| **Snowflake** | Deep | Full connector, FinOps, metadata, query history |
| **BigQuery** | Good | Connector, execution, metadata |
| **PostgreSQL** | Good | Connector, execution, metadata |
| **Databricks** | Good | Connector, execution, metadata |
| **Redshift** | Good | Connector, execution, metadata |
| **DuckDB** | Good | Connector, execution, metadata |
| **MySQL** | Basic | Connector, execution |
| **SQL Server** | Basic | Connector, execution |
| **Apache Airflow** | **None** | Zero references in codebase |
| **Apache Spark** | **None** | Zero references in codebase |
| **Dagster** | **None** | Zero references (mentioned in discover prompt only) |
| **Prefect** | **None** | Zero references |
| **Great Expectations** | **None** | Zero references |
| **SQLMesh** | **None** | Zero references |
| **Kafka** | **None** | Zero references |
| **Fivetran/Airbyte/dlt** | **None** | Zero references |

### What's Missing and Why It Matters

#### Apache Airflow (Critical Gap)
- 70%+ market share in data orchestration
- Every enterprise data team uses it
- AI tools for Airflow are nascent — massive opportunity
- **What we could offer:**
  - DAG analysis: parse Python DAGs, extract dependencies, visualize
  - DAG debugging: read Airflow logs, diagnose task failures
  - DAG generation: create DAGs from natural language descriptions
  - Task optimization: identify bottleneck tasks, suggest parallelization
  - Migration support: Airflow 1.x → 2.x migration assistance
  - Connection management: help configure Airflow connections to warehouses

#### Apache Spark (Important Gap)
- Dominant in large-scale data processing
- SparkSQL is a major dialect — our transpiler should support it
- **What we could offer:**
  - SparkSQL analysis and optimization
  - PySpark code generation and review
  - Spark job configuration optimization (partitioning, caching, broadcast joins)
  - Spark-to-warehouse migration (e.g., Spark → Snowflake)
  - Performance profiling of Spark queries

#### Dagster/Prefect (Emerging Orchestrators)
- Growing fast, especially in modern data teams
- Dagster has software-defined assets that map well to our lineage model
- Prefect's flow/task model could benefit from similar analysis as Airflow

#### Great Expectations / Data Quality
- Data quality is a $30.5B market by 2026
- We have PII detection and schema validation — but not data quality rules
- Integration with GE/Soda/Elementary would round out the validation story

### Recommended Priority

1. **Airflow** — largest user base, biggest gap, most competitive advantage
2. **Spark/SparkSQL** — important dialect support, large enterprise user base
3. **Dagster** — fast-growing, modern API, good fit for our architecture
4. **Great Expectations** — complements our existing validation tools

---

## 6. Strategic Recommendations for Open-Source Launch

### Before Launch (Must-Do)

1. **Consolidate tool overlap** — Reduce 70 tools to ~45-50 well-named, non-overlapping tools
2. **Wire FinOps into agent prompts** — These are built but invisible to users
3. **Add Airflow DAG analysis** — Even basic DAG parsing would be a headline feature
4. **Create 5 showcase skills** that chain multiple tools:
   - `/cost-report` — full warehouse cost analysis
   - `/impact` — diff-aware lineage + downstream impact
   - `/health-check` — project scan + anti-patterns + coverage
   - `/migrate` — transpile + validate + equivalence check
   - `/pii-scan` — schema-wide PII detection with remediation

5. **Ship an `evals/` directory** with deterministic test suites for tools
6. **Write 3 case-study blog posts** demonstrating real workflows

### Positioning for Launch

**Tagline options:**
- "The data engineering agent. 70+ tools. 10 warehouses. Runs locally."
- "Claude Code for data teams — with the tools to actually do the work."
- "AI that understands your data stack, not just your code."

**Key messages:**
1. Not another chat-with-your-data toy — a professional data engineering agent
2. 70+ deterministic tools, not LLM heuristics — anti-patterns, lineage, PII, cost
3. Free column-level lineage that dbt charges $500/user/month for
4. Runs locally, connects to your warehouse, never sends your data to the cloud
5. Open-source fork of OpenCode — built on proven infrastructure, customized for data

### What NOT to Do

1. **Don't publish flaky benchmark numbers** — they invite scrutiny and comparison on metrics that don't reflect real-world value
2. **Don't compete on "AI writes SQL"** — every tool does this. Compete on verification, safety, and cost awareness
3. **Don't try to be everything** — focus on dbt + SQL + warehouses first, orchestrators second
4. **Don't gate features behind API keys** — CLL, anti-pattern detection, PII detection should all work offline with zero configuration

---

---

## Appendix A: Critical Competitive Intelligence (March 2026)

### Snowflake Cortex Code CLI — Direct Competitor

Snowflake's Cortex Code CLI is now **GA with dbt and Airflow support**. 4,400+ users since Nov 2025. Powered by Claude Opus 4.6 and GPT-5.2. Backed by Snowflake's $200M Anthropic partnership.

**Threat level: HIGH.** They have Snowflake-native context, enterprise distribution, and are expanding beyond Snowflake ("any data, anywhere"). But they're vendor-locked and proprietary — our open-source, multi-warehouse story is the counter-play.

### dbt Labs ADE-bench — Better Benchmark Opportunity

dbt Labs released ADE-bench (Dec 2025) — uses real dbt projects with Docker sandboxes and **supports plugin sets** (MCP servers, skills, tools) as declarative configs. This is purpose-built for comparing tool configurations objectively.

**Opportunity:** Submit Altimate Code as an ADE-bench plugin set. This is more credible than Spider-2.0-dbt because dbt Labs created it, and it tests real-world messiness (hundreds of tables, ambiguous entity names).

### ELT-Bench — The Sobering Reality

ELT-Bench (April 2025) tests end-to-end pipeline generation (Airbyte + dbt). Best agent correctly generates only **3.9% of data models** at $4.30/pipeline average cost. This exposes how far from "solved" data engineering automation actually is — and validates our approach of giving humans better tools rather than promising full autonomy.

### Airflow 3.0/3.1 + MCP

Airflow 3.0 (April 2025) introduced Task SDK, DAG versioning, React UI. Airflow 3.1 (Sept 2025) added Human-in-the-Loop workflows. Airflow Summit 2026 features "Airflow as an AI Agent's toolkit" via MCP. **An Airflow MCP server for Altimate Code is now table-stakes.**

### Security Landscape

- 223 AI data security incidents per month on average per org (Kiteworks 2026)
- 55% of orgs use AI tools, only 6% have advanced AI security strategy (Microsoft DSI 2026)
- EU AI Act full enforcement for high-risk systems: August 2, 2026
- California AB 2013 (Jan 2026) mandates training data disclosure

**Our local-first, open-source architecture is a competitive moat, not just a feature.**

---

## Appendix B: Competitive Landscape Summary

| Tool | Type | Price | Key Strength | Key Weakness |
|---|---|---|---|---|
| **Claude Code** | General agent | $20-200/mo | Best general coding | No data tools |
| **Snowflake Cortex Code** | DE agent | Subscription | Snowflake-native, dbt+Airflow | Vendor-locked, proprietary |
| **dbt Copilot** | dbt-specific | $500/user/mo | Deep dbt integration | Cloud-only, expensive |
| **Databao** | Benchmark agent | OSS + SaaS | Best Spider-2.0 score, context engine | Early stage, JetBrains-backed |
| **Paradime DinoAI** | dbt IDE | $25-55/user/mo | Affordable dbt AI | Snowflake-focused |
| **SQLMesh** | Transformation | Free (OSS) | Free CLL via SQLGlot | No agent, no multi-tool orchestration |
| **Datafold** | Data diff | $799+/mo | PR-level data diff | Expensive, narrow focus |
| **Vanna 2.0** | Text-to-SQL | OSS | Agent-based SQL gen | Narrow scope |
| **Altimate Code** | DE agent | Free (OSS) | 70+ tools, 10 warehouses, local-first | Orchestrator gaps, tool overlap |

---

## Appendix C: Sources

- [Claude Code isn't going to replace data engineers (yet)](https://rmoff.net/2026/03/11/claude-code-isnt-going-to-replace-data-engineers-yet/)
- [Agentic coding in analytics engineering — dbt Labs](https://www.getdbt.com/blog/agentic-coding-in-analytics-engineering)
- [Introducing ADE-bench — dbt Labs](https://www.getdbt.com/blog/ade-bench-dbt-data-benchmarking)
- [How Databao Agent ranked #1 — JetBrains](https://blog.jetbrains.com/databao/2026/02/how-databao-agent-ranked-1-spider-2-0-dbt/)
- [Snowflake Cortex Code extends to dbt and Airflow](https://www.infoworld.com/article/4136429/snowflake-extends-cortex-code-cli-to-dbt-and-airflow-to-streamline-data-engineering-workflows.html)
- [ELT-Bench — arXiv](https://arxiv.org/abs/2504.04808)
- [2026 AI Data Security Crisis — Kiteworks](https://www.kiteworks.com/cybersecurity-risk-management/ai-data-security-crisis-shadow-ai-governance-strategies-2026/)
- [LangChain State of Agent Engineering 2026](https://www.langchain.com/state-of-agent-engineering)
- [Data Engineering Trends 2026 — Kestra](https://kestra.io/blogs/2026-03-05-data-eng-trends-2026)
- [Spark History Server MCP — AWS](https://aws.amazon.com/blogs/big-data/introducing-mcp-server-for-apache-spark-history-server-for-ai-powered-debugging-and-optimization/)
- [Apache Airflow 3.0 — The New Stack](https://thenewstack.io/apache-airflow-3-0-from-data-pipelines-to-ai-inference/)
