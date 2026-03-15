# Altimate Memory Tools

Altimate Memory gives your data engineering agent **persistent, cross-session memory**. Instead of re-explaining your warehouse setup, naming conventions, or team preferences every session, the agent remembers what matters and picks up where you left off.

Memory blocks are plain Markdown files stored on disk — human-readable, version-controllable, and fully under your control.

## Why memory matters for data engineering

General-purpose coding agents treat every session as a blank slate. For data engineering, this is especially painful because:

- **Warehouse context is stable** — your Snowflake warehouse name, default database, and connection details rarely change, but you re-explain them every session.
- **Naming conventions are tribal knowledge** — `stg_` for staging, `int_` for intermediate, `fct_`/`dim_` for marts. The agent needs to learn these once, not every time.
- **Past analyses inform future work** — if the agent optimized a query or traced lineage for a table last week, recalling that context avoids redundant work.
- **User preferences accumulate** — SQL style, preferred dialects, dbt patterns, warehouse sizing decisions.

Altimate Memory solves this with three tools that let the agent save, recall, and manage its own persistent knowledge.

## Tools

### altimate_memory_read

Read memory blocks from previous sessions. Automatically called at session start to give the agent context.

```
> Read my memory about warehouse configuration

Memory: 1 block(s)

### warehouse-config (project) [snowflake, warehouse]
## Warehouse Configuration

- **Provider**: Snowflake
- **Default warehouse**: ANALYTICS_WH (XS for dev, M for prod)
- **Default database**: ANALYTICS_DB
- **Naming convention**: stg_ for staging, int_ for intermediate, fct_/dim_ for marts
```

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `scope` | `"global" \| "project" \| "all"` | `"all"` | Filter by scope |
| `tags` | `string[]` | `[]` | Filter to blocks containing all specified tags |
| `id` | `string` | — | Read a specific block by ID |

---

### altimate_memory_write

Create or update a persistent memory block.

```
> Remember that our Snowflake warehouse is ANALYTICS_WH and we use stg_ prefix for staging models

Memory: Created "warehouse-config"
```

The agent automatically calls this when it learns something worth persisting — you can also explicitly ask it to "remember" something.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique identifier (lowercase, hyphens/underscores). Examples: `warehouse-config`, `naming-conventions` |
| `scope` | `"global" \| "project"` | Yes | `global` for user-wide preferences, `project` for project-specific knowledge |
| `content` | `string` | Yes | Markdown content (max 2,048 characters) |
| `tags` | `string[]` | No | Up to 10 tags for categorization (max 64 chars each) |

---

### altimate_memory_delete

Remove a memory block that is outdated, incorrect, or no longer relevant.

```
> Forget the old warehouse config, we migrated to BigQuery

Memory: Deleted "warehouse-config"
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | ID of the block to delete |
| `scope` | `"global" \| "project"` | Yes | Scope of the block to delete |

## Scoping

Memory blocks live in two scopes:

| Scope | Storage location | Use case |
|---|---|---|
| **global** | `~/.local/share/altimate-code/memory/` | User-wide preferences: SQL style, preferred models, general conventions |
| **project** | `.opencode/memory/` (in project root) | Project-specific: warehouse config, naming conventions, data model notes, past analyses |

Project memory travels with your repo. Add `.opencode/memory/` to `.gitignore` if it contains sensitive information, or commit it to share team conventions.

## File format

Each block is a Markdown file with YAML frontmatter:

```markdown
---
id: warehouse-config
scope: project
created: 2026-03-14T10:00:00.000Z
updated: 2026-03-14T10:00:00.000Z
tags: ["snowflake", "warehouse"]
---

## Warehouse Configuration

