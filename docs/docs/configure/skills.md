# Agent Skills

Skills are reusable prompt templates that extend agent capabilities.

## Skill Format

Skills are markdown files named `SKILL.md`:

```markdown
---
name: cost-review
description: Review SQL queries for cost optimization
---

Analyze the SQL query for cost optimization opportunities:

1. Check for full table scans
2. Evaluate partition pruning
3. Suggest clustering keys
4. Estimate credit impact
5. Recommend cheaper alternatives

Focus on the query: $ARGUMENTS
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill name |
| `description` | Yes | Short description |

## Discovery Paths

Skills are loaded from these locations (in priority order):

1. **altimate-code directories** (project-scoped, highest priority):
    - `.altimate-code/skill/`
    - `.altimate-code/skills/`

2. **Global user directories**:
    - `~/.altimate-code/skills/`

3. **Custom paths** (from config):

    ```json
    {
      "skills": {
        "paths": ["./my-skills", "~/shared-skills"]
      }
    }
    ```

4. **External directories & remote URLs** (if not disabled):
    - `~/.claude/skills/`
    - `~/.agents/skills/`
    - `.claude/skills/` (project, searched up tree)
    - `.agents/skills/` (project, searched up tree)

    ```json
    {
      "skills": {
        "urls": ["https://example.com/skills-registry.json"]
      }
    }
    ```

## Built-in Data Engineering Skills

altimate ships with built-in skills for common data engineering tasks. Type `/` in the TUI to browse what's available and get autocomplete on skill names.

| Skill | Description |
|-------|-------------|
| `/sql-review` | SQL quality gate that lints 26 anti-patterns, validates syntax, and checks safety |
| `/sql-translate` | Cross-dialect SQL translation |
| `/schema-migration` | Schema migration planning and execution |
| `/pii-audit` | PII detection and compliance audits |
| `/cost-report` | Snowflake FinOps analysis |
| `/lineage-diff` | Column-level lineage comparison |
| `/query-optimize` | Query optimization suggestions |
| `/data-viz` | Interactive data visualization and dashboards |
| `/dbt-develop` | dbt model development and scaffolding |
| `/dbt-test` | dbt test generation |
| `/dbt-docs` | dbt documentation generation |
| `/dbt-analyze` | dbt project analysis |
| `/dbt-troubleshoot` | dbt issue diagnosis |
| `/teach` | Teach patterns from example files |
| `/train` | Learn standards from documents/style guides |
| `/training-status` | Dashboard of all learned knowledge |

## Adding Custom Skills

Add your own skills as Markdown files in `.altimate-code/skill/`:

```markdown
---
name: cost-review
description: Review SQL queries for cost optimization
---

Analyze the SQL query for cost optimization opportunities.
Focus on: $ARGUMENTS
```

`$ARGUMENTS` is replaced with whatever the user types after the skill name (e.g., `/cost-review SELECT * FROM orders` passes `SELECT * FROM orders`).

Skills are loaded from these paths (highest priority first):

1. `.altimate-code/skill/` (project)
2. `~/.altimate-code/skills/` (global)
3. Custom paths via config:

```json
{
  "skills": {
    "paths": ["./my-skills", "~/shared-skills"]
  }
}
```

### Remote Skills

Host skills at a URL and load them at startup:

```json
{
  "skills": {
    "urls": ["https://example.com/skills-registry.json"]
  }
}
```

## Disabling External Skills

```bash
export ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS=true
```

This disables skill discovery from `~/.claude/skills/` and `~/.agents/skills/` but keeps `.altimate-code/skill/` discovery active.

## Duplicate Handling

If multiple skills share the same name, project-level skills override global skills. A warning is logged when duplicates are found.
