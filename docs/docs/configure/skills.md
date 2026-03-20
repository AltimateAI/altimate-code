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

## CLI Commands

Manage skills from the command line:

```bash
# List all skills with their paired CLI tools
altimate-code skill list

# List as JSON (for scripting)
altimate-code skill list --json

# Scaffold a new skill + CLI tool pair
altimate-code skill create my-tool
altimate-code skill create my-tool --language python
altimate-code skill create my-tool --language node
altimate-code skill create my-tool --skill-only  # skill only, no CLI stub

# Validate a skill and its paired tool
altimate-code skill test my-tool
```

## Adding Custom Skills

The fastest way to create a custom skill is with the scaffolder:

```bash
altimate-code skill create freshness-check
```

This creates two files:

- `.opencode/skills/freshness-check/SKILL.md` — teaches the agent when and how to use your tool
- `.opencode/tools/freshness-check` — executable CLI tool stub

### Pairing Skills with CLI Tools

Skills become powerful when paired with CLI tools. Drop any executable into `.opencode/tools/` and it's automatically available on the agent's PATH:

```
.opencode/tools/           # Project-level tools (auto-discovered)
~/.config/altimate-code/tools/  # Global tools (shared across projects)
```

A skill references its paired CLI tool through bash code blocks:

```markdown
---
name: freshness-check
description: Check data freshness across tables
---

# Freshness Check

## CLI Reference
\`\`\`bash
freshness-check --table users --threshold 24h
freshness-check --all --report
\`\`\`

## Workflow
1. Ask the user which tables to check
2. Run `freshness-check` with appropriate flags
3. Interpret the output and suggest fixes
```

The tool can be written in any language (bash, Python, Node.js, etc.) — as long as it's executable.

### Skill-Only (No CLI Tool)

You can also create skills as plain prompt templates:

```markdown
---
name: cost-review
description: Review SQL queries for cost optimization
---

Analyze the SQL query for cost optimization opportunities.
Focus on: $ARGUMENTS
```

`$ARGUMENTS` is replaced with whatever the user types after the skill name (e.g., `/cost-review SELECT * FROM orders` passes `SELECT * FROM orders`).

### Skill Paths

Skills are loaded from these paths (highest priority first):

1. `.opencode/skills/` and `.altimate-code/skill/` (project)
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