- **Provider**: Snowflake
- **Default warehouse**: ANALYTICS_WH
- **Default database**: ANALYTICS_DB
```

Files are human-readable and editable. You can create, edit, or delete them manually — the agent will pick up changes on the next session.

## Limits and safety

| Limit | Value | Rationale |
|---|---|---|
| Max block size | 2,048 characters | Prevents any single block from consuming too much context |
| Max blocks per scope | 50 | Bounds total memory footprint |
| Max tags per block | 10 | Keeps metadata manageable |
| Max tag length | 64 characters | Prevents tag abuse |
| Max ID length | 256 characters | Reasonable filename length |

### Atomic writes

Blocks are written to a temporary file first, then atomically renamed. This prevents corruption if the process is interrupted mid-write.

## Disabling memory

Set the environment variable to disable all memory functionality — tools and automatic injection:

```bash
ALTIMATE_DISABLE_MEMORY=true
```

This is useful for **benchmarks**, CI pipelines, or any environment where persistent memory should not influence agent behavior. When disabled, memory tools are removed from the tool registry and no memory blocks are injected into the system prompt.

## Context window impact

Altimate Memory automatically injects relevant blocks into the system prompt at session start, subject to a configurable token budget (default: 8,000 characters). Blocks are sorted by last-updated timestamp, so the most recently relevant information is loaded first. The agent also has access to memory tools (`altimate_memory_read`, `altimate_memory_write`, `altimate_memory_delete`) to manage blocks on demand during a session.

**What this means in practice:**

- With a typical block size of 200-500 characters, the default budget comfortably fits 15-40 blocks
- Memory injection adds a one-time cost at session start — it does not grow during the session
- If you notice context pressure, reduce the number of blocks or keep them concise
- The agent's own tool calls and responses consume far more context than memory blocks
- To disable injection entirely (e.g., for benchmarks), set `ALTIMATE_DISABLE_MEMORY=true`

!!! tip
    Keep blocks concise and focused. A block titled "warehouse-config" with 5 bullet points is better than a wall of text. The agent can always call `altimate_memory_read` to fetch specific blocks on demand.

## Potential side effects and how to handle them

### Stale or incorrect memory

Memory blocks persist indefinitely. If your warehouse configuration changes or a convention is updated, the agent will continue using outdated information until the block is updated or deleted.

**How to detect:** If the agent makes assumptions that don't match your current setup (e.g., references an old warehouse name), check what's in memory:

```
> Show me all memory blocks

> Delete the warehouse-config block, it's outdated
```

**How to prevent:**

- Review memory blocks periodically — they're plain Markdown files you can inspect directly
- Ask the agent to "forget" outdated information when things change
- Keep blocks focused on stable facts rather than ephemeral details

### Wrong information getting saved

The agent decides what to save based on conversation context. It may occasionally save incorrect inferences or overly specific details that don't generalize well.

**How to detect:**

- After a session where the agent saved memory, review what was written:
  ```bash
  ls .opencode/memory/          # project memory
  cat .opencode/memory/*.md     # inspect all blocks
  ```
- The agent always reports when it creates or updates a memory block, so watch for `Memory: Created "..."` or `Memory: Updated "..."` messages in the session output

**How to fix:**

- Delete the bad block: ask the agent or run `rm .opencode/memory/bad-block.md`
- Edit the file directly — it's just Markdown
- Ask the agent to rewrite it: "Update the warehouse-config memory with the correct warehouse name"

### Context bloat

With 50 blocks at 2KB each, the theoretical maximum injection is ~100KB. In practice, the 8,000-character default budget caps injection at well under 10KB.

**Signs of context bloat:**

- Frequent auto-compaction (visible in the TUI)
- The agent losing track of your current task because memory is crowding out working context

**How to mitigate:**

- Keep the total block count low (10-20 active blocks is a sweet spot)
- Delete blocks you no longer need
- Use tags to categorize and let the agent filter to what's relevant
- Reduce the injection budget if needed

### Security considerations

Memory blocks are stored as plaintext files on disk. Be mindful of what gets saved:

- **Do not** save credentials, API keys, or connection strings in memory blocks
- **Do** save structural information (warehouse names, naming conventions, schema patterns)
- If using project-scoped memory in a shared repo, add `.opencode/memory/` to `.gitignore` to avoid committing sensitive context
- Memory blocks are scoped per-user (global) and per-project — there is no cross-user or cross-project leakage

!!! warning
    Memory blocks are not encrypted. Treat them like any other configuration file on your machine. Do not store secrets or PII in memory blocks.

## Examples

### Data engineering team setup

```
> Remember: we use Snowflake with warehouse COMPUTE_WH for dev and ANALYTICS_WH for prod.
  Our dbt project uses the staging/intermediate/marts pattern with stg_, int_, fct_, dim_ prefixes.
  Always use QUALIFY instead of subqueries for deduplication.

Memory: Created "team-conventions" in project scope
```

### Personal SQL preferences

```
> Remember globally: I prefer CTEs over subqueries, always use explicit column lists
  (no SELECT *), and format SQL with lowercase keywords.

Memory: Created "sql-preferences" in global scope
```

### Recalling past work

```
> What do you remember about our warehouse?

Memory: 2 block(s)
### warehouse-config (project) [snowflake]
...
### team-conventions (project) [dbt, conventions]
...
```
